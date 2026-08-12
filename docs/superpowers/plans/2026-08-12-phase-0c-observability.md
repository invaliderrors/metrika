# Phase 0C — Observability and correlation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A support ticket saying _"my quote failed, request ID `req_01H…`"_ resolves to one distributed trace spanning the browser, the API, Temporal and both Python workers — with structured logs on all three runtimes and a redaction list that is a tested control rather than a configuration block.

**Architecture:** OpenTelemetry to an OTLP endpoint, so the backend is a configuration change and not a refactor. Correlation is the deliverable; the SDK wiring is plumbing. A request ID enters at the edge, binds to `AsyncLocalStorage` in the API, becomes Temporal search attributes and OTel baggage at the workflow boundary, and is bound to every structlog line in Python. Redaction is defined once and asserted on every sink.

**Tech Stack:** OpenTelemetry (Node + Python), Pino, structlog, Sentry, Temporal search attributes.

## Task tiering

Each task is marked **REVIEW** or **SELF-VERIFIED**. Reviewed tasks get a fresh reviewer and a fix loop; self-verified tasks are trusted on their own mutation evidence unless they report a deviation or a green mutation. The split is by blast radius, not by size.

| Task                                           | Tier          | Why                                                     |
| ---------------------------------------------- | ------------- | ------------------------------------------------------- |
| 1 — the spike and ADR-0029                     | **REVIEW**    | Decides every pin five tasks consume                    |
| 2 — Pino, redaction, and the DSN carry-forward | **REVIEW**    | Security control; closes a known credential leak        |
| 3 — OTel bootstrap and the correlation chain   | **REVIEW**    | The deliverable                                         |
| 4 — the Python side                            | **REVIEW**    | Crosses the boundary that produced five defects in 0B-3 |
| 5 — `apps/web`'s request-ID origin             | SELF-VERIFIED | Presentation only; no credential path                   |
| 6 — the redaction fixtures, CI and docs        | **REVIEW**    | The control this plan exists to make real               |

## Global Constraints

- **Versions are decided by Task 1's spike.** Later tasks write `<pin>` and read ADR-0029's table — including the pin that **changed** in review: the Fastify instrumentation is `@fastify/otel@0.20.1`, not the deprecated `@opentelemetry/instrumentation-fastify`. The "Node OTel SDK is **0.x**" premise this plan was written on is half true and the half that is false matters: the **stable** train (`core`, `resources`, `sdk-trace-*`, `sdk-metrics`, `context-async-hooks`) is on **2.10.0**, and only `sdk-node`, the exporters and the instrumentations are `0.x`.
- Exact pins both sides. The gate walks every `package.json` and `pyproject.toml` repo-wide, exempts `{ workspace = true }` declared in the same file, and covers `[build-system] requires`.
- **`console.log` is banned** (`no-console: error`) and `print()` is banned (`T20`). Both are already live.
- No `any`; `@ts-ignore` banned; `@ts-expect-error`/`eslint-disable` need `-- <justification>`, and CI's grep also fails if `--` appears anywhere in the **path**. Python suppressions need the second-comment form `# type: ignore[code]  # -- why`.
- `mypy --strict`; ruff with `PGH`, `DTZ`, `T20`, `S`. `pnpm lint` passes `--max-warnings=0`.
- **Do not add an `actions/cache` step for `.turbo`** and do not enable a remote cache — see [R19](../../RISK_REGISTER.md).
- **A test that reads a file outside its own package is silently unhashed by Turbo and passes from cache.** Six instances were found in Plans 0B-2 and 0B-3. Declare `inputs` with `$TURBO_ROOT$` and prove invalidation by mutating the outside file.
- Conventional commits, scoped by package. **No `Co-Authored-By` trailers or any other AI attribution.** Documentation ships in the same commit.
- Gates: `pnpm verify` 0, `pnpm test:integration` 0, `tsc -b --force` 0 for every Node package, and in `apps/workers` `ruff check`, `ruff format --check`, `mypy`, `uv lock --check`, both `pytest` invocations 0. Exit codes from `$?` directly — never off a pipe; `${PIPESTATUS[0]}` is empty in zsh (it is `$pipestatus[1]`).

