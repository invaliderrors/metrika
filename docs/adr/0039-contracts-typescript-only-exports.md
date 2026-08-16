# ADR-0039 — `packages/contracts` declares two tables, and only one of them crosses into Python

**Status:** Accepted · **Date:** 2026-08-16

## Context

`packages/contracts/test/json-schema.test.ts` has asserted since Plan 0B-3 that
`emitJsonSchemas()` covers **exactly** the Zod schemas the package exports — "no
more, no fewer" — and that every one of them is built only from constructs
measured to survive `z.toJSONSchema()`. The allowlist admits four node kinds
(`object`, `string`, `number`, `enum`), four checks and one string format
(`regex`). `.optional()`, `.nullable()`, `.default()`, `.catch()`, `.refine()`,
`.trim()`, `z.coerce.*`, `z.email()`, `z.uuid()`, `min_length` and **arrays** are
each rejected by name, with a fixture per rejection.

That is not caution. `z.toJSONSchema()` drops most of them in SILENCE: a
`.refine()` added to `Money.amountMinor` was measured to leave the generated
pydantic file byte-identical, so `pnpm contracts:emit`, CI's `git diff
--exit-code` and every test on both sides stayed green while Python accepted a
40-digit amount Zod rejected. A dropped check and an absent check are the same
JSON Schema, so the only place the difference is observable is the Zod internals
— which is what the allowlist walks.

Phase 1A is the slice that first hits the wall. `MeResponse.memberships` is
`z.array(MembershipSummary)` and `MeResponse.timezone` is `.optional()`; neither
can be written under the rule above. `MeResponse` is also a schema `apps/workers`
has no use for whatsoever — the workers hold no database credentials, never see a
user, and receive activity arguments plus S3 keys. The wall is in the right
place; the schema is on the wrong side of it.

**No ADR is being corrected here.** `AuthContext` appears twice in
[ADR-0013](./0013-authorization.md) — in its title and in decision 2, "`AuthContext`
in every repository signature" — and neither names a package. `PolicyResult`
appears in no ADR at all. `EMITTED` is named in `docs/` only by
`docs/CONTRACTS_AND_API.md` §5 and by the Phase 1A plan that specifies this ADR;
no decision record names it. The only placement claim in the repository is
`docs/ROADMAP.md:282`, which is prose in a phase outline. This ADR therefore
establishes a fact rather than overturning one — stated explicitly so a future
reader does not go looking for the ADR it supersedes.

### What was measured before choosing

- `isRedactedKey('email')` is **false**, against
  `packages/contracts/dist/index.js` at commit `b34e880`. Also false: `Email`,
  `EMAIL`, `emailAddress`, `userEmail`, `email_address`, `contactEmail`,
  `emails`. `RedactedFieldName` holds 17 names and none of them contains the word.
- **Nothing in this repository writes an email into a log line, a span attribute
  or a Sentry field today.** The single case-insensitive occurrence of `email` in
  `apps/*/src` and `packages/*/src` is a constructed probe payload inside a doc
  comment at `packages/contracts/src/sentry-event.ts:520`, demonstrating what a
  throwing `beforeSend` would ship. `apps/web` sets `sendDefaultPii: false` in
  both its runtimes; `apps/api` sets no PII option and inherits the SDK default
  of `false`; `Sentry.setUser(` and `initialScope` appear nowhere.
- A JSON Schema carrying `format: email` generates `EmailStr`, which needs the
  optional `email-validator` package. [ADR-0027](./0027-python-toolchain.md)
  measured that without it `datamodel-codegen` exits 0, `ruff check` passes,
  `ruff format --check` passes, `mypy --strict` reports `Success: no issues
found` — and `import` raises `ImportError: email-validator is not installed`.
  Three green gates and a broken artifact. That is why `z.email()` is a named
  rejection fixture and why `MeResponse.email` is a plain `z.string()`.

## Decision

**1. `EMITTED` and `TS_ONLY` partition the package's exported Zod schemas, by
name AND by binding.** `EMITTED ∪ TS_ONLY` is exactly the set of `z.ZodType`
values `src/index.ts` exports, `EMITTED ∩ TS_ONLY` is empty, and `EMITTED.X` is
the export called `X`. All three are asserted in `test/json-schema.test.ts`.
Three assertions rather than one, because each is blind to the others' defect.
The union check alone is satisfied by a name appearing in **both** tables, which
leaves it ambiguous whether the schema crosses — with `emitJsonSchemas()`
answering "yes" regardless of what `TS_ONLY` says. And both name-based checks are
satisfied by a table whose keys are right and whose **values are swapped**: the
emitted `$defs` key comes from the table key, so `{ OrganizationKind:
PlatformRole, PlatformRole: OrganizationKind }` renames two generated Python
classes onto each other's members. Measured, before the binding assertion existed:
that swap left the suite passing 1537/1537 at 100% coverage, and the only gate
that would have seen it is CI's re-emit diff — whose message tells the developer
to commit the regenerated file, which makes the diff clean and ships the swap.

**2. `emitJsonSchemas()` is unchanged, and that is the whole fence.** It walks
`Object.entries(EMITTED)` and nothing else; `contractsJsonSchemaDocument()` walks
`emitJsonSchemas()`; `scripts/contracts-emit.mjs` writes that one object to the
file it hands `datamodel-codegen` as `--input`. There is no other iteration in
the chain. A `TS_ONLY` schema is therefore not _forbidden_ from reaching the
pydantic models — it is **absent from the only loop that could carry it there**.
Teaching the emitter about `TS_ONLY` in any form would be the one edit that
removes the fence.

**3. The allowlist walk stays scoped to `EMITTED` alone.** `TS_ONLY` schemas are
never walked, because the constructs the walk rejects are precisely the ones
`TS_ONLY` exists to permit. Walking both would report `MeResponse.memberships`
as an offender and the fork would buy nothing.

**4. `TS_ONLY` is exported from `src/json-schema.ts` for the test only, and is
not re-exported through `index.ts`** — for the reason already written above
`EMITTED` there. Re-exporting the module puts both live tables, holding every
schema in the package, on the path every consumer imports including the browser
bundle, and leaves tree-shaking to argue them back out.

**5. `OrganizationKind`, `OrganizationRole`, `PlatformRole` and
`OrganizationMemberId` go in `EMITTED`.** All four cross the allowlist cleanly —
a `z.enum` is a leaf node of kind `enum`, and `brandedUuid()` is a `string` node
with a `regex` check, the same shape as the eleven branded IDs already emitted.
They are vocabulary, they cost four leaf entries, and putting them in `TS_ONLY`
would mean inventing a reason to withhold something that already crosses.

**6. `MembershipSummary` and `MeResponse` go in `TS_ONLY`, and `MeResponse.email`
is a plain `z.string()`.** Not `z.email()`: the allowlist rejects it, and even if
it did not, `EmailStr` is ADR-0027's three-green-gates failure. A `TS_ONLY`
schema never reaches the generator, so the choice is about the TypeScript side
alone — and address-shaped validation on a value Clerk has already verified buys
nothing here.

**7. A `TS_ONLY` schema may reference an `EMITTED` schema; an `EMITTED` schema
may not reference a `TS_ONLY` one.** The direction matters and the asymmetry is
measured: an unregistered schema nested inside a registered one is **inlined**
rather than `$ref`'d, which is exactly how a second Python enum called `Currency`
was once generated beside `CurrencyCode`. `MeResponse` referencing
`OrganizationRole` is safe because the parent is never registered and never
walked. The reverse would cross anonymously, and the guard against it is an
**identity** assertion, not a count: the allowlist walk already descends every
emitted shape, so it collects the schema objects it reaches and asserts that none
of them is a value in `TS_ONLY`.

The exact-count assertion `visited.length === Object.keys(EMITTED).length + 3` —
the `+ 3` being `Money`'s three properties, the only nested nodes in the package —
is kept beside it and is **not** this guard. It catches a nested shape appearing
where none was, which is worth catching; it cannot catch the same crossing done
by SUBSTITUTION, because swapping one property's schema for another adds no node.
Measured both ways on this tree: an `EMITTED` object with a `MembershipSummary`
property fails the count at 35-vs-28 _and_ the identity assertion, which names
the property; moving `CurrencyCode` into `TS_ONLY` while `Money.currency` still
references it leaves the count matching at 26, the union assertion passing and
the overlap assertion passing, and fails the identity assertion alone. A count
also invites exactly one repair — editing the number — after which the crossing
is permanent and silent, which is why its failure message now says not to.

## The fence, measured rather than asserted

A partition that nothing enforces is a comment. Five mutations were applied to
the tree this ADR ships with, each run through
`pnpm --filter @metrika/contracts test:unit` and then reverted, and each is
reproducible from this list alone.

| Mutation                                                                | Exit | What went red                                                                                                                              |
| ----------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `MeResponse` moved from `TS_ONLY` to `EMITTED`                          | 1    | 4 tests. The allowlist walk names both constructs: `` MeResponse.timezone: `.optional()` `` and ``MeResponse.memberships: a `array` node`` |
| A new `z.string()` exported, in neither table                           | 1    | 1 test — the union assertion, naming the schema that reached neither side                                                                  |
| `OrganizationRole` added to `TS_ONLY` as well                           | 1    | 2 tests, including the overlap assertion: `expected [ 'OrganizationRole' ] to deeply equal []`                                             |
| `OrganizationKind` and `PlatformRole`'s values swapped, both keys kept  | 1    | 1 test — the binding assertion: `expected [ 'OrganizationKind', 'PlatformRole' ] to deeply equal []`                                       |
| `CurrencyCode` moved to `TS_ONLY`, `Money.currency` left referencing it | 1    | 3 tests, including the identity assertion naming `Money.currency: CurrencyCode`. **The count assertion passes**                            |

**Two rows explain why there are three assertions and not one.** Under mutation 1
the union assertion **passes** — moving a name between the tables leaves the
union unchanged — and what catches it is the allowlist walk, which is scoped to
`EMITTED` for exactly this reason. Under mutation 3 the union assertion happens
to fail as well, because the declared list is built by concatenation and the
duplicate shows up as one extra element; but it fails by naming a schema that IS
declared, which reads as the opposite of the actual defect, and it would stop
failing the moment somebody "simplified" that list into a `Set`. The overlap
assertion is the one that says what is wrong, and it says it in one line.

**The last two rows are why the partition is asserted on bindings and on schema
identity, not only on names.** Before those assertions existed, mutation 4 was
fully green — 1537/1537 at 100% coverage — while the emitted document gave
`OrganizationKind` the members `PLATFORM_ADMIN … SUPPORT`; and mutation 5 slips
past the count because substitution adds no node. Both are the same class of
defect: every check that compares NAMES is satisfied by a table whose names are
right and whose schemas are not.

And the emit itself: `pnpm contracts:emit` on this tree produced **+29 lines and
no deletions** in the generated pydantic module — three `StrEnum` classes and one
`RootModel[StrictStr]`, inserted in sorted `$defs` order after `OrganizationId`.
`MeResponse`, `MembershipSummary`, `memberships`, `timezone` and `displayName`
appear nowhere in it. `packages/contracts/redaction-corpus.json` did not move,
which is the `email` decision below showing up as a byte count.

## Alternatives

**(a) Widen the allowlist, with a measured Python-side probe per construct.**
It is the only answer that keeps one list and introduces no second concept, and
the mechanism for it already exists: adding a node kind is two deliberate edits
plus a `test_generated_contracts.py` case proving the construct landed. Rejected
because it inverts the direction of the guarantee. The list exists so that
nothing reaches Python without a human adding it; widening it to admit arrays,
`.optional()` and the rest would send every Phase 1 API response schema into
`apps/workers` — a package with no database, no user, and no use for
`MeResponse` — and would owe a permanent Python-side probe for each construct.
The measured cost of getting `.optional()` wrong is concrete: `memo:
z.string().optional()` generates `memo: StrictStr | None = None`, which accepts
an explicit `"memo": null` where Zod rejects it, because optional and nullable
are the same thing in pydantic and are not in Zod. **Revisit if a schema
`apps/workers` genuinely needs ever requires a construct outside the allowlist**
— a slicer result with an optional field, say. Then the probe is owed anyway and
(a) is the cheaper answer for that one construct.

**(c) A second subpath export, `@metrika/contracts/api`.** Physical separation
rather than a declared one: the API-only schemas would be unreachable from the
emitter by module graph rather than by table membership, which is a stronger
property than a hand-written list. Rejected on cost and on blast radius.
`packages/contracts`'s `exports` map is `"."` plus `"./package.json"` today, and
both `apps/api` and `apps/web` resolve this package at `dist/` behind a
conditional map ([ADR-0026](./0026-web-consumes-compiled-contracts.md)) — so a
second subpath is a build-output change consumed by two applications, with a
second `tsconfig` path mapping, a second entry in `files`, and a new way for a
consumer to import the wrong half. It also buys nothing the partition assertion
does not already give: a schema cannot fall out of both tables, whereas a schema
can be put in the wrong _file_ under (c) with nothing to notice.
**Revisit if `TS_ONLY` grows past the point where a reviewer can hold both tables
in view** — or if a consumer is ever added that must be unable to import the API
schemas at all, rather than merely have no reason to.

## Consequences

1. **A new Zod export must be added to `EMITTED` or to `TS_ONLY`, and the
   reviewer's question is now "which table" rather than "is it in the table".**
   Falling out of both fails the partition assertion with the message naming both
   tables; being in both fails the overlap assertion. Neither can be satisfied by
   editing one place.

2. **`AuthContext` does not live in `packages/contracts`, and neither does
   `PolicyResult` — a deviation from `docs/ROADMAP.md:282`, recorded here rather
   than justified in passing.** That line lists both under Phase 1's
   **Contracts**, i.e. in this package. They are not wire types: `AuthContext` is
   what a guard hands a repository and `PolicyResult` is what a policy function
   returns. Every export of this package is a candidate for the pydantic codegen,
   so putting them here would push `OrganizationRole` semantics into a shape
   `apps/workers` inherits for no reason — and, under this ADR, would force a
   `TS_ONLY` entry for a type that has no business being in a schema package at
   all. `AuthContext` is an interface at
   `apps/api/src/authorization/auth-context.ts`, and `PolicyResult` sits beside it
   at `apps/api/src/authorization/policy-result.ts`, on identical reasoning —
   decided in the same breath so Plan 1B inherits an answer rather than a
   precedent. `docs/ARCHITECTURE.md:742-750` already sketches the policy signature
   with both types at `apps/api/src/authorization/policies/`, which supports the
   placement rather than contradicting it. What stays in `packages/contracts` is
   the vocabulary both are typed against: `OrganizationRole`, `PlatformRole`,
   `OrganizationKind` and the branded IDs.

3. **`docs/ROADMAP.md:282` and this ADR disagree in the tree until Plan 1A Task 9
   corrects that line.** The window is deliberate — the roadmap is edited once, at
   the end of the slice — and it is named here so a reader who lands between the
   two commits knows which one is current. This one is.

4. **`email` does NOT join `RedactedFieldName`, and that is a decision rather
   than an omission.** Nothing writes an email into any of the four log/error
   sinks or into a span attribute today (measured above), so adding the name would
   censor a value no sink currently emits. It is not free: redaction is
   field-granular and shared, so `email` would be replaced in Pino, in `apps/api`'s
   Sentry client, in `apps/web`'s Sentry client, in `apps/workers`' structlog and
   in every span attribute at once — which makes Plan 1C's invitation debugging
   materially harder, since an invitation is addressed by email and nothing else.
   It also costs a re-emit: one name is up to 60 declared spellings in
   `packages/contracts/redaction-corpus.json` (956 rows today: 910 redacted, 46
   must-survive), a new `StrEnum` member in the generated pydantic module, and a
   pytest case per new row through the real structlog pipeline — both committed
   artefacts move and CI byte-diffs both.

   **The trigger that overturns this: the first log line, span attribute or Sentry
   field that carries an email.** `redactSentryEvent` and `isRedactedKey` match on
   key NAME only, so an `event.user.email` — from a `Sentry.setUser({ email })`,
   or from flipping `sendDefaultPii` — would pass through uncensored the moment it
   exists. Plan 13's Ley 1581 (R17) review is the second trigger, and it arrives
   with `AuditLog.ipAddress` and `userAgent`, which are the same question asked
   about two more names.

5. **The four new `EMITTED` entries move the generated pydantic module, and that
   diff is part of this commit.** Three `StrEnum` classes and one
   `RootModel[StrictStr]` with the shared UUID pattern, inserted in sorted `$defs`
   order. `apps/workers`' `VALID_PAYLOADS` gains `OrganizationMemberId`, because
   `test_every_generated_model_has_a_sample` asserts exact set equality against
   every generated `BaseModel`; the three enums need no entry, since a `StrEnum`
   is not a `BaseModel`, and the ID's non-ASCII-digit probe and its ASCII twin are
   derived from the `endswith('Id')` comprehensions.

6. **`MeResponse` and `MembershipSummary` must produce no diff in the generated
   pydantic module, in this commit and in every later one.** If they ever do,
   `TS_ONLY` has been wired into the emitter and the fork is not real. This is a
   fixture rather than a check to run by hand: `declares no class for a TS_ONLY
schema` in `test/json-schema.test.ts` reads the committed module and asserts
   that no name in `TS_ONLY` has a class in it. It is the only assertion in the
   suite that questions the ARTEFACT rather than the TypeScript side, and it is
   the one that bites when `TS_ONLY` eventually holds a schema the allowlist would
   have admitted — where moving the schema into the wrong table leaves every other
   gate green.
