# Metrika — Domain Model & Database Design

> Companion to [ARCHITECTURE.md](./ARCHITECTURE.md). Covers entities, relationships, the Prisma schema draft, indexing and constraint strategy, money, units, and every state machine.

---

## 1. The organising principle

Every entity in this system falls into exactly one of four categories, and the category determines its rules:

| Category        | Mutability              | Examples                                                                                                          | Rules                                                                                |
| --------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Identity**    | Mutable                 | `User`, `Organization`, `Project`, `Model`, `Material`, `PrinterProfile`                                          | Human-facing, renameable, soft-deletable. Never referenced by a quote                |
| **Version**     | Immutable after publish | `ModelVersion`, `PrintProfileVersion`, `PrinterProfileVersion`, `MaterialProfileVersion`, `PricingRuleSetVersion` | Content-hashed, append-only, archived not deleted. **This is what quotes reference** |
| **Computation** | Immutable               | `GeometryAnalysis`, `SliceResult`, `Quote` (once `READY`)                                                         | Derived from versioned inputs; regenerable but never edited                          |
| **Ledger**      | Append-only             | `StatusTransition`, `AuditLog`, `WebhookEvent`, `OutboxEvent`, `RepairLog`                                        | No updates, no deletes, ever                                                         |

If you are unsure where a new field belongs, ask which category the entity is in. A mutable field on a Version entity is a bug that silently breaks reproducibility.

### The versioning pattern

Every configurable, manufacturing-relevant thing follows one shape:

```prisma
model PrinterProfile {                    // Identity
  id            String   @id @default(uuid()) @db.Uuid
  name          String                    // "Bambu X1C — 0.4mm"
  slug          String   @unique
  isActive      Boolean  @default(true)
  versions      PrinterProfileVersion[]
  currentVersionId String? @db.Uuid       // pointer, for admin/UI convenience ONLY
  deletedAt     DateTime?
}

model PrinterProfileVersion {             // Version — immutable
  id            String   @id @default(uuid()) @db.Uuid
  profileId     String   @db.Uuid
  versionNumber Int
  contentHash   String   @db.Char(64)     // sha256 of canonical JSON of the payload
  status        VersionStatus             // DRAFT | PUBLISHED | ARCHIVED
  publishedAt   DateTime?
  archivedAt    DateTime?
  // ... the actual payload fields
  @@unique([profileId, versionNumber])
  @@unique([profileId, contentHash])
  @@index([profileId, status])
}
```

`currentVersionId` exists so an admin UI can show "the live profile" without a subquery. **Nothing in the quote chain may read it.** A quote resolves and stores a `PrinterProfileVersion.id` at creation time and never looks at the pointer again. This is the single most important discipline in the schema; it is worth a comment in the schema file itself.

`contentHash` makes republishing an identical configuration a no-op and gives the slice cache its key material for free.

---

## 2. Entity catalogue

### 2.1 Identity & tenancy

**`User`** — a person. `externalAuthId` + `authProvider` map to Clerk with a unique constraint; the primary key is ours. Holds `email` (unique, lowercased), `displayName`, `locale` (default `es-CO`), `timezone`, `deletedAt`.

**`Organization`** — the tenant boundary. Every user gets a **personal organization** on signup (`kind: PERSONAL | TEAM`), which removes the "resource with no organization" branch from every policy and every query. Holds `name`, `slug` (unique), `kind`, `countryCode`, `defaultCurrency`, `taxIdentifier` (NIT in Colombia — stored, never used in core logic), `billingAddressId`, `deletedAt`.

Two amendments from the migration that created the table ([ADR-0040](./adr/0040-tenant-context-gucs.md)). It also holds **`personalOwnerUserId`** — unique, nullable, restricted FK to `User` — because nothing else expresses "at most one personal organization per user", and a unique index on a nullable column is only half of that: Postgres treats NULLs as distinct, so the other half is the `Organization_personal_owner_required` CHECK (`kind <> 'PERSONAL' OR personalOwnerUserId IS NOT NULL`), hand-written because Prisma's DSL cannot express it. And `billingAddressId` is **not** in the schema: `Address` is not a Phase 1 table, and a nullable UUID with no referent is a fact nobody can check.

**`OrganizationMember`** — `(organizationId, userId)` unique, plus `role: OWNER | ADMIN | MEMBER | BILLING`, `invitedById`, `joinedAt`. An organization must always have at least one `OWNER`, enforced in application logic inside the transaction that removes a member (a database constraint cannot express it).

**`OrganizationInvitation`** — `email`, `role`, `token` (hashed, never stored plain), `expiresAt`, `acceptedAt`, `revokedAt`. Metrika owns this, not the auth provider.

**`PlatformRoleAssignment`** — internal staff. `userId`, `role: PLATFORM_ADMIN | OPERATIONS | MANUFACTURING_OPERATOR | FINANCE | SUPPORT`, `grantedById`, `grantedAt`, `revokedAt`. Deliberately a **separate table** from `OrganizationMember`, so an internal staff account can never be confused with a customer membership and so a platform role is impossible to grant by accident through the org-membership code path.

**`Project`** — an architect's job. `organizationId`, `name`, `description`, `clientReference` (their internal code), `createdById`, `archivedAt`, `deletedAt`.

### 2.2 Models & geometry

**`Model`** — the stable identity of a thing the customer thinks of as one object ("Casa Botero — main volume"). `projectId`, `name`, `currentVersionId` (pointer, UI only), `deletedAt`.

**`ModelVersion`** — an immutable revision: one uploaded file plus everything derived from it.

```
id, modelId, versionNumber, state (ModelVersionState)
sourceFileAssetId          → FileAsset (the original bytes)
declaredFormat             STL | OBJ | THREE_MF
detectedFormat             what magic-byte sniffing actually found
unitInterpretation         (see §4)
sourceBoundingBox*Mm       Decimal, populated after analysis, in canonical mm
uploadedById, uploadedAt
processingWorkflowId       Temporal workflow id, for support forensics
failureCode, failureDetail
```

`(modelId, versionNumber)` unique. Once `READY`, only `state` may change (to `FAILED` on a re-analysis, or archival) — every other field is frozen.