**PATH** — mise is not activated in non-interactive shells here, and the uv binary is not under `.../0.12.3/bin`:

```bash
export PATH="$HOME/.local/share/mise/installs/uv/0.12.3/uv-aarch64-apple-darwin:/Users/mike/.local/share/mise/installs/node/24.19.0/bin:$PATH"
```

## What this plan does **not** build

Grafana dashboards, alert rules, Synthetic Monitoring, PostHog, domain metrics, business KPIs, and the `/health/deep` latency histogram. Those need a running system with real traffic. This plan builds the correlation spine and the redaction control; §4–§6 of `docs/OBSERVABILITY.md` stay target state.

## A carry-forward that lands here, and is a live credential leak

`apps/api/src/shared/errors/domain-exception.filter.ts:23-26` carries this note, written in Plan 0B-1:

> an `Error`'s stack carries its message, so the DSN this response omits is still written to the log. Acceptable only while the sink is stdout on a machine an operator already owns. **Before 0C ships a log sink or a Sentry DSN, this needs redaction — do not inherit it.**

Measured then: `new InternalServerErrorException('DB_DSN=postgres://user:PASSWORD@host/db')` is suppressed in the response body and written verbatim to the log, because `error.stack` begins with `${name}: ${message}`.

**Task 2 closes it, and no task in this plan may ship a sink before it does.** Wiring an exporter first turns a local-only exposure into an exported one.

---

### Task 1: The spike, and ADR-0029 — **REVIEW**

Two spikes in this project have each paid for themselves several times over. This one has a specific reason to exist beyond habit: **the Node OpenTelemetry SDK is 0.x**, and Sentry 8+ is itself built on OpenTelemetry, so the two either integrate or fight — and which one is not something to discover in Task 3.

**Files:** Create `docs/adr/0029-observability-stack.md` and — after review found obligation 8 measured at the wrong call shape — `docs/adr/0030-nest-logger-argument-shape.md`; modify `docs/adr/README.md`.

**Produces:** the exact pin for every package Tasks 2–6 install, plus the answers below. **Read 0029 and 0030 together**; 0029's header says where it is corrected.

- [ ] **Step 1: Build the spike outside the workspace** — `SPIKE=$(mktemp -d)`. A workspace member that fails to install breaks `pnpm install` for everyone.

- [ ] **Step 2: Record what the registries offer**, for every package Tasks 2–6 will install on both sides. A pin decided ad hoc in a later task is a pin nobody reviewed.

- [ ] **Step 3: Check ranges before installing.** Node: peer ranges against Node 24.19.0, TypeScript 6.0.3 and Nest 11.1.28. Python: `requires_python` against 3.12. This is the step that has caught something every time — a package outside its declared range installs with a warning and then silently degrades.

- [ ] **Step 4: Answer the five questions Tasks 2–6 depend on.** Each needs a measurement, not a reading:

  1. **Does the OTel Node SDK instrument Fastify 5 under Nest 11?** Auto-instrumentation hooks module loading; Nest's adapter may register Fastify in a way the instrumentation does not see. Prove a real HTTP request produces a span with the route attribute, not merely that the SDK starts.
  2. **Do Sentry 10 and the OTel SDK coexist?** Sentry 8+ uses OpenTelemetry internally. Determine whether they must share a `TracerProvider`, whether double-registration throws or silently produces two traces, and which order works.
  3. **Does `AsyncLocalStorage` survive the OTel context manager?** Plan 0B-1 built the request context on ALS. If OTel's context propagation replaces the async hooks, `getRequestId()` returns the sentinel inside an instrumented call — measure it, do not assume.
  4. **Do baggage and Temporal search attributes actually round-trip?** Start a workflow with a request ID as baggage and a search attribute, run an activity, and read both back on the far side.
  5. **What does Pino's `redact` do to an `Error`?** The blueprint's list uses paths like `*.password`. An `Error` serialises via its own serialiser, so confirm whether `redact` reaches `err.message` and `err.stack` at all — Task 2's carry-forward fix depends on the answer.

