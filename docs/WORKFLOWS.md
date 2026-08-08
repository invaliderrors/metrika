# Metrika — Workflows, Events & Idempotency

> Temporal workflow architecture, the transactional outbox, the event model, idempotency guarantees and real-time progress.

---

## 1. Why Temporal

The pipelines here are multi-minute, multi-step, failure-prone, resumable, human-interruptible and must produce a commercially binding result. Written by hand, that means implementing retries, timeouts, heartbeats, cancellation, compensation, state persistence *and workflow versioning*. The last one is the hard part: changing the quote pipeline while quotes are in flight, without corrupting the in-flight ones.

Temporal provides all of it, and the workflow ID doubles as a free platform-level idempotency key.

**The honest cost:** a real learning investment, one more container locally, a monthly bill, and a class of bug (non-determinism) that is confusing the first time you meet it. The mitigation for the last one is mechanical — see §4.

**Temporal Cloud, never self-hosted.** Self-hosting means running frontend, history, matching and worker services plus a Cassandra or large Postgres cluster. That is a platform team's job. See [ADR-0006](./adr/0006-temporal.md).

---

## 2. Workflows

| Workflow | Workflow ID | Task queue | Typical duration |
|---|---|---|---|
| `ModelProcessingWorkflow` | `model-processing:{modelVersionId}` | `metrika-main` | 20 s – 10 min (or days, awaiting a human) |
| `QuoteWorkflow` | `quote:{quoteId}` | `metrika-main` | 15 s – 5 min |
| `OrderFulfillmentWorkflow` | `order:{orderId}` | `metrika-main` | days to weeks |
| `QuoteExpirySweeper` | scheduled | `metrika-main` | seconds |
| `EstimateCalibrationJob` | scheduled | `metrika-main` | minutes |
| `OrphanCleanupJob` | scheduled | `metrika-main` | minutes |

Workflow code runs in the TypeScript SDK inside `apps/api`'s worker process (a separate process from the HTTP server, same image). Activities that need Python — geometry and slicing — are dispatched to the Python workers via their own task queues.

### ModelProcessingWorkflow

```ts
export async function modelProcessingWorkflow(input: ModelProcessingInput): Promise<void> {
  const progress = defineProgress('UPLOADED');

  await act.validateFile(input);                              // format sniff, limits, archive guards
  const parsed = await act.parseModel(input);                 // routed by size to small/large queue

  let units = parsed.unitInterpretation;
  if (units.confidence === 'AMBIGUOUS') {
    progress.set('AWAITING_UNIT_CONFIRMATION');
    await act.persistAwaitingUnits(input, units);
    const confirmed = await condition(() => unitSignal !== undefined, '7 days');
    if (!confirmed) { await act.failModelVersion(input, 'UNITS_NOT_CONFIRMED'); return; }
    units = unitSignal!;
  }

  progress.set('ANALYZING');
  const analysis = await act.analyzeGeometry({ ...input, units });

  const repair = await act.conservativeRepair({ ...input, analysisId: analysis.id });

  if (repair.destructiveRepairsAvailable.length > 0) {
    progress.set('AWAITING_REPAIR_APPROVAL');
    const decision = await condition(() => repairSignal !== undefined, '7 days');
    if (decision && repairSignal!.approved) {
      await act.destructiveRepair({ ...input, operations: repairSignal!.operations, approvedBy: repairSignal!.userId });
    }
  }

  progress.set('GENERATING_PREVIEW');
  await Promise.all([act.generatePreview(input), act.generateSliceInput(input)]);

  await act.persistAnalysisAndComplete({ ...input, analysis, repair });   // one transaction → READY
}
```

Signals: `confirmUnits(UnitInterpretation)`, `approveDestructiveRepair(RepairDecision)`, `cancel()`.
Query: `getProgress(): ModelProcessingProgress`.

Note the shape of the human-in-the-loop steps: **a signal with a timeout, not a polling loop.** The workflow sleeps for free — Temporal is not holding a thread — and the seven-day timeout produces a clean, recoverable failure rather than an orphan.

