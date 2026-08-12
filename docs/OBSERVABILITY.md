# Metrika — Observability

> One correlation identity across three runtimes. If a customer gives you a request ID, you can see everything that happened.

---

## 1. Stack

| Concern           | Tool                              | Built today                                                                                | Why                                                                                                                |
| ----------------- | --------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Traces            | **OpenTelemetry → OTLP**          | **yes** — `apps/api` and `apps/workers`, exporter constructed only when an endpoint is set | One OTLP endpoint for all three signals; generous free tier; Grafana-native as required; no vendor SDK in the code |
| Metrics           | OpenTelemetry                     | **no** — §4 is target state; nothing constructs a `MeterProvider`                          | Same pipeline, same endpoint                                                                                       |
| Logs              | Pino / structlog, stdout          | **yes** as stdout JSON; **no** OTLP log pipeline — `disableLogSending: true`               | A second exporter needs a consumer, and nothing consumes one yet                                                   |
| Error tracking    | **Sentry**                        | **API and web**. NOT workers — `sentry-sdk` is deliberately not installed there            | Grouping, release health and source maps are genuinely better than a logs-based approach                           |
| Uptime            | Grafana Synthetic Monitoring      | **no**                                                                                     | External probe of `/health` and the golden path                                                                    |
| Product analytics | **PostHog**, fed by domain events | **no**                                                                                     | Never called from domain code                                                                                      |

OpenTelemetry rather than a vendor SDK means the backend is a configuration change, not a refactor. That optionality matters when the free tier stops being enough.

**Grafana Cloud is named as the destination and has never been contacted.** Both
runtimes export OTLP/HTTP to whatever `OTLP_TRACES_ENDPOINT` /
`METRIKA_WORKER_OTLP_ENDPOINT` name, and both default to empty, in which case no
exporter is constructed at all. ADR-0029 records that its spike drove the
exporters against a local receiver only, so serialisation is settled and the
endpoint, authentication, ingest and retention are not.

---

## 2. Correlation — the thing that actually matters

```
Browser generates X-Request-Id
   → API: Fastify hook adopts or generates it; starts the root span; binds to AsyncLocalStorage
   → every log line in the request carries requestId + traceId + spanId + userId + organizationId
   → workflow start: requestId and traceId become Temporal search attributes and a memo
   → activity dispatch: propagated as OTel baggage
   → Python worker: structlog binds them to every log line; spans link to the parent trace
   → API error response: { error: { requestId } }
```

A support ticket saying "my quote failed, request ID `req_01H...`" resolves to a complete distributed trace spanning the browser, the API, Temporal and two Python workers. This is the single highest-value observability investment, and it must be built in Phase 0 — retrofitting correlation IDs means touching every log call in the codebase.

Temporal search attributes are what make workflows findable: `MetrikaOrganizationId`, `MetrikaModelVersionId`, `MetrikaQuoteId`, `MetrikaRequestId`. An operator investigating "what happened to this quote" queries Temporal directly by quote ID rather than grepping. **None of them is provisioned yet** — see the gap table below.

### What of the chain exists today

The diagram above is the end state. Three of its seven links are built and
asserted, two are half-built, and two are absent. Every one of the four that is
not complete is waiting on something this phase deliberately does not build — a
feature that fetches, an authenticated user, or a workflow — rather than on more
telemetry wiring.

| Link                                                          | State  | Where                                                                                                                                                                                                                            |
| ------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser generates `X-Request-Id` and sends it                 | half   | `apps/web/src/lib/request-id/`, attached by `apiFetch` — **which nothing calls yet**. The generator and the wrapper are built and tested; no feature fetches anything, so no browser request carries the header in a running app |
| API adopts or generates it; starts the root span              | built  | `request-context.middleware.ts` + `@fastify/otel`; the span JOINS an incoming `traceparent`                                                                                                                                      |
| Every API log line carries `requestId` + `traceId` + `spanId` | built  | `infrastructure/telemetry/tracing.ts` — the Pino instrumentation's mixin plus a `logHook` reading the request context                                                                                                            |
| `userId` / `organizationId` on the same line                  | **no** | there is no authentication yet (Phase 1). `organizationId` crosses as baggage when a caller supplies it, and is bound on the Python side                                                                                         |
| Workflow start → Temporal search attributes + memo            | **no** | no workflow exists; ADR-0029 obligation 10 provisions the attributes when one does                                                                                                                                               |
| Activity dispatch → OTel baggage → Python worker              | half   | the API SETS `metrika.request_id` as baggage and propagates it on every outbound call; `metrika_core.telemetry` reads it and binds it to every structlog line. Nothing dispatches an activity yet                                |
| API error response carries `{ error: { requestId } }`         | built  | `DomainExceptionFilter`                                                                                                                                                                                                          |