**`FileAsset`** — a single object in S3. `bucket`, `key`, `sizeBytes` (BigInt), `sha256` (Char(64)), `contentType`, `namespace` (enum matching the S3 prefix), `state: PENDING | UPLOADED | VERIFIED | QUARANTINED | DELETED`, `uploadedAt`, `verifiedAt`, `expiresAt`. Separated from `ModelVersion` because derivatives, G-code, invoices and quarantined uploads are all files with the same lifecycle needs.

**`UploadSession`** — `id`, `organizationId`, `modelVersionId`, `fileAssetId`, `strategy: SINGLE | MULTIPART`, `s3UploadId` (multipart), `declaredSizeBytes`, `declaredSha256`, `expiresAt`, `completedAt`, `abandonedAt`. The unique `id` is the idempotency key for completion.

**`ModelDerivative`** — anything generated from a `ModelVersion`.

```
id, modelVersionId, kind, fileAssetId, producerVersion, inputHash, createdAt
kind: PREVIEW_GLB | THUMBNAIL_PNG | REPAIRED_MESH | SLICE_INPUT_3MF | LOD_GLB
@@unique([modelVersionId, kind, producerVersion])
```

Generalising `ModelPreview` into `ModelDerivative` is worth it: previews, repaired meshes, LOD chains and slice inputs share identical lifecycle, storage and regeneration semantics. `producerVersion` (`"geometry-worker@1.4.2"`) means upgrading a worker regenerates derivatives without touching the immutable original, and old derivatives remain addressable for old quotes.

**`GeometryAnalysis`** — the result of analysing one `ModelVersion` with one analyzer version. `@@unique([modelVersionId, analyzerVersion])` is the idempotency guarantee.

Exact metrics get typed columns; heuristics do not. The split is structural, not stylistic:

```
── exact, queryable, contractually precise ──
triangleCount, vertexCount, connectedComponentCount    Int
isWatertight, isManifold, hasConsistentWinding         Boolean
volumeMm3, surfaceAreaMm2                              Decimal(20,6)
bboxMinXMm .. bboxMaxZMm                               Decimal(14,4)
obbExtentXMm, obbExtentYMm, obbExtentZMm, obbRotation  Decimal / Json  (oriented bbox)
centerOfMassXMm, centerOfMassYMm, centerOfMassZMm      Decimal(14,4)
degenerateFaceCount, duplicateFaceCount, boundaryEdgeCount, nonManifoldEdgeCount  Int

── heuristic, evolving, never filtered on ──
heuristics  Json
```

`heuristics` payload shape (versioned by `analyzerVersion`):

```jsonc
{
  "minWallThicknessMm": { "value": 0.62, "method": "ray-cast-sampling@2", "confidence": "MEDIUM", "sampleCount": 20000 },
  "overhangAreaMm2":    { "value": 1840.2, "method": "normal-threshold-45deg@1", "confidence": "HIGH" },
  "fragileRegions":     { "value": [{ "centroidMm": [..], "estimatedThicknessMm": 0.3 }], "method": "...", "confidence": "LOW" },
  "printabilityScore":  { "value": 0.78, "method": "weighted-composite@3", "confidence": "LOW" }
}
```

Every heuristic carries `method`, `confidence` and enough provenance to explain itself. **The UI renders exact and heuristic results with different language and different visual weight.** "This model is not watertight" is a fact. "We estimate the thinnest wall is around 0.6 mm" is not the same kind of statement and must not look like one.

**`GeometryIssue`** — one row per detected problem.

```
id, analysisId, code (enum), severity: BLOCKER | WARNING | INFO,
certainty: EXACT | HEURISTIC, occurrenceCount Int, detail Json
```

`detail` carries sample face/edge indices, which the viewer uses to build a highlight mesh. `certainty` is what stops a heuristic warning from reading like a hard failure. Codes: `NON_MANIFOLD_EDGES`, `BOUNDARY_HOLES`, `DEGENERATE_FACES`, `DUPLICATE_FACES`, `INCONSISTENT_WINDING`, `SELF_INTERSECTION`, `DISCONNECTED_COMPONENTS`, `THIN_WALLS`, `LARGE_OVERHANGS`, `EXCEEDS_BUILD_VOLUME`, `IMPLAUSIBLE_SCALE`, `ZERO_VOLUME`.

**`RepairLog`** — append-only record of every modification made to customer geometry.

```
id, modelVersionId, derivativeId, repairAlgorithmVersion,
operation (enum), parametersJson, beforeMetricsJson, afterMetricsJson,
appliedAt, approvedByUserId?   // null for conservative auto-repairs
```

Operations: `WELD_VERTICES`, `REMOVE_DEGENERATE_FACES`, `REMOVE_DUPLICATE_FACES`, `FIX_WINDING`, `RECOMPUTE_NORMALS` (all conservative, automatic); `FILL_HOLES`, `MANIFOLD_RECONSTRUCT`, `REMOVE_SMALL_COMPONENTS` (destructive, require `approvedByUserId`). The `NOT NULL` requirement on `approvedByUserId` for destructive operations is enforced by a **check constraint**, not application code — rule §105.9 deserves a database guarantee.

### 2.3 Manufacturing configuration

**`PrintTechnology`** — enum: `FDM`, `SLA`, `SLS` (only `FDM` at MVP). A first-class axis, not an assumption, because resin changes the geometry checks (drain holes, cupping), the support model and the slicer entirely.

**`Material`** (identity) + **`MaterialProfileVersion`** (version). The split the brief asks for, between technical and commercial properties, is here:

```
Material:              name, code, technology, supplierName, isActive
MaterialProfileVersion:
  ── technical ──
  densityGCm3 Decimal(8,4), nozzleTempC, bedTempC,
  minLayerHeightMm, maxLayerHeightMm, shrinkageFactor Decimal(8,6)
  ── commercial ──
  purchaseCostMinorPerKg BigInt, currency, wasteFactor Decimal(6,4),
  markupFactor Decimal(6,4), minimumChargeMinor BigInt
  ── availability ──
  isAvailable, leadTimeDays, spoolWeightG
```

Both live on the same version row because a quote must snapshot both together — a price computed with old commercial terms and new technical properties would be neither reproducible nor correct. `MaterialColor` is a separate small table (`materialId`, `name`, `hex`, `isAvailable`) because colour availability changes far more often than a material profile and should not force a new version.