### QuoteWorkflow

```ts
export async function quoteWorkflow(input: QuoteInput): Promise<void> {
  await act.validateConfiguration(input);                     // profile compatibility, override allowlist
  const fit = await act.checkFit(input);                      // BEFORE slicing — cheap rejection
  if (fit.kind === 'EXCEEDS_ALL_PRINTERS' || fit.kind === 'REQUIRES_SEGMENTATION') {
    await act.failQuote(input, 'DOES_NOT_FIT_BUILD_VOLUME', fit); return;
  }

  const cached = await act.lookupSliceCache(input.cacheKey);
  const slice = cached ?? await act.slice(input);             // Python worker, heartbeating

  await act.computeAndPersistQuote({ ...input, sliceResultId: slice.id });   // one transaction → READY
}
```

The fit check before slicing is deliberate: the most common configuration error (scaled too large) is caught for free rather than after two minutes of CPU.

### OrderFulfillmentWorkflow

Long-running, mostly waiting on signals. Awaits `paymentConfirmed`, creates manufacturing jobs, awaits operator progress signals, transitions the order via the projection function, and triggers notifications. From Phase 14, the manufacturing steps dispatch to `PrinterDriver` instead of waiting on operator signals — **the workflow shape does not change**, only who sends the signals.

---

## 3. Activities

| Activity | Runtime | Timeout | Heartbeat | Retry |
|---|---|---|---|---|
| `validateFile` | Python | 60 s | — | 3×, not on `MALICIOUS_ARCHIVE` |
| `parseModel` | Python | 300 s | 10 s | 2×, not on parse errors |
| `analyzeGeometry` | Python | 600 s | 10 s | 2×, infrastructure only |
| `conservativeRepair` | Python | 300 s | 10 s | 2× |
| `generatePreview` | Python | 300 s | 10 s | 3× |
| `slice` | Python | 900 s | 10 s | 2×, infrastructure only |
| `persist*` | TypeScript | 30 s | — | 5×, idempotent by constraint |
| `sendNotification` | TypeScript | 30 s | — | 5× |

**Non-retryable error types are declared explicitly** on every activity. A deterministic failure — a malformed mesh, a rejected profile, a hostile archive — must not be retried. Retrying deterministic failures wastes CPU, delays the customer's answer and, on Spot capacity, costs real money.