Five things are worth knowing before writing anything that depends on this. Every one of them was measured after being stated wrongly first, which is why each carries its measurement rather than its conclusion.

**A request ID arriving is not evidence that the trace joined.** Measured on both sides: dropping baggage leaves a worker's span correctly parented and merely empties `requestId`, while dropping trace context roots the span. They are two mechanisms with two failure modes, and `apps/api/test/telemetry.integration.test.ts` asserts them apart from each other for that reason.

**Nothing exports a trace unless a deployment configures one.** `OTLP_TRACES_ENDPOINT` empty means no exporter is constructed at all; the correlation fields still reach every log line, because they come from the live trace context rather than from the exporter. `pnpm infra:up` does not start a collector.

**An empty `SENTRY_DSN` switches off the whole Sentry half, not just its transport.** `@sentry/node` does not construct a single integration for a client with no DSN, so a local run with it empty says nothing about Sentry's behaviour — including whether its default integrations would collide with `@fastify/otel` and stop the process booting, which is [ADR-0029](./adr/0029-observability-stack.md) obligation 2 and which [ADR-0034](./adr/0034-sampling-is-a-floor-not-a-ceiling.md) carries as a measured 2x2. The integration suite runs the API against a local Sentry sink for that reason.

**`TRACES_SAMPLE_RATE` decides only what the caller did not.** For a caller
sending only W3C trace context it is a floor, not a ceiling: a SET sampled flag
(`traceparent: …-01`) is always honoured — measured at rate `0`, those traces
exported in full — while a CLEARED flag (`-00`) reads as no decision at all and
falls through to the rate. **On Sentry's own `sentry-trace` header the caller
decides outright, in both directions, and overrides `traceparent` either way**:
measured, `sentry-trace: …-0` exports zero spans at a rate of `1` and `…-1`
exports in full at a rate of `0`. That path is live — `apps/web` ships
`@sentry/nextjs`, so a browser's client-side sample rate arrives on that header
and silently becomes this API's, including zero.
[ADR-0034](./adr/0034-sampling-is-a-floor-not-a-ceiling.md) has the W3C half,
[ADR-0035](./adr/0035-the-sampling-label-is-propagator-specific.md) the Sentry
half and why they differ.

**Two sampling behaviours are open and deliberately not worked around.** A
conformant sampled caller is dropped: `traceparent: …-03` — sampled, plus an
unknown future flag bit — gives 8 spans at rate `1` and **0 at rate `0`**,
because `getSamplingDecision` tests `traceFlags === TraceFlags.SAMPLED` strictly
while OTel parses `03` to `3`, and W3C requires unknown bits to be ignored. That
is a conformance gap in `@sentry/core`, and a local fix would put a second,
divergent sampling rule in the one place this stack has to agree with itself. The
second is latent rather than active: **`apps/web`'s Sentry sample rate can
silently govern this API's server tracing, including to zero**, by the
`sentry-trace` mechanism above. Nothing in Phase 0C sets `tracesSampleRate` in
`apps/web`, and the fix when something does is a deliberate `tracesSampler`,
which is not this phase's.

### What is wired, and what is named here but not instrumented

Five gaps are open at the end of Plan 0C. None of them is a defect in what was
built; each is a piece nothing in this phase owns, and every one of them is
invisible from a green gate — which is why they are written down rather than
left to be rediscovered.