- [ ] **Step 5: Write ADR-0029.** House style — read `docs/adr/0027-python-toolchain.md` first. Confirm the next free number before writing; `docs/adr/README.md` ends at 0028.

  It must carry the pin table with the date measured, the range answers quoted, every exit code, the five answers above, **a stated fallback** naming the trigger measurement that would justify a different stack, and **what did not work**. A spike reporting unqualified success is the one to distrust.

- [ ] **Step 6: Destroy the spike and commit.** `rm -rf "$SPIKE"`; it must not appear in `git status`.

---

### Task 2: Pino, the redaction list, and the DSN carry-forward — **REVIEW**

**Files:** Create `apps/api/src/infrastructure/telemetry/redaction.ts`, `logger.ts`; modify `apps/api/src/shared/errors/domain-exception.filter.ts`, `bootstrap.ts`, `apps/api/package.json`. Test: `apps/api/test/redaction.test.ts`, `logger.test.ts`.

**Produces:** `REDACTION_PATHS: readonly string[]`, `REDACTION_CENSOR`, `createLogger(env): Logger`.

- [ ] **Step 1: Write the failing redaction tests first.** Cover, as **rejections**: `authorization` and `cookie` headers; `password`, `token`, `webhookSecret`; `signedUrl`, `presignedUrl`, `uploadUrl`, `downloadUrl`; `providerPayload`, `paymentPayload`; and `filename`, `originalFilename`, `projectName`.

  Two of those categories deserve an assertion that says why, because a future reader will otherwise think they are over-cautious:

  - **A signed URL in a log is a leaked model.** Redact in Pino, in structlog and in Sentry's `beforeSend`.
  - **File names and project names are customer intellectual property.** `Torre_Bacatá_Fase3_Final.stl` tells an observer what an architect is working on. The model ID is the identifier that belongs in logs.

- [ ] **Step 2: Write the test that closes the carry-forward — and note the fix is NOT configuration**

Log an `Error` whose message carries `DB_DSN=postgres://user:PASSWORD@host/db` and assert the password appears in **neither** `err.message`, `err.stack`, nor `msg` in the emitted line.

**Establish the mechanism yourself before choosing a fix — two prior readings of it were wrong, in opposite directions.**

What is settled: Pino's `redact` reaches an `Error`'s **own enumerable properties** but not `message` or `stack`, so the blueprint's `*.password`-style list leaves a secret in the message text.

Also settled, and both were wrong in earlier drafts of this plan — read ADR-0029's `CORRECTED (round 2)` markers and **[ADR-0030](../../adr/0030-nest-logger-argument-shape.md)** rather than the retracted wording:

- **`redact` DOES reach `msg`** — `paths:['msg']`, `paths:['*']` and a `msg` serialiser all do, in every call shape. What makes it unusable is that redaction is **field-granular**: it replaces the whole value, so `paths:['msg']` censors every log message in the process and `paths:['*']` additionally censors `pid`, `hostname` and every payload field. Removing a _substring_ of free text needs a pattern-matching serialiser, i.e. a secret detector rather than an allowlist. The conclusion is therefore unchanged and its reason is not: **do not put untrusted text in `msg`**, put the cause in a named field.
- **The call site is `domain-exception.filter.ts:88`**, `this.logger.error(\`Unhandled exception (requestId=…)\`, describeCause(exception))`, on a `new Logger(DomainExceptionFilter.name)`— a Nest`Logger`**with a context**, which is the detail that decides everything. Nest appends`this.context`to what it forwards, and`nestjs-pino` branches on argument count. Measured at that exact shape (ADR-0030):

  | call                     | adapter                       | where the cause lands                                |
  | ------------------------ | ----------------------------- | ---------------------------------------------------- |
  | `error(msg, cause)`      | `nestjs-pino`                 | `err.stack` — **already covered by the paths above** |
  | `error(msg, cause, ctx)` | `nestjs-pino`                 | **nowhere — silently discarded**                     |
  | `error(msg, cause)`      | hand-written raw-pino adapter | **nowhere — silently discarded**                     |
  | `error({ err }, msg)`    | **either**                    | `err.message` + `err.stack`                          |