Activities that write to the database are idempotent by a unique constraint ([DOMAIN_MODEL.md](./DOMAIN_MODEL.md#8-transaction-boundaries)), so a retry after a partial failure is always safe.

---

## 4. Determinism — enforced mechanically

Non-determinism inside workflow code is the failure mode most likely to bite, and it fails in a way that is hard to read: a replay diverges and the workflow gets stuck. So it is caught by lint, not by discipline.

`packages/eslint-config` defines a `workflows` profile applied to `apps/api/src/workflows/**`:

```js
'no-restricted-globals': ['error', 'Date', 'Math', 'crypto', 'process'],
'no-restricted-imports': ['error', { patterns: [
  '@prisma/client', '**/infrastructure/**', 'node:*', 'axios', '@aws-sdk/*',
]}],
'no-restricted-syntax': ['error',
  { selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']", message: 'Use workflow.now()' },
  { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: 'Use workflow.now()' },
],
```

Everything non-deterministic — time, randomness, UUIDs, I/O — either comes from the Temporal SDK (`workflow.now()`, `uuid4()`) or happens inside an activity. There is no third option.

### Versioning

```ts
if (patched('quote-v2-fit-check-before-slice')) {
  const fit = await act.checkFit(input);
  // ...
}
```

Policy: a `patched()` call may live at most two releases before it is resolved with `deprecatePatch()` and then removed. A CI check greps for patch markers and fails when one exceeds its age, because accumulated patches are how workflow code becomes unreadable.

A breaking change that cannot be patched gets a **new workflow type name** (`quoteWorkflowV2`); the old one drains naturally.

---

## 5. The transactional outbox

The problem: an HTTP request commits a database change **and** must start a workflow. Starting the workflow inside the transaction risks an orphan workflow if the transaction rolls back. Starting it after commit risks losing it if the process dies in between.

The solution, in four places only:

```
BEGIN
  UPDATE "ModelVersion" SET state = 'UPLOADED' ...
  INSERT INTO "StatusTransition" ...
  INSERT INTO "OutboxEvent" (aggregateType, aggregateId, eventType, payload) ...
COMMIT
                    ↓
       poller (every 500 ms, FOR UPDATE SKIP LOCKED)
                    ↓
       start / signal the Temporal workflow
                    ↓
       UPDATE "OutboxEvent" SET processedAt = now()
```

Redelivery is harmless because workflow IDs are deterministic and `WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY` makes a duplicate start a no-op.

Used by: upload completion, quote creation, order creation, payment webhook processing. A partial index on `WHERE processedAt IS NULL` keeps the poller's query O(unprocessed) regardless of table size.

**This is the whole answer to distributed transactions in this system.** There are none. There is one small table, a poller, and idempotent consumers. Kafka would add partitioned throughput we do not need, an operational burden we cannot absorb, and no correctness we do not already have. See [ADR-0011](./adr/0011-outbox-not-kafka.md).

---

## 6. Event model

**Domain events** are in-process (`@nestjs/event-emitter`), emitted inside a transaction boundary, consumed by same-process subscribers (audit, analytics, cache invalidation). **Integration events** go through the outbox, are versioned, and drive workflows and notifications.

Every event that exists has at least one real consumer. Events without subscribers are deleted.

| Event | Version | Consumers |
|---|---|---|
| `ModelVersionUploaded` | v1 | ModelProcessingWorkflow |
| `ModelUnitsAmbiguous` | v1 | SSE, notifications |
| `ModelAnalysisCompleted` | v1 | SSE, notifications, analytics |
| `ModelAnalysisFailed` | v1 | SSE, notifications, ops alerting |
| `SliceCompleted` / `SliceFailed` | v1 | QuoteWorkflow, analytics, ops alerting |
| `QuoteReady` / `QuoteFailed` | v1 | SSE, notifications, analytics |
| `QuoteAccepted` | v1 | OrdersModule, analytics |
| `QuoteExpired` | v1 | notifications |
| `OrderCreated` | v1 | OrderFulfillmentWorkflow, notifications |
| `PaymentSucceeded` / `PaymentFailed` | v1 | OrderFulfillmentWorkflow, notifications, finance |
| `ManufacturingJobCreated` / `Completed` / `Failed` | v1 | ops dashboard, notifications, calibration |
| `PrintJobStarted` / `Succeeded` / `Failed` | v1 | ops dashboard (Phase 14: telemetry) |

### Payload versioning

```ts
export const ModelAnalysisCompletedV1 = z.object({
  eventVersion: z.literal(1),
  modelVersionId: ModelVersionId,
  analysisId: GeometryAnalysisId,
  analyzerVersion: z.string(),
  occurredAt: IsoDateTime,
});
```

Contract tests assert that a v2 schema can still parse a v1 payload (additive-only within a major). A genuinely breaking change is a new event type, not a new version of the old one — this avoids the situation where a consumer must handle two incompatible shapes under one name.

**Events never carry geometry, file contents, signed URLs or money amounts.** They carry identifiers. A consumer that needs the data fetches it with its own authorization.

---

## 7. Idempotency

| Operation | Guarantee | Mechanism |
|---|---|---|
| Upload completion | Exactly-once effect | `UploadSession.id` + state machine rejects double completion |
| Model processing | Exactly-once execution | Temporal workflow ID |
| Geometry analysis | Exactly-once persistence | `UNIQUE(modelVersionId, analyzerVersion)` |
| Preview generation | Idempotent | `UNIQUE(modelVersionId, kind, producerVersion)` |
| Slicing | Exactly-once compute | `UNIQUE(SliceJob.cacheKey)` |
| Quote generation | Exactly-once | Temporal workflow ID |
| Quote acceptance → order | Exactly-once | `UNIQUE(Order.quoteId)` |
| Payment webhook | Exactly-once processing | `UNIQUE(provider, providerEventId)` |
| Notification send | At-least-once, deduped | `UNIQUE(userId, templateKey, dedupeKey)` |
| Client mutations | Exactly-once | `Idempotency-Key` header, response hash cached 24 h |

**The principle: a unique constraint is a guarantee; an application check is a hope.** Every row above resolves to a database constraint. Application-level checks exist too, to produce good error messages — but they are not what makes the guarantee.

The `Idempotency-Key` implementation stores the request hash alongside the response. A replay with the same key and the same body returns the cached response; a replay with the same key and a *different* body is a `409`, because that is a client bug and silently returning the old response would hide it.

---

## 8. Real-time progress

**Server-Sent Events**, not WebSockets. Progress is strictly server→client, SSE runs over plain HTTP with automatic browser reconnection and no additional infrastructure, and it survives proxies that mishandle WebSocket upgrades. WebSockets arrive at Phase 14 for printer telemetry, where bidirectional communication is genuinely required.

```
GET /api/v1/model-versions/:id/events      (SSE, authenticated, org-scoped)
GET /api/v1/quotes/:id/events
```

```
event: state
data: {"state":"ANALYZING","progress":0.4,"detail":"analizando geometría","occurredAt":"..."}

event: state
data: {"state":"AWAITING_UNIT_CONFIRMATION","candidates":[...]}

event: ready
data: {"state":"READY","modelVersionId":"..."}
```

Implementation notes that matter in production:

- **A heartbeat comment every 15 s** keeps intermediaries from closing an idle connection.
- **`Last-Event-ID` is honoured** — on reconnect the client resumes from the last event it saw, so a dropped connection does not lose a state change.
- The stream **always sends current state first**, so a client connecting late is immediately correct without a separate fetch.
- The stream **closes on a terminal state**. An SSE connection held open forever for a finished model is a leaked file descriptor per tab.
- Events are read from Redis pub/sub, fanned out from the domain event subscriber, so any API instance can serve any client's stream.
- On the client, events write into the **TanStack Query cache** (`setQueryData`) rather than a parallel store — one cache, one read path. See [ARCHITECTURE.md](./ARCHITECTURE.md#8-frontend-architecture).

---

## 9. What happens when things fail

The questions from §109 of the brief, answered concretely:

| Scenario | Behaviour |
|---|---|
| Worker crashes mid-analysis | Temporal reschedules the activity on another worker; the workflow resumes from the last completed step |
| Same request submitted twice | Workflow ID collides; the second start is a no-op |
| Customer refreshes during processing | SSE reconnects, receives current state first; nothing is lost |
| Same webhook arrives twice | `UNIQUE(provider, providerEventId)` rejects the insert; the handler returns 200 |
| Pricing rules change mid-quote | The quote holds `pricingRuleSetVersionId` resolved at creation; a publish cannot change it |
| Model replaced with a new version | A new `ModelVersion`; existing quotes reference the old one and remain valid and reproducible |
| Slicer version changes | `cacheKey` changes; new slices run against the new version; old `SliceResult`s keep their recorded version |
| 2 GB model uploaded | Rejected at the size gate before any compute, with a clear message and a contact route for enterprise tiers |
| STL uploaded in metres, system assumes mm | Inference flags it; if ambiguous the model blocks at `AWAITING_UNIT_CONFIRMATION` and no price is computed |
| User requests another org's model ID | Policy denies on the loaded resource; RLS would return zero rows regardless; a `403` with an audit entry |
| Quote created under an old material price | Honoured — it references the old `MaterialProfileVersion`. That is the entire point of the versioning |
| 100 printers | `ManufacturingJob` queue with priority ordering; printer assignment becomes a scheduling concern, not a schema change |
| Manufacturing in multiple countries | `Organization.countryCode` + jurisdiction-scoped tax + regional printer profiles; the schema does not change |