| Gap                                                                                                                                                                                                                                         | Consequence today                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **No metrics pipeline.** Nothing constructs a `MeterProvider`, and `infrastructure/telemetry/metrics.ts` — which §4 names — does not exist                                                                                                  | every number in §4 and every alert in §6 is target state                                                                   |
| **No log pipeline.** `PinoInstrumentation` is configured `disableLogSending: true`, deliberately (ADR-0029 obligation 9)                                                                                                                    | logs are stdout JSON. Correlated, but shipped by whatever collects stdout                                                  |
| **`@prisma/instrumentation` is not installed** — ADR-0029 obligation 6 pins its version against `@prisma/client`, and no task in this plan installs it. `grep -c` over `pnpm-lock.yaml` returns 0                                           | **no database query produces a span**, so §8's `DB query p95` budget has no instrument behind it                           |
| **Buffered spans are lost on SIGTERM.** `startTelemetry` returns a `TelemetryHandle` with `forceFlush` and `shutdown`; `main.ts` discards the return value, and `app.enableShutdownHooks()` is wired to Nest's lifecycle, not to the handle | a `BatchSpanProcessor`'s unexported batch dies with the process on every deploy. The suite flushes; a deployment does not  |
| **Temporal search attributes are not provisioned.** ADR-0029 obligation 10 is undischarged across all three copies of the bring-up — `infra/docker/docker-compose.yml`, `packages/testing`'s harness, and Temporal Cloud                    | `MetrikaRequestId` and friends do not exist, so §2's "query Temporal by quote ID" is not available even once a workflow is |

---

## 3. Logging

Structured JSON everywhere. Pino (Node), structlog (Python). Never `console.log` — a lint rule enforces it.

```jsonc
{
  "level": "info", "time": "2026-08-07T14:22:31.442Z",
  "requestId": "req_01H...", "traceId": "4bf92f...", "spanId": "00f067...",
  "userId": "usr_...", "organizationId": "org_...",
  "modelVersionId": "mv_...", "workflowId": "model-processing:mv_...",
  "msg": "geometry analysis completed",
  "durationMs": 8420, "triangleCount": 1240000, "analyzerVersion": "geometry-worker@1.4.2"
}
```

### Redaction — an allowlist mindset

**The list and the rule are both defined once, in
`packages/contracts/src/redaction.ts`.** `RedactedFieldName` is a set of _field
names_, not of Pino paths: `pnpm contracts:emit` carries it into
`metrika_core.contracts` as a `StrEnum`, so the Python side reads the same list
as generated code and CI fails on a diff. `isRedactedKey` is the decision each
sink makes about a key it has reached, and all three call it.

What differs per sink is TRAVERSAL, and only traversal — Pino needs a path per
name (`password` and `*.password` are two rules), structlog walks a flat event
dict, Sentry's `beforeSend` walks an arbitrary object graph. `redaction-corpus.json`
is emitted from the rule and asserted by every sink, so a change to one without
the others goes red.

#### The sinks, counted — there are FOUR, and one of them has no control

This document, `packages/contracts/src/redaction.ts`, `metrika_core.logging` and
three ADRs all say "three sinks". Counted against the tree there are four, and
the fourth is the one with nothing in front of it:

| Sink                   | Where                                                               | Redaction | Graded by                                                                     |
| ---------------------- | ------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------- |
| Pino                   | `apps/api/src/infrastructure/telemetry/{redaction,logger}.ts`       | yes       | 956 corpus rows × six binding shapes, `apps/api/test/redaction.test.ts`       |
| structlog              | `apps/workers/…/metrika_core/logging.py`                            | yes       | the same 956 rows through the real pipeline, `tests/test_redaction_corpus.py` |
| Sentry, `apps/web`     | `apps/web/src/lib/telemetry/redaction.ts`, both `Sentry.init` calls | yes       | the same 956 rows through the walk, `apps/web/test/sentry-redaction.test.ts`  |
| **Sentry, `apps/api`** | `apps/api/src/infrastructure/telemetry/tracing.ts` `Sentry.init(…)` | **none**  | **nothing**                                                                   |

**MEASURED**, `@sentry/node@10.70.0`, at the exact option set `tracing.ts` ships
(`defaultIntegrations: false` plus the fifteen-name allowlist, a real DSN, a
capturing transport): 15 integrations constructed, `beforeSend` **undefined**, and
one envelope carrying, verbatim —

