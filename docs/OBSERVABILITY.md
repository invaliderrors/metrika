# Metrika — Observability

> One correlation identity across three runtimes. If a customer gives you a request ID, you can see everything that happened.

---

## 1. Stack

| Concern               | Tool                              | Why                                                                                                                |
| --------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Traces, metrics, logs | **OpenTelemetry → Grafana Cloud** | One OTLP endpoint for all three signals; generous free tier; Grafana-native as required; no vendor SDK in the code |
| Error tracking        | **Sentry** (API, web, workers)    | Grouping, release health and source maps are genuinely better than a logs-based approach                           |
| Uptime                | Grafana Synthetic Monitoring      | External probe of `/health` and the golden path                                                                    |
| Product analytics     | **PostHog**, fed by domain events | Never called from domain code                                                                                      |

OpenTelemetry rather than a vendor SDK means the backend is a configuration change, not a refactor. That optionality matters when the free tier stops being enough.

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

Temporal search attributes are what make workflows findable: `MetrikaOrganizationId`, `MetrikaModelVersionId`, `MetrikaQuoteId`, `MetrikaRequestId`. An operator investigating "what happened to this quote" queries Temporal directly by quote ID rather than grepping.

### What of the chain exists today

The diagram above is the end state. Four of its six links are built and asserted; the two that are not are the two that need a workflow, and there is no workflow yet.

| Link                                                          | State  | Where                                                                                                                                                                                             |
| ------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser generates `X-Request-Id` and sends it                 | built  | `apps/web/src/lib/request-id/`, attached by `apiFetch`                                                                                                                                            |
| API adopts or generates it; starts the root span              | built  | `request-context.middleware.ts` + `@fastify/otel`; the span JOINS an incoming `traceparent`                                                                                                       |
| Every API log line carries `requestId` + `traceId` + `spanId` | built  | `infrastructure/telemetry/tracing.ts` — the Pino instrumentation's mixin plus a `logHook` reading the request context                                                                             |
| `userId` / `organizationId` on the same line                  | **no** | there is no authentication yet (Phase 1). `organizationId` crosses as baggage when a caller supplies it, and is bound on the Python side                                                          |
| Workflow start → Temporal search attributes + memo            | **no** | no workflow exists; ADR-0029 obligation 10 provisions the attributes when one does                                                                                                                |
| Activity dispatch → OTel baggage → Python worker              | half   | the API SETS `metrika.request_id` as baggage and propagates it on every outbound call; `metrika_core.telemetry` reads it and binds it to every structlog line. Nothing dispatches an activity yet |
| API error response carries `{ error: { requestId } }`         | built  | `DomainExceptionFilter`                                                                                                                                                                           |

Four things are worth knowing before writing anything that depends on this.

**A request ID arriving is not evidence that the trace joined.** Measured on both sides: dropping baggage leaves a worker's span correctly parented and merely empties `requestId`, while dropping trace context roots the span. They are two mechanisms with two failure modes, and `apps/api/test/telemetry.integration.test.ts` asserts them apart from each other for that reason.

**Nothing exports a trace unless a deployment configures one.** `OTLP_TRACES_ENDPOINT` empty means no exporter is constructed at all; the correlation fields still reach every log line, because they come from the live trace context rather than from the exporter. `pnpm infra:up` does not start a collector.

**An empty `SENTRY_DSN` switches off the whole Sentry half, not just its transport.** `@sentry/node` does not construct a single integration for a client with no DSN, so a local run with it empty says nothing about Sentry's behaviour — including whether its default integrations would collide with `@fastify/otel` and stop the process booting, which is [ADR-0029](./adr/0029-observability-stack.md) obligation 2 and which [ADR-0033](./adr/0033-sentry-fastify-collision-measured-with-sentry-on.md) exists because a measurement missed. The integration suite runs the API against a local Sentry sink for that reason.

**The API does not honour a caller's sampling decision.** A `traceparent` arriving with the sampled flag cleared (`-00`) is joined — same trace, correct parent — and then re-sampled at `TRACES_SAMPLE_RATE`, because `SentrySampler` is parent-based only for callers that also send Sentry's own `sentry-trace`. Below a rate of `1` this cuts both ways, and a browser's sampled trace can be dropped at this hop.

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

Metrics are emitted from **one module** (`infrastructure/telemetry/metrics.ts`) exposing named, typed recorders — not scattered `counter.add()` calls. A metric with an inconsistent label set is a metric you cannot query.

---

## 5. Business KPIs

Product analytics through PostHog, fed by **domain event subscribers**, never from domain code:

```
model_uploaded · analysis_completed · units_confirmed · configuration_changed
· quote_generated · quote_accepted · checkout_started · payment_completed · order_delivered
```

Derived: upload success rate, analysis success rate, median analysis duration, slice success rate, median quote duration, **quote conversion rate** (accepted ÷ generated), average order value, gross manufacturing margin (from actuals), reprint rate, failure rate, and printer utilisation from Phase 14.

Events carry identifiers and coarse categories only. Never file names, dimensions, geometry or project names — see [SECURITY.md](./SECURITY.md#10-privacy-and-confidentiality). An analytics vendor must never be able to reconstruct what a customer is designing.

---

## 6. Dashboards and alerts

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

`live` must never check dependencies. A liveness probe that fails because Redis is slow causes ECS to kill healthy tasks and turns a degradation into an outage — a classic self-inflicted incident.

---

## 8. Performance budgets

| Surface                  | Budget              | Instrumented by                      |
| ------------------------ | ------------------- | ------------------------------------ |
| API reads p95            | < 300 ms            | OTel histogram per route             |
| API writes p95           | < 500 ms            | Same                                 |
| DB query p95             | < 50 ms             | Prisma OTel instrumentation          |
| Queries per request      | Per-endpoint budget | Prisma middleware, asserted in tests |
| Analysis p95             | < 120 s             | Activity span                        |
| Slice p95                | < 300 s             | Activity span                        |
| Upload → quote-ready p95 | < 180 s             | Workflow span                        |
| Web LCP p75              | < 2.0 s             | Vercel Speed Insights                |
| Viewer chunk             | < 400 KB gzip       | CI bundle check                      |
| Route JS (non-viewer)    | < 180 KB gzip       | CI bundle check                      |

**Instrument first, optimise second.** No performance work begins without a span or a metric showing the cost. This is stated because the temptation to optimise the 3D viewer by intuition will be strong and usually wrong.