**`PrinterProfile`** (identity) + **`PrinterProfileVersion`** (version):

```
technology, buildVolumeXMm/YMm/ZMm Decimal, clearanceMarginMm Decimal,
nozzleDiameterMm, maxLayerHeightMm, minLayerHeightMm,
supportsSolubleSupport Boolean, chamberHeated Boolean,
── cost inputs, snapshotted into pricing ──
hourlyMachineCostMinor BigInt, currency,
depreciationPerHourMinor BigInt, powerDrawW Int,
setupMinutes Int, failureRateEstimate Decimal(6,4),
── the actual slicer configuration ──
slicerProfileKey String, slicerProfilePayload Json
```

`slicerProfilePayload` is the full OrcaSlicer profile content — machine, process and filament — as structured JSON, stored on the version so a slice is reproducible even if the profile repository changes.

**`PrintProfile`** (identity) + **`PrintProfileVersion`** — the customer-facing quality preset ("Borrador", "Estándar", "Alta definición", "Maqueta fina"). Maps a friendly name to layer height, perimeters, top/bottom layers, infill density and pattern, support strategy. **Customers select a `PrintProfile`; they never see raw slicer parameters.** Advanced parameters are internal and admin-editable.

**`PrinterProfileMaterialCompatibility`** — join table `(printerProfileVersionId, materialProfileVersionId)` with `isRecommended`. Compatibility is version-scoped because a printer firmware or hardware revision genuinely changes what it can run.

**`PrintConfiguration`** — the immutable, content-hashed bundle of everything the customer chose. This is the entity the slice cache and the quote both key on.

```
id, modelVersionId,
printProfileVersionId, printerProfileVersionId, materialProfileVersionId, materialColorId,
scaleSpec        Json    // discriminated union, see §5
orientation      Json    // quaternion or named preset
supportStrategy  enum    NONE | AUTO | AUTO_WITH_BRIM | MANUAL
overrides        Json    // narrow, validated, admin-permitted overrides only
quantity         Int
contentHash      String @db.Char(64)
createdAt
@@unique([modelVersionId, contentHash])
```

The unique constraint means reconfiguring to an identical setup reuses the row, which means the slice cache hits, which means a customer flipping between two options does not pay for slicing twice.

### 2.4 Slicing

**`SliceJob`**

```
id, printConfigurationId, sliceInputDerivativeId,
slicerEngine   enum ORCA_SLICER | CURA_ENGINE | FAKE
slicerVersion  String        // "2.8.1+build-abc123" — image digest derived
cacheKey       String @db.Char(64)  @unique   ← the whole idempotency story
state          SliceJobState
queuedAt, startedAt, finishedAt, workerId, attempts
failureCode, failureDetail
```

`cacheKey` = SHA-256 over the canonical JSON serialisation of:

```
{ sliceInputSha256, scaleSpec, orientation, supportStrategy, overrides,
  printProfileVersionHash, printerProfileVersionHash, materialProfileVersionHash,
  slicerEngine, slicerVersion, cacheKeySchemaVersion }
```

`cacheKeySchemaVersion` is included so that discovering a missing input (a bug) can be fixed by bumping it, invalidating the whole cache safely rather than silently reusing stale results. Canonical serialisation means sorted keys, no whitespace, and fixed decimal precision — specified once in `packages/contracts/src/hashing.ts` and property-tested for stability.

**`SliceResult`** — 1:1 with `SliceJob`, immutable.

```
sliceJobId (unique), gcodeFileAssetId,
filamentVolumeMm3 Decimal(18,6), filamentMassG Decimal(14,4),
supportVolumeMm3 Decimal(18,6),  supportMassG Decimal(14,4),
estimatedPrintSeconds Int, layerCount Int, maxLayerHeightUsedMm Decimal,
estimatedFilamentLengthMm Decimal, firstLayerAdhesionAreaMm2 Decimal?,
rawSlicerMetrics Json      // everything the slicer emitted, unparsed, for forensics
```

`rawSlicerMetrics` is the escape hatch: when a pricing dispute arises in eighteen months, the raw slicer output is there.

### 2.5 Commerce

**`PricingRuleSet`** (identity) + **`PricingRuleSetVersion`** (version):

```
PricingRuleSetVersion:
  ruleSetId, versionNumber, contentHash, status (DRAFT|PUBLISHED|ARCHIVED),
  effectiveFrom, effectiveTo, publishedByUserId, publishedAt,
  currency String @db.Char(3), currencyExponent Int, roundingPolicy Json,
  components Json,        // the ordered PricingComponent[] — see PRICING_ENGINE.md
  engineSchemaVersion Int  // which pricing-engine schema this payload conforms to
```

`engineSchemaVersion` lets the engine refuse to evaluate a rule set it does not understand, rather than silently mis-evaluating it.

**`TaxConfiguration`** — `countryCode`, `regionCode?`, `taxCode` ("IVA"), `ratePercent Decimal(7,4)`, `appliesTo: SERVICE | GOODS | BOTH`, `isInclusive Boolean`, `validFrom`, `validTo`. Colombian IVA is a row. There is no `if (country === 'CO')` anywhere in the pricing kernel.

**`Quote`** — the immutable commercial snapshot.

```
id, organizationId, projectId, createdByUserId,
state QuoteState, quoteNumber (human-readable, sequential per org),
pricingRuleSetVersionId, taxConfigurationId,
currency Char(3), currencyExponent Int,
subtotalMinor BigInt, taxMinor BigInt, totalMinor BigInt,
trace Json,              // full pricing trace, see PRICING_ENGINE.md
evaluatedAt, expiresAt, acceptedAt, acceptedByUserId,
supersededByQuoteId?, failureCode?
```

**`QuoteItem`** — one line, one configured part.

```
quoteId, modelVersionId, geometryAnalysisId, printConfigurationId, sliceResultId,
quantity, unitPriceMinor BigInt, lineTotalMinor BigInt, lineTrace Json
```

`QuoteItem` existing from day one — with `quantity` and the ability to hold N items — is what makes multi-part orders and future segmentation a feature rather than a schema migration. At MVP every quote has exactly one item; the model does not know that.