- the exception message, so `new Error('DB_DSN=postgres://user:PASSWORD@host/db')`
  ships the password. **This is the Plan 0B-1 carry-forward this plan exists to
  close, reopened against an external service**: Task 2 closed it for the log
  sink, and the Sentry sink Task 3 wired sends the same string;
- an `extra` carrying a presigned URL, `X-Amz-Signature` included;
- a `tag` carrying `Authorization: Bearer …`;
- a `context` carrying `originalFilename`.

`RequestData`, `ContextLines` and `LocalVariablesAsync` are all on the kept list,
so those are the shapes a real event acquires without any call site asking for
them. Nothing in ADR-0029–0034 names this: obligation 7 covers Pino's paths and
serialiser, and ADR-0029's own limits paragraph says only that the spike never
measured `beforeSend` because it used a stub transport.

It has **no fixture**, and by this repository's own rule that makes it not a
control but an absence of one. Closing it needs a traversal, and the honest
options are to share `apps/web`'s — which is 460 lines of measured, hostile-input
walk that must not be re-derived by hand — or to write a second one, which is the
drift `packages/contracts/src/redaction.ts` exists to prevent. **That is a task,
not a line, and it is owed before `SENTRY_DSN` is populated in any deployment of
`apps/api`.** Until it is, an empty `SENTRY_DSN` is the control.

#### The reach of the three that DO have a control is not equal

`apps/api` rebuilds the whole object graph and `apps/web` cleans an arbitrary
event to a declared depth. **`metrika_core`'s `_redact` visits the event dict's
own keys and stops.** MEASURED, through the real pipeline:
`log.info('nested', payload={'password': …})` and
`log.info('listed', items=[{'signed_url': …}])` both go out verbatim. So "one
list, three sinks" is true of the LIST and of the RULE, and stops being true of
the TRAVERSAL one level down. `tests/test_redaction_corpus.py` pins it in that
direction, so closing it starts from a red assertion; until then a Python
caller's rule is **put the sensitive field at the top level of the event, where
the control can see it.**

A second thing that side does not do at all is render exception text:
`log.exception()` emits `"exc_info": true` and nothing else. That is diagnostic
loss rather than exposure — the traceback is not written down anywhere — and it
is the mirror image of the decision `apps/api` made in `serialiseError`, where
the frames are kept and the message is censored.

**The block below is the original blueprint list, kept for the record. Do not
copy it into a Pino configuration.** It predates `RedactedFieldName` and is
wrong in two ways that a copy would inherit silently: it omits `url`, `secret`
and `fileName` entirely, and it names only the `*.`-wildcard form, so a
top-level `password` on a log record goes through untouched.

```ts
// SUPERSEDED — see `RedactedFieldName`. Retained to show what changed.
redact: {
  paths: [
    'req.headers.authorization', 'req.headers.cookie', '*.password', '*.token',
    '*.signedUrl', '*.presignedUrl', '*.uploadUrl', '*.downloadUrl',
    '*.providerPayload', '*.paymentPayload', '*.webhookSecret',
    '*.filename', '*.originalFilename', '*.projectName',
  ],
  censor: '[REDACTED]',
}
```

`apps/api`'s sink is `src/infrastructure/telemetry/{redaction,logger}.ts`, and it
has **two traversals**, because neither reaches what the other does — MEASURED
against `pino@10.3.1`:

| shape                                    | `redact.paths` | `formatters.log` |
| ---------------------------------------- | -------------- | ---------------- |
| `logger.info({ signedUrl }, 'm')`        | yes            | yes              |
| `logger.child({ signedUrl }).info('m')`  | **yes**        | **never called** |
| `logger.setBindings({ signedUrl })`      | **yes**        | **never called** |
| `err.message` / `err.stack`              | **yes**        | non-enumerable   |
| `{ signed_url }`, `{ SIGNED_URL }`       | no             | **yes**          |
| `{ presignedUrls }`, `{ signedURLs2 }`   | no             | **yes**          |
| three or more levels down                | no             | **yes**          |
| `logger.child({ signed_url }).info('m')` | **no**         | **no**           |
| `logger.setBindings({ signed_url })`     | **no**         | **no**           |