**So: do not use the three-argument form, and do not assume a hand-written raw-pino `LoggerService` preserves the cause.** `logger.error({ err }, message)` is the shape that works under both adapters and is what Step 4 should write. Assert the cause **arrives** as well as that it is redacted — a redaction test passes trivially against a line that lost the cause.

- [ ] **Step 3: Run both, watch them fail.**

- [ ] **Step 4: Implement, then replace the filter's `Logger.error`** with the structured logger, deleting the `NOTE FOR PLAN 0C` block since it is now discharged.

- [ ] **Step 5: Mutations.** Remove each redaction path and confirm the corresponding assertion goes red; remove the `Error` serialiser and confirm the DSN test goes red. **If any leaves the suite green, say so plainly rather than adjusting the test.**

- [ ] **Step 6: Commit.**

---

### Task 3: The OTel bootstrap and the correlation chain — **REVIEW**

This is the deliverable. `docs/OBSERVABILITY.md` §2 calls it the single highest-value observability investment, and says why it must be Phase 0: retrofitting correlation means touching every log call in the codebase.

**Files:** Create `apps/api/src/infrastructure/telemetry/{tracing.ts,index.ts}`; modify `bootstrap.ts`, `src/shared/request-context/request-context.middleware.ts`, `apps/api/package.json`. Test: `apps/api/test/telemetry.integration.test.ts`.

**Consumes:** Task 1 (pins and answers), Task 2 (`createLogger`), and Plan 0B-1's `getRequestId()` / `NO_REQUEST_ID`, which is already client-unforgeable — `normaliseRequestId` rejects the sentinel case-insensitively.

- [ ] **Step 1: Write the failing correlation test.** Against the real bootstrap, assert that one HTTP request produces a log line carrying **`requestId`, `traceId` and `spanId` together**, and that `traceId` matches the span the request actually produced.

  A test asserting the fields are merely _present_ is worth little — assert the `traceId` in the log equals the one in the emitted span.

- [ ] **Step 2: Run it, watch it fail.**

- [ ] **Step 3: Implement the SDK bootstrap**, in the order ADR-0029's question 2 established for Sentry coexistence.

**Two silent failures measured by the spike, both at exit 0 — and one loud one:**

- **`SentryPropagator` alone breaks correlation.** One request becomes **three traces**, with baggage dropped on the activity leg. The fix is a composite propagator — one line that nothing else in the system would point you at, since every component reports success.
- **Registering Sentry and OTel separately is silent and kills the loser's pipeline entirely.** They must share one `TracerProvider`. Double registration does not throw; it writes to `diag`, whose default logger discards. **Install a `diag` logger in the bootstrap** or this whole class of failure is invisible.
- **Loud, and it will be the first thing you hit:** Sentry's default integrations and `@fastify/otel` both decorate a Fastify property called `opentelemetry`, so leaving the defaults on makes the app **fail to boot** with `FST_ERR_DEC_ALREADY_PRESENT`, exit 1. Use `defaultIntegrations: false` plus an explicit allowlist of the 14 error-side integrations out of 44 — the allowlist direction, not a denylist, so a Sentry release adding a span-producing integration is excluded by default. `Sentry.getDefaultIntegrations` is exported, so pin the set with a snapshot test.
- `@fastify/otel` needs the **named** import (it is CJS `export =`; a default import is `TS2351` under nodenext) and **exactly one** of `registerOnInitialization: true` or a manual `.register(instrumentation.plugin())` — both together throw `FST_ERR_DEC_ALREADY_PRESENT`.