**`Order`** — commercial. `quoteId` **unique** (one quote produces at most one order — the idempotency guarantee for order creation), `organizationId`, `orderNumber`, `state`, `currency`, `currencyExponent`, `subtotalMinor`, `taxMinor`, `shippingMinor`, `totalMinor`, `shippingAddressId`, `billingAddressId`, `placedAt`, `cancelledAt`, `cancellationReason`.

**`OrderItem`** — a **denormalised snapshot** of the `QuoteItem` at acceptance. It duplicates the price and configuration references deliberately: the order must remain readable and correct even if the quote chain is later archived, and denormalisation here is a durability guarantee, not an optimisation.

**`Payment`** — `orderId`, `provider`, `providerPaymentId` (unique per provider), `state`, `amountMinor`, `currency`, `method` (`CARD | PSE | NEQUI | BANK_TRANSFER | CASH`), `providerPayload Json`, `authorizedAt`, `capturedAt`, `failedAt`, `failureCode`.

**`Refund`** — a **separate entity**, not a payment status. `paymentId`, `amountMinor`, `reason`, `state`, `providerRefundId`, `requestedByUserId`, `processedAt`. Two partial refunds of different amounts cannot be represented as a status on `Payment`; this is a correction to the original state list.

**`WebhookEvent`** — `provider`, `providerEventId`, `@@unique([provider, providerEventId])`, `eventType`, `payload Json`, `signatureVerified Boolean`, `receivedAt`, `processedAt`, `processingAttempts`, `failureDetail`. The unique constraint _is_ webhook idempotency.

### 2.6 Manufacturing

**`ManufacturingJob`** — operational, one per `OrderItem` (or per part once segmentation exists).

```
orderItemId, state ManufacturingJobState, priority Int,
assignedPrinterProfileVersionId, assignedOperatorUserId?,
plannedStartAt, startedAt, completedAt,
estimatedPrintSeconds, estimatedMassG,     // copied from SliceResult at creation
actualPrintSeconds?, actualMassG?,          // ← the calibration loop
reprintOfJobId?, failureCode?, notes
```

`actualPrintSeconds` and `actualMassG` are the architecture's answer to the highest-probability commercial risk in this business: estimates drifting from reality and quietly eroding margin. A scheduled job compares actuals to estimates grouped by `printerProfileVersionId` and `materialProfileVersionId`, and alerts when the median deviation crosses a threshold. Without these two columns from Phase 11, that loop cannot exist.

**`PrintJob`** — a single machine execution attempt. `manufacturingJobId`, `printerId?`, `attemptNumber`, `state`, `gcodeFileAssetId`, `dispatchedAt`, `startedAt`, `finishedAt`, `failureCode`, `driverPayload Json`. Multiple attempts per manufacturing job model reprints naturally.

**`Printer`** — a physical machine. `[TODO: Printer Infrastructure]` — the table exists from Phase 11 so operators can track which machine ran what, but `driverKind` is `MANUAL` until Phase 14. `name`, `serialNumber`, `printerProfileVersionId`, `location`, `driverKind` (`MANUAL | OCTOPRINT | KLIPPER | PRUSA_CONNECT | BAMBU`), `driverConfig Json`, `state`, `lastSeenAt`.

### 2.7 Cross-cutting

**`StatusTransition`** — append-only, one row per state change of any entity. `entityType`, `entityId`, `fromState`, `toState`, `event`, `actorType` (`USER | SYSTEM | WORKFLOW | ADMIN`), `actorId?`, `reason?`, `metadata Json`, `occurredAt`. Written in the same transaction as the entity update, always.

**`AuditLog`** — append-only, for the actions §63 names. `organizationId?`, `actorUserId?`, `actorType`, `action`, `resourceType`, `resourceId`, `before Json?`, `after Json?`, `ipAddress`, `userAgent`, `requestId`, `occurredAt`. Distinct from `StatusTransition`: transitions record _what the system did_, audit records _who did something consequential_. Both exist because they answer different questions.

**`OutboxEvent`** — `id`, `aggregateType`, `aggregateId`, `eventType`, `eventVersion`, `payload Json`, `createdAt`, `processedAt?`, `attempts`, `lastError?`. Partial index on `WHERE processedAt IS NULL` keeps the poller's query trivial regardless of table size.

**`Notification`** — `userId`, `organizationId`, `channel` (`EMAIL | IN_APP | WHATSAPP | SMS`), `templateKey`, `locale`, `payload Json`, `state`, `sentAt`, `readAt`, `providerMessageId`, `failureDetail`.

**`Address`** — `organizationId`, `kind` (`SHIPPING | BILLING`), `recipientName`, `line1`, `line2`, `city`, `region`, `postalCode`, `countryCode`, `phone`. Deliberately loose: address formats vary by country, and a rigid Colombian schema would be an internationalisation trap.

**`Shipment`** (V1) — `orderId`, `carrier`, `trackingNumber`, `state`, `shippedAt`, `deliveredAt`, `labelFileAssetId`.

**`FeatureFlag`** — `key`, `description`, `defaultEnabled`, plus `FeatureFlagOverride(flagKey, organizationId?, userId?, enabled)`. A small database-backed flag system rather than environment variables scattered through the code (§64) and rather than a paid vendor at this stage.

### Entities deliberately not created

- **`PricingRule`** as a separate table — rules live as a JSON array on `PricingRuleSetVersion`. They are only ever read as a complete set, never queried individually, and normalising them would make atomic versioning harder for no benefit.
- **`ModelPreview`** — subsumed by `ModelDerivative`.
- **`Currency`** as a table — a static registry in `packages/contracts` (code, exponent, symbol, display rules). Currencies change on a timescale of decades, and a table invites someone to add one at runtime without the formatting code to support it.
- **`QuoteRevision`** — superseding is modelled by `Quote.supersededByQuoteId`, which is simpler and keeps every revision independently addressable.
- **`Session`** — Clerk owns sessions.

---

## 3. Money

```ts
// packages/contracts/src/money.ts
export const Money = z.object({
  amountMinor: z.string().regex(/^-?\d+$/),   // serialised as string; bigint in memory
  currency: CurrencyCode,                      // 'COP' | 'USD' | ...
  exponent: z.number().int().min(0).max(4),
});
```

Rules, all non-negotiable:

1. **`BigInt` minor units in the database, `bigint` in TypeScript, decimal strings on the wire.** JSON has no integer type wide enough to trust and `number` loses precision above 2^53. A COP total of 12,450,000,000 minor units is well inside `bigint` and outside safe `number` territory once you multiply.
2. **The exponent travels with the amount.** COP is defined by ISO 4217 with two minor units, but Colombian commerce operates in whole pesos. Storing "minor units" without an explicit exponent guarantees that someone eventually renders 350000 as $3,500.00 instead of $350,000. Every money-bearing row stores `currencyExponent`; every `Money` object carries it.
3. **Rounding is a policy, versioned on the rule set**, not a code constant:

```jsonc
"roundingPolicy": {
  "lineMode": "HALF_UP", "lineExponent": 0,
  "totalMode": "HALF_UP", "totalExponent": 0,
  "totalRoundToNearestMinor": 5000    // round COP totals to the nearest 50 pesos
}
```

4. **Arithmetic happens in `Decimal` at full precision and rounds exactly twice** — once per displayed line, once on the total. Because `sum(round(lines)) ≠ round(sum(lines))`, **the total is authoritative** and the trace carries an explicit `ROUNDING_ADJUSTMENT` line reconciling the displayed lines to it. This is stated in the schema, in the pricing engine, and in the UI, because it is the kind of discrepancy that generates support tickets forever if it is left implicit.
5. **No `Float`, no `number`, no `@db.DoublePrecision` for money.** A lint rule (`no-restricted-syntax`) flags any Prisma field whose name matches `/Minor$|Cost$|Price$|Total$|Amount$/` that is not `BigInt`.

Display uses `Intl.NumberFormat` fed the exponent explicitly:

```ts
formatMoney({ amountMinor: 350000n, currency: 'COP', exponent: 0 })  // "$ 350.000"
```

---

## 4. Units

Canonical internal units: **millimetres, square millimetres, cubic millimetres, grams, seconds**, and money in minor units. Everything is converted at the boundary and never re-converted.

Two layers of defence:

**Naming is mandatory.** Every numeric field, column, variable and contract property carries its unit as a suffix: `lengthMm`, `volumeMm3`, `massG`, `durationS`, `costMinor`. A lint rule flags physical-quantity fields without a recognised suffix. This alone prevents most unit bugs and costs nothing.

**Branding for the five quantities that flow into money.** `Millimeters`, `CubicMillimeters`, `Grams`, `Seconds`, `MinorUnits` are branded via Zod. They are _not_ applied to every number in the system — full unit branding requires a units algebra (`add`, `mul`, `div` helpers for every pair), which is real friction for real but modest benefit. Branding is applied where a mix-up becomes a wrong price:

```ts
export const Grams = z.number().nonnegative().brand<'Grams'>();
export type Grams = z.infer<typeof Grams>;

// pricing-engine input — a plain number will not type-check here
export interface SliceMetrics {
  readonly filamentMassG: Grams;
  readonly supportMassG: Grams;
  readonly printDurationS: Seconds;
}
```

Branded IDs follow the same pattern for every entity. Conversion from database strings happens at exactly one place:

```ts
// apps/api/src/infrastructure/persistence/branding.ts — importable ONLY from this directory
export function brandUnsafe<T extends string>(value: string): T { return value as T; }
```

Parsing every ID out of the database with Zod would be wasteful; a single, lint-restricted, named assertion in the mapping layer is the honest trade. It is named `brandUnsafe` so nobody reaches for it casually.

### The STL unit problem

STL and OBJ do not reliably encode units. 3MF does. This is the highest-consequence correctness risk in the product: an architect exports in metres, Metrika assumes millimetres, and the quote is wrong by 10^9 in volume.

`ModelVersion.unitInterpretation` is a first-class JSONB value:

```jsonc
{
  "unit": "MM",
  "source": "USER_CONFIRMED",          // FILE_DECLARED | INFERRED | USER_CONFIRMED
  "confidence": "CERTAIN",             // CERTAIN | LIKELY | AMBIGUOUS
  "inferenceEvidence": {
    "rawBoundingBox": [184.2, 127.4, 72.1],
    "candidates": [
      { "unit": "MM",  "impliedRealSizeM": 0.184, "plausibility": 0.35 },
      { "unit": "M",   "impliedRealSizeM": 184.2, "plausibility": 0.55 },
      { "unit": "CM",  "impliedRealSizeM": 1.84,  "plausibility": 0.10 }
    ]
  },
  "confirmedByUserId": "...", "confirmedAt": "..."
}
```

Rules:

- 3MF declares its unit → `source: FILE_DECLARED`, `confidence: CERTAIN`. Trust it.
- STL/OBJ → run inference, then classify. If a single candidate is dominant _and_ the implied real-world size is plausible for an architectural model, mark `LIKELY` and proceed while surfacing it prominently in the UI. Otherwise mark `AMBIGUOUS`.
- **`AMBIGUOUS` blocks quoting.** The `ModelVersion` enters `AWAITING_UNIT_CONFIRMATION` and the workflow waits on a `confirmUnits` signal (7-day timeout). No price is ever computed from an unconfirmed ambiguous unit.
- **Plausibility bounds are hard**: reject outright any interpretation implying a printed dimension below 0.1 mm or a real-world dimension above 1 km, as `IMPLAUSIBLE_SCALE`.
- The inference heuristic is labelled a heuristic everywhere it appears.

---

## 5. Scale — the architectural differentiator

```ts
export const ScaleSpec = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('RATIO'), denominator: z.number().int().positive() }),      // 1:100
  z.object({ kind: z.literal('ABSOLUTE_FACTOR'), factor: DecimalString }),
  z.object({ kind: z.literal('TARGET_LONGEST_EDGE'), lengthMm: Millimeters }),
  z.object({ kind: z.literal('TARGET_BBOX'), xMm: Millimeters, yMm: Millimeters, zMm: Millimeters }),
]);
```

`TARGET_BBOX` must preserve aspect ratio — non-uniform scaling of an architectural model is almost always an error, so it is rejected with `INVALID_PRINT_CONFIGURATION` rather than silently distorting the building.

The fit check is a pure function evaluated against the printer profile version:

```ts
type FitResult =
  | { kind: 'FITS'; printerProfileVersionId: PrinterProfileVersionId; marginMm: Millimeters }
  | { kind: 'FITS_ROTATED'; rotation: Orientation; marginMm: Millimeters }
  | { kind: 'REQUIRES_SEGMENTATION'; overflowMm: Vec3Mm; suggestedPartCount: number }  // V2
  | { kind: 'EXCEEDS_ALL_PRINTERS'; largestAvailableMm: Vec3Mm };
```

Worked example, which is exactly what the UI shows:

```
Source model            18.4 m × 12.7 m × 7.2 m       (unit: M, user-confirmed)
Scale                   1 : 100
Printed dimensions      184.0 mm × 127.0 mm × 72.0 mm
Printer                 Bambu X1C (256 × 256 × 256 mm, 5 mm clearance)
Fit                     ✓ fits — 61.0 mm margin on the longest axis
```

Scale is stored on `PrintConfiguration`, participates in the content hash, and therefore in the slice cache key. Re-scaling produces a genuinely different slice and a genuinely different price — never a silently reused one.

---

## 6. Prisma schema design

### Conventions

| Concern             | Decision                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| Primary keys        | UUID v7 where available (time-sortable, index-friendly), `@db.Uuid`                                          |
| Timestamps          | `createdAt DateTime @default(now())`, `updatedAt DateTime @updatedAt`, both `@db.Timestamptz(3)`, always UTC |
| Enums               | Postgres enums via Prisma `enum`. Adding a value is additive and safe; removing one requires expand/contract |
| Money               | `BigInt` + `String @db.Char(3)` currency + `Int` exponent                                                    |
| Physical quantities | `Decimal @db.Decimal(p,s)` with declared precision                                                           |
| Hashes              | `String @db.Char(64)`                                                                                        |
| Soft delete         | `deletedAt DateTime?` on Identity entities only                                                              |
| JSONB               | `Json @db.JsonB` — never `Json` (text)                                                                       |

### Cascade behaviour — deliberate, per relation

```
Organization → OrganizationMember  onDelete: Restrict   // who was in a tenant, and when, is forensic
User         → OrganizationMember  onDelete: Restrict
User         → Organization        onDelete: Restrict   // personalOwnerUserId
Organization → Project             onDelete: Restrict   // never cascade a tenant away
Project      → Model               onDelete: Restrict
Model        → ModelVersion        onDelete: Restrict
ModelVersion → ModelDerivative     onDelete: Cascade    // derivatives are regenerable
ModelVersion → GeometryAnalysis    onDelete: Cascade
Analysis     → GeometryIssue       onDelete: Cascade
SliceJob     → SliceResult         onDelete: Restrict   // commercial evidence
Quote        → QuoteItem           onDelete: Cascade    // an item without its quote is meaningless
Order        → OrderItem           onDelete: Restrict
Order        → Payment             onDelete: Restrict
```

The rule: **cascade only where the child is regenerable or meaningless alone; restrict everywhere a record is commercial or forensic evidence.** Deleting an organization is a multi-step archival workflow, never a `DELETE`.

### Soft deletion — where and why not

Soft delete applies to `User`, `Organization`, `Project`, `Model` — entities a customer can "delete" and might need recovered, and whose disappearance would orphan history.

It explicitly does **not** apply to `Quote`, `Order`, `SliceResult`, `GeometryAnalysis`, `AuditLog`, `StatusTransition`, `Payment`. Those are immutable or ledger entities; they are archived by state, never deleted. A soft-delete flag on an immutable record invites someone to hide commercial evidence.

Soft delete is applied by a Prisma client extension that injects `deletedAt: null` into every `find`/`count` on the affected models, plus an explicit `withDeleted()` escape hatch for admin queries. Doing it in an extension rather than by convention means it cannot be forgotten — which matters more than usual when an agent is writing the queries. `delete` and `deleteMany` do not filter, they **throw**: a hard delete of a soft-deletable model is refused, not silently rewritten.

Two properties of that extension are decisions rather than gaps, recorded in [ADR-0040](./adr/0040-tenant-context-gucs.md) and repeated here because they bite at the schema level:

- **`update`, `updateMany` and `upsert` are not filtered, and that is how restore is expressed** — `update({ data: { deletedAt: null } })` needs no escape hatch. The cost is that an `upsert` on a soft-deleted row finds it, takes the `update` branch, and leaves `deletedAt` set unless the payload clears it: the call returns a row that the next `findUnique` cannot see. Do not use `upsert` on a soft-deletable model in a provisioning path.
- **Unique constraints on soft-deletable models are total, not partial.** A soft-deleted `Organization` permanently occupies its slug and a soft-deleted `User` permanently occupies their email. Since `findUnique`, `findFirst` and `count` **are** filtered, a create-then-re-read provisioning path raises the unique violation on every attempt while its re-read branch reads `null` on every attempt — a retry that never terminates, reporting an error pointing at a row the extension has hidden. The re-read must run inside `withDeleted()` and treat "a soft-deleted row occupies this identifier" as its own loud failure rather than as a lost race. Partial unique indexes (`WHERE "deletedAt" IS NULL`) are the eventual fix and are deliberately deferred; Prisma's DSL cannot express them.

### JSONB policy

**Use JSONB when** the payload is open-ended, evolves with a producer version, and is never filtered or sorted on: `GeometryAnalysis.heuristics`, `Quote.trace`, `SliceResult.rawSlicerMetrics`, `PricingRuleSetVersion.components`, `OutboxEvent.payload`, `RepairLog.parametersJson`, `PrinterProfileVersion.slicerProfilePayload`, `PrintConfiguration.scaleSpec`.

**Use columns when** the value is queried, aggregated, sorted, constrained, or contractually exact: every exact geometry metric, every money field, every state, every foreign key, every timestamp.

**Never use JSONB for**: anything a `WHERE` clause will touch regularly, anything with a foreign-key relationship, anything money. The temptation is `PrintConfiguration.overrides` — kept as JSONB but with a Zod schema validated at write time and a narrow allowed key set, because it is genuinely open-ended and only ever read as a whole.

Every JSONB payload has a Zod schema in `packages/contracts` and is parsed on read. JSONB is not an excuse for untyped data (§105.16) — it is a storage choice, not a typing choice.