**The last two rows were leaks, and they are the same defect twice.** Each is
the product of two dimensions that were covered separately: the fixtures
asserted bindings in the canonical spelling and non-canonical spellings in a
merged object, and neither could see their combination. The first fix wrapped
`child()` — and `setBindings` leaked identically, because the fix enumerated the
mechanism it had been shown instead of the dimension it belonged to.

`createLogger` now routes **both** binding methods through the walk. `child` and
`setBindings` are the complete set: `base` is set by `createLogger` itself and a
`mixin`'s output is merged before `formatters.log` runs, so both are walked by
construction, and neither is configurable through `createLogger`. The corpus is
graded through six cells — merged, four-deep, child, grandchild, setBindings,
setBindings-deep — rather than one.

`REDACTION_PATHS` is **derived from `RedactedFieldName` in code**, at **two**
depths per name — `name` and `*.name`, which are different rules and neither
implies the other. A third (`*.*.name`) was added and removed, and both halves
are worth keeping:

- It was added because `pino-http` puts headers at `req.headers.authorization`,
  depth 3, and two forms let that header out verbatim. **That measured the paths
  in isolation, which is not the configuration that ships** — the walk reaches
  the same key at any depth. It is precisely the error ADR-0030 exists to correct
  in ADR-0029, made again one document later.
- It was not free: measured one path at a time against a `Buffer`, a bare path
  is clean, one `*.name` wildcard degrades a top-level buffer to
  `"[unable to serialize…]"`, and a `*.*.name` makes `@pinojs/redact` **throw**
  with nothing emitted. "All 53 paths load" had measured compilation, not
  traversal.

Both costs are now unreachable — the walk normalises a self-serialising value
through its own `toJSON` before the redactor sees it — so the third depth could
be restored. It is not: it is behaviourally redundant, and its failure mode when
some other exotic receiver reaches the redactor is losing the line.