Assert the composite propagator is in place, not just that the SDK started. A test that checks spans exist passes in all three broken states above.

- [ ] **Step 4: Bind the correlation fields into every log line**, using ADR-0029's answer to question 3 about `AsyncLocalStorage` surviving the OTel context manager.

- [ ] **Step 5: Mutations.** Break the ALS binding and confirm `requestId` falls back to the sentinel and the test goes red; remove the trace-context binding and confirm `traceId` disappears. **The correlation test must fail for the reason it names, not because the app stopped booting** — check the failure message.

- [ ] **Step 6: Commit.**

---

### Task 4: The Python side — **REVIEW**

`apps/workers` already has structlog with `REDACTED_KEYS`, an exact-equality match plus a suffix rule. This task adds OTel and binds the correlation fields.

**Files:** Create `apps/workers/packages/metrika_core/src/metrika_core/telemetry.py`; modify `logging.py`, `temporal.py`, both entry points, `metrika_core/pyproject.toml`. Test: `apps/workers/packages/metrika_core/tests/test_telemetry.py`.

- [ ] **Step 1: Write the failing test.** Assert that an activity executed against the real Temporal harness produces a log line carrying the `requestId` and `traceId` the caller sent, and that the worker's span **links to the parent trace** rather than starting a new one.

  Use the harness, not a mock. The one thing this task builds is a boundary, and 0B-3 found five defects on the last one.

- [ ] **Step 2: Run it, watch it fail.**

- [ ] **Step 3: Implement**, per ADR-0029's answer to question 4 on baggage and search attributes.

- [ ] **Step 4: Extend the redaction list to match the API's**, and add a test asserting the two lists agree. Three sinks — Pino, structlog, Sentry's `beforeSend` — with three hand-maintained copies is how one of them silently stops matching. Derive them from one source or assert equality; say which and why.

- [ ] **Step 5: Mutations.** Drop the baggage propagation and confirm the worker's span becomes a root; remove a redaction key on one side only and confirm the agreement test goes red.

- [ ] **Step 6: Commit.**

---

### Task 5: `apps/web`'s request-ID origin — SELF-VERIFIED

The chain starts in the browser. `apps/web` currently sends nothing.

**Files:** Modify `apps/web/src/app/layout.tsx` or a fetch wrapper; `apps/web/package.json`; **`pnpm-workspace.yaml`**. Test: `apps/web/test/request-id.test.ts`.

**This task owns ADR-0029 obligation 12, and it is not optional.** `@sentry/nextjs@10.70.0` reaches `@sentry/cli@2.58.6` through `@sentry/bundler-plugin-core`, which has a build script, so adding it makes a from-scratch `pnpm install` exit **1** with `ERR_PNPM_IGNORED_BUILDS` **for the whole repository**. Add `'@sentry/cli': false` to `allowBuilds` in the same commit — denial was measured safe (`pnpm install` 0, `next build` 0 with `withSentryConfig` applied; the binary is for release and source-map upload, which this plan does not do).

- [ ] **Step 1:** Generate an `X-Request-Id` per navigation and send it on outbound API calls. Format must satisfy `normaliseRequestId`'s allowlist — `[A-Za-z0-9._-]{1,128}`, and **not** the `NO_REQUEST_ID` sentinel, which the API rejects case-insensitively.

- [ ] **Step 2:** Assert the generated value passes that allowlist and that a client cannot cause the sentinel to be sent.

- [ ] **Step 3:** Wire Sentry with a `beforeSend` carrying the shared redaction list.

- [ ] **Step 4:** `pnpm verify` and `pnpm --filter @metrika/web test:e2e` both 0. Commit.

