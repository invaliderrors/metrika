# Metrika — Technical Risk Register

> Probability × impact, with a named mitigation and a phase where the mitigation lands. Reviewed at the end of each phase.

Scale: **P** = probability without mitigation (Low / Medium / High). **I** = impact if it happens (Low / Medium / High / Critical).

---

## Tier 1 — the ones that decide whether this works

### R1 — Unit ambiguity produces a catastrophically wrong quote

**P: High · I: Critical**

An architect exports an STL in metres. The system assumes millimetres. Volume is wrong by 10⁹, the quote is wrong by orders of magnitude, and if it is wrong in the customer's favour it is honoured.

_Mitigation:_ `unitInterpretation` as a first-class domain concept; `AMBIGUOUS` is a blocking state that prevents quoting entirely; plausibility bounds reject implausible interpretations outright; the confirmation UI shows implied real-world and printed sizes side by side rather than abstract unit names; dedicated fixtures and contract tests. **Phase 3.**

_Residual:_ a `LIKELY` inference that is wrong and is not questioned by the customer. Reduced by showing the inferred interpretation prominently in the quote itself, not just at upload.

### R2 — Print time and material estimates drift from reality, eroding margin invisibly

**P: High · I: High**

PrusaSlicer's estimates are good for simple parts and can be materially off for complex ones. Pricing against them means margin erodes silently — there is no error, no alert, just a business that is less profitable than its spreadsheet says.

_Mitigation:_ `ManufacturingJob.actualPrintSeconds` and `actualMassG` captured on every completed job; a scheduled calibration job comparing actuals to estimates by printer profile version, material and complexity band; an alert when median deviation exceeds 15%; corrections applied by publishing a new pricing rule set version. **Phase 11**, with the columns existing from Phase 10.

_Residual:_ the first ~50 orders are priced against an uncalibrated model. Treat them explicitly as a calibration exercise and set the initial margin component conservatively.

### R3 — PrusaSlicer AGPL obligations

**P: Medium · I: High**

Every credible open slicer is AGPL. How §13 applies to a hosted service invoking an AGPL binary as a subprocess is genuinely open.