`formatters.log` is the second traversal, and it is where `isRedactedKey` is
called. A Pino path is a literal string, so `signedUrl` does not imply
`signed_url` and no derivation of seventeen names could express the 956
spellings `redaction-corpus.json` declares; the walk matches the rule instead,
at any depth. It rebuilds rather than censoring in place (an in-place walk was
measured editing the CALLER's object) and rebuilds a cycle as a cycle so pino's
own stringifier still marks it `[Circular]`.

**A walk that cannot finish costs the FIELD, not the line**, and that rule is
the one the walk itself broke once. Reducing every `Error` meant reading
`.stack` and `.constructor.name` on values an application controls, and a
throwing `stack` accessor or a `constructor` defined as `undefined` propagated
straight out of `logger.info()` for **zero lines emitted** — from inside
`DomainExceptionFilter`'s `catch`, the one place in this system that must never
lose a line, and the exact failure mode the third redact depth had just been
removed for. Each top-level entry is now walked inside its own boundary, and the
individual reads are probed so the common cases degrade to one censored value
rather than one censored field. Two declared costs sit behind that boundary: a
`toJSON` that never terminates, and nesting deeper than the stack (~4,600, where
baseline pino survives 200,000). Both censor the field and emit the line, so
`requestId` and `traceId` survive whatever the payload does.

**The memo records the OUTCOME, not the visit** — the same lesson `apps/web`'s
sink learned, reached here from the opposite direction. The boundary that stopped
the walk losing the LINE gave it a way to lose a FIELD in silence: a node shared
between two entries kept the half-built copy the failed entry abandoned, so
`{ outer: { shared }, later: shared }` emitted
`"outer":"[REDACTED]","later":{"first":"A"}` — `second` gone, no censor beside
it, and `later` reading as complete. Nodes are now marked in progress on the way
down, and a failed entry overwrites every node it abandoned with the censor, so a
later alias reads a refusal rather than a plausible fragment. Memoisation itself
still applies: an aliased node that walks cleanly is emitted in full at both
keys, as baseline pino does.

**`err` is a POSITION, not a type — and the position set is six keys wide.**
Reducing `Error` instances everywhere still let `{ ctx: { err: { message: DSN } } }`
out verbatim: an error-shaped plain object, which is what a worker's deserialised
error looks like and the shape the `msg` guard cannot test with `instanceof`.
Reducing at `err` alone then still let these out, through a merged object,
`child()` and `setBindings()` alike:

```jsonc
{ "errs":   [{ "message": "…PASSWORD…" }] }
{ "errors": [{ "message": "…PASSWORD…" }] }
{ "error":  {  "message": "…PASSWORD…"  } }
{ "ctx": { "cause": { "message": "…PASSWORD…" } } }
```

`errors` is `AggregateError`'s own property name and `cause` is `Error`'s, so the
positions are `err`, `error`, `errors`, `errs`, `cause`, `exception`. Arrays are
mapped element by element, because "two things failed" is the part of an
aggregate worth reading.

**`err` is treated more strictly than the other five, deliberately.** A STRING at
`err` is reduced — ADR-0030 measured one leaking in full, and it is pino's
designated error slot. A string at the other five is left alone, because they are
ordinary English words with ordinary values: `cause: 'user_cancelled'` and
`errors: 3` are real fields, and a control that turns a status enum into
`{ type: 'string' }` buys safety with debuggability. The cost is asserted beside
the widening, the way `packages/contracts`' own `MUST_SURVIVE` table does.

The top-level `err` is left whole because pino's own serialiser reduces it,
measured for an Error, a plain object and a string through all three binding
routes and pinned by a test.

**A child may not override `redact`, `serializers` or `formatters`.** Each
switches off part of the control for that child and everything descended from
it — `{ formatters: { log } }` was measured letting a `signed_url` out verbatim.
`child()` rejects them with a named error rather than documenting the hazard: it
is called at wiring time, so the throw is a boot failure, and a control any
caller can switch off with an options bag is not a control. The test is `in`
rather than `Object.hasOwn`, because pino reads `options.redact` as a plain
property and an option hidden on a prototype reached it while `hasOwn` said it
was absent.

One derived path has a cost that was decided rather than discovered: `*.url`
reaches `req.url` under `pino-http`'s default request serialiser, so every
request line would lose its path. The answer is for `apps/api` to emit the
request path under a name that is not `url` — `requestPath`, asserted in
`apps/api/test/redaction.test.ts` — not to drop `url` from the shared list,
which would narrow a control that was widened deliberately after `download_url`,
`s3_url` and `upload_url` were measured going through untouched.

### What an operator is left with after the control fires

ADR-0029 obligation 7 redacts `err.message` **and** `err.stack`, and applied
literally that is the whole of an unhandled 500: `{"type":"Error","message":
"[REDACTED]","stack":"[REDACTED]"}`. An `Error` happened; nothing else survives —
barely better than the zero bytes that log line was added to prevent.

A stack is `<message>` followed by its frames. **The secret is in the message;
the frames are file paths and function names.** So `serialiseError` emits a fixed
four-field shape — `type`, a censored `message`, a censored `stack`, and
`frames`, the `    at …` lines with the message line filtered out (filtered, not
`slice(1)`, because a message may itself contain newlines). Measured against the
real `DomainExceptionFilter`: 0 frames under obligation 7 as written, the real
throw site with the serialiser, and no leak either way. A thrown non-`Error` gets
**no** frames — `toLoggableError` blanks the synthesised stack, because the only
frames available point at the logger.

The error's own properties are dropped rather than left to a path: `*.password`
reaches `err.password` today and stops the day the error is nested one level
deeper, and no allowlist can reach a free-text `err.detail`.

**pino derives `msg` from the error, and it does so in two branches.** A
`hooks.logMethod` rewrap stops both, and the guard is `pino/lib/proto.js`'s own
`write()` transcribed rather than approximated — a message is supplied whenever
pino would otherwise have taken one from `errorKey`:

```js
} else if (_obj instanceof Error) {
  obj = { [errorKey]: _obj }
  if (msg === undefined) msg = _obj.message
} else {
  obj = _obj
  if (msg === undefined && _obj[messageKey] === undefined && _obj[errorKey]) {
    msg = _obj[errorKey].message
  }
}
```

The first version of the hook implemented the first branch only. **The second is
the shape ADR-0030 prescribes** — `logger.error({ err })` with the message
argument left off — and it emitted a perfectly censored `err` beside a `msg`
carrying the whole DSN. Note that pino requires only that `_obj[errorKey]` be
truthy and then reads `.message` off it, so an `instanceof` guard could never
have covered it: `{ err: { message } }`, which is what a deserialised worker
error looks like, leaks too.

The other shape a path list alone does not close is a **string** in `err`: it
serialises as a scalar that `err.message` cannot match, which ADR-0030 measured
leaking under both candidate adapters.

What is **not** closed is the message field itself, and the class is wider than
it first looks. There are three routes into it — the second argument, an
interpolation, and a `msg` key in the merged object, which pino uses verbatim —
and all three leak. Redaction is field-granular, so `paths: ['msg']` censors
every log message in the process; removing a substring of free text needs a
secret detector, a weaker control than the allowlist this section chose. The rule
is therefore about the FIELD, not about one argument: nothing untrusted goes in
`msg` — put the cause in `err`. A fixture asserts the `{ msg }` route so the gap
is declared rather than discovered.

Two categories deserve comment:

- **Signed URLs are credentials.** A signed URL in a log is a leaked model. They are redacted in Pino, in structlog, and in Sentry's `beforeSend`.
- **File names and project names are customer intellectual property.** "Torre_Bacatá_Fase3_Final.stl" in a log tells an observer what an architect is working on. They are redacted; the model ID is the identifier used in logs.

Levels: `error` for unexpected failures (Sentry event); `warn` for expected domain failures worth watching (slicing failed, payment declined); `info` for lifecycle events; `debug` off in production.

---

## 4. Metrics

> **TARGET STATE — none of this is built.** Nothing in the repository constructs
> a `MeterProvider`, emits a counter or a histogram, or exports metrics over
> OTLP. Plan 0C built the correlation spine and the redaction control and
> deliberately stopped there: metrics, dashboards and alerts need a running
> system with real traffic to be worth anything. §4, §5 and §6 are the design to
> build against, not a description of the tree.

### Golden signals

`http_server_duration` (histogram, by route and status), `http_server_errors`, `db_query_duration`, `db_pool_utilization`, `temporal_workflow_duration`, `temporal_activity_failures`, `temporal_task_queue_depth`.

### Domain metrics — the ones that describe the business

| Metric                                      | Type      | Alert                                          |
| ------------------------------------------- | --------- | ---------------------------------------------- |
| `metrika_upload_total{result}`              | counter   | Success rate < 97% over 1 h                    |
| `metrika_analysis_duration_seconds`         | histogram | p95 > 120 s                                    |
| `metrika_analysis_total{result}`            | counter   | Success rate < 95%                             |
| `metrika_slice_duration_seconds`            | histogram | p95 > 300 s                                    |
| `metrika_slice_total{result,cached}`        | counter   | Success rate < 95%                             |
| `metrika_slice_cache_hit_ratio`             | gauge     | Sudden drop — a key input changed unexpectedly |
| `metrika_quote_duration_seconds`            | histogram | p95 > 180 s (upload → quote ready)             |
| `metrika_quote_total{result}`               | counter   | —                                              |
| `metrika_model_triangles`                   | histogram | Distribution shift → capacity planning         |
| `metrika_units_ambiguous_ratio`             | gauge     | Rising → the inference heuristic is degrading  |
| `metrika_payment_total{provider,result}`    | counter   | Failure rate > 10%                             |
| `metrika_workflow_failures_total{workflow}` | counter   | Any sustained increase                         |
| `metrika_estimate_deviation_ratio{profile}` | histogram | **median deviation > 15% — margin is eroding** |

That last metric is the one that protects the business. It exists from Phase 11 and is the closing of the loop described in [PRICING_ENGINE.md](./PRICING_ENGINE.md#10-calibration--closing-the-loop-with-reality).

Metrics will be emitted from **one module** (`infrastructure/telemetry/metrics.ts`, which does not exist yet) exposing named, typed recorders — not scattered `counter.add()` calls. A metric with an inconsistent label set is a metric you cannot query.

---

## 5. Business KPIs

> **TARGET STATE — not built.** PostHog is not a dependency of any package and no
> domain event exists to feed it.

Product analytics through PostHog, fed by **domain event subscribers**, never from domain code:

```
model_uploaded · analysis_completed · units_confirmed · configuration_changed
· quote_generated · quote_accepted · checkout_started · payment_completed · order_delivered
```

Derived: upload success rate, analysis success rate, median analysis duration, slice success rate, median quote duration, **quote conversion rate** (accepted ÷ generated), average order value, gross manufacturing margin (from actuals), reprint rate, failure rate, and printer utilisation from Phase 14.

Events carry identifiers and coarse categories only. Never file names, dimensions, geometry or project names — see [SECURITY.md](./SECURITY.md#10-privacy-and-confidentiality). An analytics vendor must never be able to reconstruct what a customer is designing.

---

## 6. Dashboards and alerts

> **TARGET STATE — not built.** No Grafana workspace is provisioned, no alert
> rule exists, and `docs/runbooks/` does not exist. Every row below depends on
> §4, which is also target state.

Four dashboards: **Platform Health** (golden signals, error budget), **Pipeline** (the funnel from upload to quote-ready with drop-off at each stage), **Business** (conversion, order value, margin), **Cost** (Fargate hours, S3 growth, Temporal actions, slice-cache savings).

Alert routing is deliberately narrow, because a solo operator with a noisy pager stops reading it:

| Severity     | Examples                                                                                                  | Route             |
| ------------ | --------------------------------------------------------------------------------------------------------- | ----------------- |
| **Page**     | API down, database unreachable, payment webhooks failing, workflow failure rate spike                     | Push notification |
| **Ticket**   | Analysis success rate degraded, slicer regression failed, estimate deviation over threshold, cost anomaly | Daily digest      |
| **Log only** | Individual expected failures                                                                              | Dashboards        |

Every alert names a runbook in `docs/runbooks/`. An alert without a documented response is noise with a siren.

---

## 7. Health checks

```
GET /health/live     → process is up. No dependency checks. Used by ECS
GET /health/ready    → DB, Redis, S3, Temporal reachable. Used by the load balancer
GET /health/deep     → authenticated; per-dependency latency. Used by monitoring
```

All three routes exist. **`ready` and `deep` check ONE dependency today** —
Postgres, with a real `SELECT 1` round trip and its measured `latencyMs`, not a
connection check. `checkAll()` in `modules/health/health.service.ts` returns a
single-element list because Postgres is the only thing `apps/api` connects to;
Redis, S3 and Temporal join it when a module needs them.

`live` must never check dependencies. A liveness probe that fails because Redis is slow causes ECS to kill healthy tasks and turns a degradation into an outage — a classic self-inflicted incident.

---

## 8. Performance budgets

**Every "instrumented by" below is target state**, including the two that read as
though they already exist: there is no metrics pipeline (§4), and
`@prisma/instrumentation` is **not installed** — ADR-0029 obligation 6 pins its
version against `@prisma/client` and no task has owned installing it, so no
database query produces a span today.

| Surface                  | Budget              | Instrumented by                                                |
| ------------------------ | ------------------- | -------------------------------------------------------------- |
| API reads p95            | < 300 ms            | OTel histogram per route — needs §4                            |
| API writes p95           | < 500 ms            | Same                                                           |
| DB query p95             | < 50 ms             | Prisma OTel instrumentation — **the package is not installed** |
| Queries per request      | Per-endpoint budget | Prisma middleware, asserted in tests                           |
| Analysis p95             | < 120 s             | Activity span                                                  |
| Slice p95                | < 300 s             | Activity span                                                  |
| Upload → quote-ready p95 | < 180 s             | Workflow span                                                  |
| Web LCP p75              | < 2.0 s             | Vercel Speed Insights                                          |
| Viewer chunk             | < 400 KB gzip       | CI bundle check                                                |
| Route JS (non-viewer)    | < 180 KB gzip       | CI bundle check                                                |

**Instrument first, optimise second.** No performance work begins without a span or a metric showing the cost. This is stated because the temptation to optimise the 3D viewer by intuition will be strong and usually wrong.
