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

| shape                                   | `redact.paths` | `formatters.log` |
| --------------------------------------- | -------------- | ---------------- |
| `logger.info({ signedUrl }, 'm')`       | yes            | yes              |
| `logger.child({ signedUrl }).info('m')` | **yes**        | **never called** |
| `err.message` / `err.stack`             | **yes**        | non-enumerable   |
| `{ signed_url }`, `{ SIGNED_URL }`      | no             | **yes**          |
| `{ presignedUrls }`, `{ signedURLs2 }`  | no             | **yes**          |
| four levels down                        | no             | **yes**          |

`REDACTION_PATHS` is **derived from `RedactedFieldName` in code**, at **three**
depths per name — `name`, `*.name`, `*.*.name`. Not two: a Pino `*` matches
exactly one level, and `pino-http`'s default request serialiser puts headers at
`req.headers.authorization`, so stopping at two forms lets the single most
important key on the list out verbatim — which is why the superseded block above
named that path explicitly. Written out rather than derived, the list would be
fifty-one entries and would go stale the first time the shared list moved; the
point of deriving it is that it cannot.

`formatters.log` is the second traversal, and it is where `isRedactedKey` is
called. A Pino path is a literal string, so `signedUrl` does not imply
`signed_url` and no derivation of seventeen names could express the 956
spellings `redaction-corpus.json` declares; the walk matches the rule instead,
at any depth. It rebuilds rather than censoring in place (an in-place walk was
measured editing the CALLER's object), passes an `Error` through untouched
(`formatters.log` runs BEFORE `serializers`, so rebuilding one destroys the
stack frames), and rebuilds a cycle as a cycle so pino's own stringifier still
marks it `[Circular]`.

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

Two shapes the sink closes that a path list alone does not: `logger.error(err)`
with no message, where pino takes `msg` from `err.message` — a `hooks.logMethod`
rewrap puts the Error in `err` and a fixed string in `msg`; and a string in
`err`, which serialises as a scalar that `err.message` cannot match and which
ADR-0030 measured leaking under both candidate adapters.

What is **not** closed: free text a caller interpolates into `msg` themselves.
Redaction is field-granular, so `paths: ['msg']` censors every log message in the
process; removing a substring of free text needs a secret detector, which is a
weaker control than the allowlist this section chose. The rule stands: do not put
untrusted text in `msg`, put the cause in `err`.

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