_Mitigation:_ unmodified upstream binary, separate process, no linking, provenance recorded in `infra/docker/slicer/PROVENANCE.md`; the `SlicerEngine` port preserves the ability to change engines; **formal legal review is a launch gate in Phase 13.** See [SLICING.md](./SLICING.md#3-licensing--an-open-launch-blocking-question).

_Residual:_ counsel may require offering corresponding source or changing the deployment. Preserving optionality is the entire mitigation; do not modify the binary, which would remove the simplest available position.

### R4 — Customer geometry leak

**P: Low · I: Critical**

An unbuilt building design reaching a competitor is an existential reputational event.

_Mitigation:_ layered — KMS encryption with a dedicated key for originals; RLS plus policy plus `AuthContext` repositories; 60-second signed download URLs; originals never CDN-fronted; the browser only ever receives decimated derivatives; every original access audited; signed URLs and file names redacted from all logs; automated cross-tenant IDOR suite on every pull request. **Phases 1–2**, hardened in 12.

---

## Tier 2 — significant, well-mitigated

### R5 — Large model memory exhaustion in workers

**P: High · I: Medium**

_Mitigation:_ pre-parse triangle estimation (exact for binary STL); hard size gates before compute; `RLIMIT_AS` plus container limits plus activity timeouts (three independent stops); separate small and large task queues so a 900 MB model does not starve a 5 MB one; a 20 M-triangle fixture in the test suite. **Phase 3.**

### R6 — Temporal complexity and non-determinism bugs

**P: Medium · I: Medium**

_Mitigation:_ Temporal Cloud rather than self-hosting; a dedicated ESLint profile banning `Date`, `Math`, `crypto`, `node:*` and infrastructure imports inside `workflows/**`; the time-skipping test environment in integration tests; the Temporal UI for replay debugging; a documented `patched()` deprecation window with a CI age check. **Phase 0.**

### R7 — Heuristic quality — false printability warnings

**P: High · I: Medium**

A wall-thickness heuristic that reports a false thin wall either blocks a printable model or trains customers to ignore warnings.

_Mitigation:_ a `BLOCKER`-severity issue may only have `certainty: EXACT` — a heuristic can warn, never block; confidence levels surfaced in the UI with different visual weight and different language; the fixture set includes known-good models that must not produce blockers; the algorithm choice is an explicitly open decision resolved by measurement at Phase 3. **Phase 3, iterated indefinitely.**

### R8 — Payment integration friction in Colombia

**P: Medium · I: Medium**

PSE and Nequi are essential locally and behave differently from card flows — redirect-based, asynchronously confirmed, with settlement delays.

_Mitigation:_ the `PaymentProvider` interface is designed around the redirect-plus-async-webhook shape, which is the superset that also covers cards; `FakePaymentProvider` for development and E2E; provider selection deferred to Phase 9 with the interface already fixed. **Phase 9.**

### R9 — Browser cannot render large architectural models

**P: Medium · I: Medium**

_Mitigation:_ decimation to a 300 k-triangle budget server-side; an LOD chain for models still too large; Meshopt/Draco compression; `frameloop="demand"`; mandatory disposal with a mount/unmount memory test; WebGL context-loss recovery. **Phase 4.**

### R10 — S3 cost growth

**P: Medium · I: Low**

_Mitigation:_ lifecycle rules per prefix (Glacier IR for originals at 90 days, expiry for previews at 180); Intelligent-Tiering; per-organization storage quotas; orphan-upload cleanup; AWS Budgets alarms. **Phase 2.**

### R11 — Compute cost amplification attack

**P: Medium · I: High**

Slicing costs real money per request; an attacker or a buggy client loop can generate a large bill quickly.

_Mitigation:_ per-org slicing rate limits (60/hour, 5 concurrent) and monthly quotas; the content-addressed slice cache makes repeated identical requests free; Fargate Spot; AWS Budgets alarms at 50/80/100%; per-org anomaly detection. **Phase 6.**

---

## Tier 3 — watch

### R12 — contract-layer abandonment or incompatibility

**P: Low · I: Medium** — _materialised for ts-rest in Phase 0; mitigation worked._

_What happened:_ the Phase 0 spike found `@ts-rest/core` hard-pinned to Zod 3 internals, no publish of any kind in fourteen months, and `@ts-rest/open-api` emitting silently empty schemas against Zod 4. The documented fallback was taken before any code depended on it. See [ADR-0019](./adr/0019-nestjs-zod-contracts.md).

_Mitigation, still standing for `nestjs-zod`:_ the source of truth is Zod, not the delivery library — migration means rewriting one-line DTO wrappers and regenerating the client from the emitted OpenAPI, roughly a week. Contract libraries in this space are small and short-lived; assume the next one is too, and keep `packages/contracts` free of any of them. **Phase 0, resolved.**

### R13 — Prisma limitations at scale

**P: Low · I: Medium**

_Mitigation:_ Prisma is confined to `infrastructure/persistence`; complex queries can drop to `$queryRaw` with tagged templates; per-endpoint query-count budgets asserted in tests catch N+1 immediately. **Ongoing.**

### R14 — Vercel + AWS split creating operational drag

**P: Medium · I: Low**

_Mitigation:_ bearer-token auth removes the cross-origin cookie complexity that usually makes this painful; both deploy from the same CI; the fallback (containerising Next on ECS) is a known, bounded piece of work. **Reassess at Phase 13.**

### R15 — Printer vendor lock-in

**P: Low · I: Medium**

_Mitigation:_ `PrinterDriver` interface with a conformance suite written before any real driver exists; `ManualPrinterDriver` exercises the full manufacturing path from Phase 11 with no hardware. **Phase 11.**

### R16 — Solo-builder bus factor and agent-generated code drift

**P: High · I: Medium**

One person plus AI agents means no code review, no second opinion, and a real risk of subtly wrong code passing because it looks right.

_Mitigation:_ this is what the unusually strict gates are for — `no-explicit-any` and the `no-unsafe-*` family as errors, `--max-warnings=0`, 100% coverage on the pure kernels, exhaustive state-machine tests, the automated cross-tenant IDOR suite, golden-file pricing tests, and CODEOWNERS as a self-imposed stop-and-think marker on expensive files. Architecture documents are CI-checked against reality where mechanically possible. **Phase 0, permanently.**

_Residual:_ domain misunderstandings that the type system cannot catch. Reduced by the golden-file pricing corpus, which makes business-logic changes visible as reviewable diffs.

### R17 — Colombian data-protection compliance (Ley 1581)

**P: Medium · I: Medium**

_Mitigation:_ deletion and export workflows built to the documented data map; privacy notice and consent capture at signup; audit logging of access to personal data. **A compliance review is a launch gate in Phase 13**, on the same footing as the AGPL review.

### R18 — Scope creep into segmentation and auto-orientation before launch

**P: Medium · I: Medium**

Both are genuinely valuable and genuinely hard, and both are seductive.

_Mitigation:_ explicitly classified V2 in [ROADMAP.md](./ROADMAP.md); the schema already models N parts per order item so neither requires a migration later; the definition of done for Phase 13 is a working single-part flow, not a feature list.

---

## Open findings carried out of Phase 0B-1

These were found by the whole-branch review of Plan 0B-1 and merged unfixed, deliberately. They are recorded here rather than in a plan ledger so they survive the branch.

### F1 — Three request shapes escape the error envelope

**P: High (already reproducible) · I: Medium**

Node's HTTP parser rejects some requests before Fastify's routing runs, so they reach `defaultClientErrorHandler` rather than the `frameworkErrors` hook the exception filter is wired into. Measured against the built app:

| Shape                  | Response                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| Header block > 16 KB   | `431 {"error":"Request Header Fields Too Large","message":"…","statusCode":431}`, **no** `x-request-id` |
| Malformed method token | `400 {"error":"Bad Request","message":"Client Error","statusCode":400}`, no `x-request-id`              |
| `obs-fold` header      | Same `400` body, no `x-request-id`                                                                      |

In each, `error` is a **string** where [`ApiErrorResponse`](./CONTRACTS_AND_API.md#errors) declares an object, `code` is absent, and there is no `requestId` — so a client parsing with the published contract fails outright and support has no id to trace. This is the same defect already closed for `FST_ERR_BAD_URL`, one layer lower. The 431 case is a realistic oversized-cookie scenario, and `/health/deep` is an `Authorization`-header route.

`apps/api/src/bootstrap.ts` currently comments that "nothing that logs or throws runs without an id", which is false for these three.

_Mitigation:_ pass `clientErrorHandler` alongside `frameworkErrors` in the `FastifyAdapter` options — it is a first-class Fastify option and the fix is symmetric with the existing hook. It receives a raw `net.Socket` rather than a `FastifyReply`, so the response is written by hand and a throw inside it must not escape; a 431 means the headers were unparseable, so there may be no client id to echo and one must be minted.

### F2 — Two comments describe the pre-guard world

**P: Medium · I: Low**

`apps/api/src/shared/request-context/request-context.module.ts` and `apps/api/test/request-context.test.ts` both state that importing `RequestContextModule` into `AppModule` leaves the integration suite green. That was true before the Task 10 guards landed; at HEAD a direct import exits 1. As written they argue the integration spy count cannot catch anything, which is the argument for deleting the guard that does.

_Mitigation:_ correct both to record which spelling each guard catches — the unit metadata assertion sees direct and spread imports, the integration spy count sees the dynamic and transitive ones it cannot.

### F3 — `ARCHITECTURE.md` and `TESTING.md` assert controls that do not exist

**P: High (already true) · I: Medium**

Plan 0B-1's final task reconciled five documents with reality and missed these two. Each of the following is stated as present fact and is false: no application code exists yet (`ARCHITECTURE.md`); Turbo remote caching is enabled; CI compares the repository tree in §6 against the directory listing and the env-var table against the Zod schemas; each integration test runs inside a rolled-back transaction (nothing rolls back — `withOrganizationContext` commits, and the RLS suite depends on its seed rows surviving); the IDOR suite runs on every pull request. Smaller instances exist for `brandUnsafe`, `contracts:emit`, Scalar, two lint rules, and part of the integration coverage list.

Two of these now directly contradict corrections landed in `CONTRIBUTING.md` on the same branch.

The remote-caching claim is the one with teeth: `ci.yml` states that enabling a Turbo cache silently disarms the last real cross-package type gate, because `tsc -b` skips re-checking when only a dependency's `.d.ts` changed. Someone reconciling "the architecture says caching is on, CI does not have it" turns it on and removes the gate.

_Mitigation:_ apply the same honest form used elsewhere in the blueprint — describe the target state and say plainly that it is not built yet. See also [R19](#r19--tsc--b-skips-stale-cross-package-dependencies).

### R19 — `tsc -b` skips stale cross-package dependencies

**P: High (measured) · I: High**

No tsconfig in the repository declares project `references`, so a workspace dependency resolves through its `node_modules` symlink to `dist/index.d.ts`, which is not among the consuming project's own input files and never invalidates its build-info. `tsc -b` therefore reports a project up to date when only a dependency's types changed. Measured: a type-only widening in `packages/contracts` leaves `pnpm verify` at exit 0 on a tree where `tsc -b --force` exits 1.

`typecheck` now carries `--force` as a stopgap. `build` does not, and `--force` cannot reach a stale `.d.ts` one hop upstream — the day `packages/database` re-exports a contracts type, `apps/api` will typecheck against stale declarations again.

CI catches this today **only** because nothing caches `.turbo`; a fresh checkout has no build-info.

_Mitigation:_ declare project `references` in each consumer tsconfig, pointing at the dependency's `tsconfig.build.json`. That covers both `build` and `typecheck` and keeps incrementality, at the cost of `tsc -b` emitting `dist/**` from the `typecheck` task — outputs Turbo does not currently declare for it. Listing `*.tsbuildinfo` in Turbo `outputs` was measured and does **not** work, because Turbo does not clean declared outputs before a cache-miss run.

---

## Review cadence

The register is reviewed at the end of every phase. A risk is closed only when its mitigation is implemented **and tested** — not when it is designed. New risks discovered during implementation are added with the same fields, and the top four are re-ranked, because the ranking is the useful part.