### Indexes

| Index                                                                      | Purpose                                                                                      |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `(organizationId, createdAt DESC)` on `Project`, `Model`, `Quote`, `Order` | Every tenant list view; supports cursor pagination directly                                  |
| `(projectId, createdAt DESC)` on `Model`                                   | Project detail                                                                               |
| `(modelId, versionNumber DESC)` unique on `ModelVersion`                   | Version list + next-version computation                                                      |
| `(modelVersionId, analyzerVersion)` unique on `GeometryAnalysis`           | Idempotency                                                                                  |
| `(modelVersionId, kind, producerVersion)` unique on `ModelDerivative`      | Idempotency + lookup                                                                         |
| `cacheKey` unique on `SliceJob`                                            | The slice cache; the single most valuable index in the schema                                |
| `(modelVersionId, contentHash)` unique on `PrintConfiguration`             | Configuration dedup                                                                          |
| `quoteId` unique on `Order`                                                | One quote → at most one order                                                                |
| `(provider, providerEventId)` unique on `WebhookEvent`                     | Webhook idempotency                                                                          |
| `(state) WHERE state = 'READY'` partial on `Quote`                         | Expiry sweeper stays fast as the table grows                                                 |
| `(processedAt) WHERE processedAt IS NULL` partial on `OutboxEvent`         | Poller query is O(unprocessed)                                                               |
| `(entityType, entityId, occurredAt DESC)` on `StatusTransition`            | Entity history                                                                               |
| `(organizationId, occurredAt DESC)` on `AuditLog`                          | Audit review                                                                                 |
| `(state, priority DESC, plannedStartAt)` on `ManufacturingJob`             | The operator's work queue                                                                    |
| GIN on `GeometryAnalysis.heuristics`                                       | **Only if** admin analytics actually query it — added when a query exists, not speculatively |

### Row-level security

**Every table in schema `public` has RLS enabled and forced, or is named in an exemption list with a reason** (`packages/database/test/rls-coverage.integration.test.ts`). Adding a table means adding a policy or arguing in that list; an omission is a failure, not a silence. Today the only exemptions are `HealthCheck` and Prisma's own `_prisma_migrations`.

The ordinary case is a table that carries `organizationId`:

```sql
ALTER TABLE "Project" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Project" FORCE ROW LEVEL SECURITY;
CREATE POLICY "Project_tenant_isolation" ON "Project"
  USING ("organizationId" = app_current_org_id())
  WITH CHECK ("organizationId" = app_current_org_id());
```

Four things in that shape are non-negotiable, and each replaces something the earlier draft of this section got wrong:

- **`FORCE`, not just `ENABLE`.** `ENABLE` alone exempts the table owner — which is the role `prisma migrate` runs as and the role a local psql session connects as — so without `FORCE` the policy is invisible to exactly the connection a developer uses to convince themselves RLS works. The local compose `metrika` role is additionally a bootstrap superuser and bypasses RLS regardless, so `pg_class.relforcerowsecurity` is the trustworthy check, never a psql probe against the local stack.
- **`WITH CHECK` as well as `USING`.** `USING` filters what a statement can see; `WITH CHECK` constrains what it can write. Without it a caller in org A can insert a row stamped with org B's id and then never see it again.
- **The function, not an inline `current_setting`.** `app_current_org_id()` is `STABLE` and returns NULL for an unset setting, so deny-by-default is a property of the primitive rather than of each policy that spells it out.
- **A named policy, per table.** A wrong predicate is corrected by `ALTER POLICY` or by a second named policy, never by dropping and recreating — `packages/database/test/migration-sql.test.ts` greps the whole migration history for the reopening statements.

**Not every tenant-scoped table has an `organizationId`, and the tenancy vocabulary is three primitives rather than one.** `Organization`'s predicate is on `id`; `User` has no organization at all, because a person belongs to many; and the read that turns a verified provider `sub` into a `User` row runs before either tenant is known, so it has a primitive of its own. `app.current_user_id` and the `app.current_auth_provider` + `app.current_external_auth_id` pair are read through their own functions with the same deny-by-default property. Two of the four Phase 1A policies are deliberately **asymmetric** — the read half widened to a caller's memberships, the write half not — and a policy expression that reads another RLS-protected table has that table's policies applied to it, which bounds the widening and makes a cycle a query-time `42P17`. [ADR-0040](./adr/0040-tenant-context-gucs.md) has every predicate, every reason, and the surprising consequence that a row's identifier must exist before its `INSERT`.

A Prisma client extension sets the tenancy GUCs at the start of every transaction from `AuthContext`. Platform-admin operations use a separate connection with a role that bypasses RLS and always writes an `AuditLog` row.

This is defence in depth, not the primary control — application-level policies remain. RLS is what catches the one query written at 2 a.m. that forgot its `where`.

---

## 7. State machines

Every machine is a declared transition table in `packages/contracts`, evaluated by one function, and exhaustively tested — including that every state is reachable and every terminal state has no outgoing transitions.

```ts
type Transition<S extends string, E extends string> = { from: S; event: E; to: S; guard?: string };

export const QUOTE_TRANSITIONS = [
  { from: 'DRAFT',       event: 'CALCULATION_STARTED', to: 'CALCULATING' },
  { from: 'CALCULATING', event: 'CALCULATION_SUCCEEDED', to: 'READY' },
  { from: 'CALCULATING', event: 'CALCULATION_FAILED',    to: 'FAILED' },
  { from: 'READY',       event: 'ACCEPTED',              to: 'ACCEPTED', guard: 'notExpired' },
  { from: 'READY',       event: 'EXPIRED',               to: 'EXPIRED' },
  { from: 'READY',       event: 'SUPERSEDED',            to: 'SUPERSEDED' },
  { from: 'FAILED',      event: 'RETRIED',               to: 'CALCULATING' },
] as const satisfies readonly Transition<QuoteState, QuoteEvent>[];
```

`transition()` validates against the table, applies guards, writes the entity update **and** a `StatusTransition` row **and** emits the domain event in one database transaction, then throws a typed `InvalidStateTransitionError` on anything illegal. There is no other way to change a state field; a lint rule forbids `state:` in any Prisma `update` outside the transition helper.

### ModelVersion