---

### Task 6: The redaction fixtures, CI and docs — **REVIEW**

**Files:** Test: a fixture per sink. Modify `.github/workflows/ci.yml` if needed, `CLAUDE.md`, `docs/{OBSERVABILITY,ROADMAP,ARCHITECTURE,LOCAL_DEVELOPMENT,INFRASTRUCTURE}.md`.

- [ ] **Step 1: One fixture per sink, asserting rejection.** This repo's rule: _a security control without a fixture asserting rejection with the correct error code is an intention, not a control._ Three sinks means three fixtures — Pino, structlog, Sentry's `beforeSend`.

- [ ] **Step 2: Prove each fires** by removing the path it guards and confirming red.

- [ ] **Step 3: Check whether a CI job is needed at all.** Measure with `turbo run <task> --dry=json` before adding one. In Plan 0B-3 the planned `workers` job turned out to be pure duplication because `verify` already scheduled everything through Turbo — the same may be true here. Record the measurement either way.

- [ ] **Step 4: Reconcile the documentation, verifying every claim against the tree.** Do not trust the existing wording — this repository has repeatedly shipped documents asserting controls that did not exist, and two plans ended with a task correcting a batch of them.

  `docs/OBSERVABILITY.md` describes the end state; mark what is built and leave the rest as target state in the honest form the repo already uses. ROADMAP 0.11, and its progress paragraph, must agree with the table.

- [ ] **Step 5: The clean-clone run.** Clone to a scratch directory, install, and run what CI runs with no `.turbo`, no build-info, no `.env`, no `.venv`. In both previous plans this surfaced something warm checkouts never showed.

- [ ] **Step 6: Commit.**

---

## Notes for the executing agent

Two ADR-0029 obligations, and where they land:

- **Obligation 12** (`'@sentry/cli': false` in `pnpm-workspace.yaml`) belongs to **Task 5**, named in its file list. It is the only new `allowBuilds` entry the whole stack needs; `protobufjs` and `@swc/core` are already there.
- **Obligation 4** — the `makeWorkflowExporter` sink and its `instrumentationLibrary` → `instrumentationScope` shim — **has no owner in this plan, and that is deliberate rather than an oversight.** No task here installs `@temporalio/interceptors-opentelemetry`: Task 3 wires `apps/api`'s SDK and Task 4 wires Python, and there is no Node Temporal **worker** in Phase 0C. The obligation lands on the phase that adds one. Its trigger is not "when a worker appears" but "when a Node worker registers workflow interceptors" — until then the pin in ADR-0029's table is a decision made early, not a dependency to install. **Whoever picks it up: the sink without the shim loses exactly the spans it exists to save, and is indistinguishable from having no sink at all except in which error text the worker logs.**

Four things this plan leaves to measurement rather than assertion:

1. ~~**The Node OTel SDK is 0.x.**~~ **Settled by Task 1, in both directions.** It instruments Fastify under Nest — `@fastify/otel@0.20.1` produces 4 route-bearing spans against the deprecated `@opentelemetry/instrumentation-fastify@0.57.0`'s 3 — so the fallback is not needed. And the premise was half wrong: the stable OTel train is on 2.10.0, only the bootstrap, exporters and instrumentations are `0.x`. The standing instruction survives unchanged for anything that _does_ fail: take the documented fallback rather than hand-writing an instrumentation layer.
2. **The DSN carry-forward is a live leak.** No task may ship an exporter or a Sentry DSN before Task 2 closes it. Wiring a sink first converts a local-only exposure into an exported one.
3. **The redaction list will exist in three places.** That is the shape that drifts. Derive or assert equality; do not maintain three copies by hand.
4. **Every guard here is a positive assertion by default** — "this field was redacted", "this ID was present". The 0B-3 boundary shipped five defects because nothing asserted the _absence_ of what should not cross. Ask of each fixture: what would it take for this to pass while the thing it guards is broken?