States: `CREATED → UPLOADING → UPLOADED → VALIDATING → {AWAITING_UNIT_CONFIRMATION | ANALYZING} → {AWAITING_REPAIR_APPROVAL} → GENERATING_PREVIEW → READY`, with `FAILED`, `REJECTED`, `EXPIRED` as off-ramps. `FAILED → VALIDATING` allows retry; `REJECTED` (hostile or unsupported file) is terminal.

Improvements over the proposed list: `AWAITING_UNIT_CONFIRMATION` and `AWAITING_REPAIR_APPROVAL` are explicit states rather than flags, because they are exactly the states where the system is waiting on a human and the UI must say so precisely.

### Quote

`DRAFT → CALCULATING → READY → {ACCEPTED | EXPIRED | SUPERSEDED}`, plus `FAILED`. Expiry is evaluated **lazily on read** (a `READY` quote past `expiresAt` reads as expired and cannot be accepted) **and** swept by a scheduled job that performs the transition and sends the notification. Lazy evaluation is the correctness guarantee; the sweeper is the user experience. Relying on the sweeper alone would leave a window where an expired quote is acceptable.

Changing configuration on a `READY` quote creates a **new quote** and marks the old one `SUPERSEDED` with `supersededByQuoteId` set. Quotes are never mutated after `READY`.

### Order (customer-facing only)

`DRAFT → AWAITING_PAYMENT → PAID → IN_PRODUCTION → READY_FOR_SHIPMENT → SHIPPED → DELIVERED`, plus `CANCELLED`, `REFUNDED`, `PARTIALLY_REFUNDED`, `FAILED`.

`PROCESSING`, `QUEUED_FOR_MANUFACTURING` and `QUALITY_CONTROL` from the original proposal are **removed from `Order`** — they are manufacturing states and live on `ManufacturingJob`. Putting operational detail on the commercial entity is precisely the coupling §36 warns against, and it would mean an internal process change forcing a customer-visible state change.

### ManufacturingJob (independent)

`PLANNED → QUEUED → IN_PROGRESS → POST_PROCESSING → QUALITY_CONTROL → COMPLETED`, plus `FAILED`, `CANCELLED`, and `FAILED → QUEUED` for a reprint (which creates a new `PrintJob` with an incremented `attemptNumber`).

`Order.state` is **derived** from its manufacturing jobs by an explicit projection function, not by direct coupling: all jobs `COMPLETED` → order becomes `READY_FOR_SHIPMENT`; any job `IN_PROGRESS` → `IN_PRODUCTION`. The projection is a pure function, unit-tested.

### PrintJob

`CREATED → DISPATCHED → PRINTING → {SUCCEEDED | FAILED | ABORTED}`. In MVP transitions are made by an operator in the admin UI; from Phase 14 the `PrinterDriver` drives them from telemetry. **The state machine does not change** when hardware arrives — only who calls `transition()`. That is the point of the abstraction.

### Payment

`PENDING → {REQUIRES_ACTION → } PROCESSING → {SUCCEEDED | FAILED | CANCELLED}`. Terminal at `SUCCEEDED`. Refunds are `Refund` rows, not payment states.

**Payment state and order state are not coupled.** `PaymentSucceeded` is an _event_ that the order state machine may consume; a failed payment does not automatically fail an order (the customer may retry with another method). This is §76 taken literally.

---

## 8. Transaction boundaries

| Operation                             | Atomic unit                                                                         | Notes                                                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Upload completion                     | `FileAsset` verify + `ModelVersion` transition + `StatusTransition` + `OutboxEvent` | One transaction; the workflow starts from the outbox after commit                                                      |
| Analysis persistence                  | `GeometryAnalysis` + `GeometryIssue[]` + `ModelDerivative[]` + transition + outbox  | One transaction, idempotent via the unique analyzer-version constraint                                                 |
| Quote generation                      | `SliceJob` + `SliceResult` + `Quote` + `QuoteItem[]` + transition                   | One transaction after the workflow returns; the slice cache lookup happens before it                                   |
| **Quote acceptance → order creation** | `Quote` → `ACCEPTED` + `Order` + `OrderItem[]` (snapshotted) + transitions + outbox | **The most important transaction in the system.** `Order.quoteId` unique means a double-click cannot create two orders |
| Payment webhook                       | `WebhookEvent` insert (unique constraint dedupes) + `Payment` transition + outbox   | Insert-first, process-after; a duplicate webhook fails the insert and returns 200                                      |
| Manufacturing job creation            | `ManufacturingJob[]` for every `OrderItem` + transitions                            | Triggered by `PaymentSucceeded` from the outbox                                                                        |

**External systems are never inside a database transaction.** Temporal is started from the outbox after commit; S3 writes happen in workers and are referenced by key afterwards; payment provider calls happen outside and are reconciled by webhook. There are no distributed transactions in this system — the outbox plus idempotent consumers is the entire mechanism, and it is sufficient because every consumer is idempotent by a database constraint.

---

## 9. Data retention

| Data                      | Retention                                                                                    | Mechanism                                             |
| ------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Original models           | Life of the account + 90 days, then Glacier IR; deleted 30 days after account deletion       | S3 lifecycle + deletion workflow                      |
| Preview derivatives       | Regenerable — 180 days after last access                                                     | S3 lifecycle                                          |
| Slice inputs / G-code     | 2 years (commercial evidence for a delivered order)                                          | S3 lifecycle                                          |
| Abandoned upload sessions | 7 days                                                                                       | Scheduled cleanup job + S3 lifecycle on `quarantine/` |
| Expired quotes            | Retained 2 years (pricing forensics), then archived                                          | Archival job                                          |
| Audit logs                | 7 years                                                                                      | Partitioned by month; never deleted before then       |
| `StatusTransition`        | 2 years, then archived to S3 as Parquet                                                      | Partitioned by month                                  |
| `WebhookEvent` payloads   | 1 year                                                                                       | Payload nulled, row retained for idempotency forever  |
| Deleted accounts          | Personal data purged in 30 days; anonymised commercial records retained for legal/accounting | Deletion workflow with a documented data map          |

Retaining the `WebhookEvent` row forever while nulling its payload matters: the idempotency guarantee must outlive the data-retention window, or a replayed old webhook could be processed twice.
