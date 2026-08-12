# ADR-0029 — The OpenTelemetry + Sentry + Pino stack, and its pins

**Status:** Accepted · **Date:** 2026-08-12 · **Scopes** the observability half
of Phase 0 ([ROADMAP](../ROADMAP.md) row 0.11) by pinning what
[`OBSERVABILITY.md`](../OBSERVABILITY.md) §1–§3 names without versions.

> **On the number.** `docs/adr/README.md` ended at
> [0028](./0028-temporal-bind-on-ip.md) and `docs/adr/` on disk ended at the
> same file, so this is 0029 with no gap. Both were checked before writing,
> because [ADR-0021](./0021-next-major-and-frontend-stack.md) was written as
> 0020, found the number taken, and carries a note about it.

## Context

[`OBSERVABILITY.md`](../OBSERVABILITY.md) §1 names OpenTelemetry, Sentry, Pino
and structlog, and §2 makes one promise the whole plan rests on: a request ID
resolves to a trace spanning the browser, the API, Temporal and two Python
workers. Nothing in that document carries a version. Plan 0C Tasks 2–6 install
roughly thirty packages across two languages, and a pin chosen ad hoc inside one
of those tasks is a pin nobody reviewed.

Two specific hazards made a spike worth more than the usual amount here.

**The Node OpenTelemetry SDK is widely described as 0.x, and this is half
true** — see the next section, because the half that is false changes what a
version bound means. This repository has lost a whole class of checking twice to
the softer failure, a dependency that installs, warns, and then silently does
less than it appears to: TypeScript outside `typescript-eslint`'s peer range
disabled every type-aware rule with no error
([ADR-0021](./0021-next-major-and-frontend-stack.md)), and
`eslint-plugin-react`'s range excluded the pinned ESLint major
([ADR-0023](./0023-eslint-plugin-resolution.md)).

**Sentry 8+ is itself built on OpenTelemetry.** Two SDKs that both want to own
the global `TracerProvider`, context manager and propagator either integrate or
fight, and finding out in Task 3 is expensive.

Because an install exiting 0 is weak evidence, each question was additionally
exercised for the shape it would take _if it silently did nothing_: an SDK that
starts and produces no route attribute, a second SDK whose registration is
ignored, a context manager that replaces the async hooks the request context
runs on, a propagator that carries a trace id and drops baggage, and a redaction
list that covers every field except the two that actually leak.

The spike ran in a throwaway directory outside the workspace (`mktemp -d`) on
Node 24.19.0, pnpm 11.20.0, TypeScript 6.0.3, uv 0.12.3 and CPython 3.12.13,
against a real `temporalio/auto-setup:1.29.7` and `postgres:16-alpine` in Docker
on their own network, all of which were destroyed afterwards. The repository's
own four containers were left running. Exit codes were read from `$?`
immediately after each command — see "What did not work", because the first one
was not, and it lied.

### The 0.x premise, corrected

OpenTelemetry JS split its release trains. The **stable** packages are past 1.0
and are on **2.10.0**; the **experimental** ones are still `0.x` and are on
`0.221.0`, with the instrumentations on their own `0.x` lines.

| Train                                | Packages                                                                                                             | Version     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ----------- |
| API                                  | `@opentelemetry/api`                                                                                                 | `1.9.1`     |
| Stable SDK (**not** 0.x)             | `core`, `resources`, `sdk-trace-base`, `sdk-trace-node`, `sdk-metrics`, `context-async-hooks`, `propagator-b3`       | `2.10.0`    |
| Experimental (**0.x**)               | `sdk-node`, `instrumentation`, every `exporter-*`, `sdk-logs`, `api-logs`                                            | `0.221.0`   |
| Instrumentations (**0.x**, per-line) | `instrumentation-fastify` `0.57.0`, `-nestjs-core` `0.67.0`, `-pino` `0.67.0`, `-undici` `0.31.0`, `-http` `0.221.0` | independent |

So the tracing core this project's correlation property depends on is **not**
pre-1.0; the bootstrap (`sdk-node`), the exporters and every instrumentation
are. That is the correct thing to be nervous about, and it is narrower than the
premise the plan started from.

### Registry state, measured 2026-08-12

`npm view <pkg> version` and the PyPI JSON API. "Direct" means a declared
dependency of the named app rather than something another package brings
transitively.

#### Node — `apps/api`

| Package                                      | Latest    | **Pin**      | Direct?                                               |
| -------------------------------------------- | --------- | ------------ | ----------------------------------------------------- |
| `@opentelemetry/api`                         | `1.9.1`   | `1.9.1`      | yes (dep)                                             |
| `@opentelemetry/sdk-node`                    | `0.221.0` | `0.221.0`    | yes (dep)                                             |
| `@opentelemetry/core`                        | `2.10.0`  | `2.10.0`     | yes (dep) — `CompositePropagator`                     |
| `@opentelemetry/resources`                   | `2.10.0`  | `2.10.0`     | yes (dep) — `resourceFromAttributes`                  |
| `@opentelemetry/context-async-hooks`         | `2.10.0`  | `2.10.0`     | yes (dep) — **mandatory**, see Decision               |
| `@opentelemetry/sdk-trace-base`              | `2.10.0`  | `2.10.0`     | yes (dep) — processor types, test exporters           |
| `@opentelemetry/semantic-conventions`        | `1.43.0`  | `1.43.0`     | yes (dep)                                             |
| `@opentelemetry/instrumentation`             | `0.221.0` | `0.221.0`    | yes (dep) — `hook.mjs`                                |
| `@opentelemetry/instrumentation-http`        | `0.221.0` | `0.221.0`    | yes (dep)                                             |
| `@opentelemetry/instrumentation-undici`      | `0.31.0`  | `0.31.0`     | yes (dep) — **mandatory**, see below                  |
| `@opentelemetry/instrumentation-fastify`     | `0.57.0`  | `0.57.0`     | yes (dep) — **deprecated on npm**                     |
| `@opentelemetry/instrumentation-nestjs-core` | `0.67.0`  | `0.67.0`     | yes (dep)                                             |
| `@opentelemetry/instrumentation-pino`        | `0.67.0`  | `0.67.0`     | yes (dep)                                             |
| `@opentelemetry/exporter-trace-otlp-http`    | `0.221.0` | `0.221.0`    | yes (dep)                                             |
| `@opentelemetry/exporter-metrics-otlp-http`  | `0.221.0` | `0.221.0`    | yes (dep)                                             |
| `@opentelemetry/exporter-logs-otlp-http`     | `0.221.0` | `0.221.0`    | yes (dep)                                             |
| `@prisma/instrumentation`                    | `7.9.1`   | **`6.19.3`** | yes (dep) — tracks `@prisma/client`, not npm `latest` |
| `@sentry/node`                               | `10.70.0` | `10.70.0`    | yes (dep)                                             |
| `@sentry/nestjs`                             | `10.70.0` | `10.70.0`    | yes (dep)                                             |
| `@sentry/opentelemetry`                      | `10.70.0` | `10.70.0`    | yes (dep) — **direct**, see Decision                  |
| `pino`                                       | `10.3.1`  | `10.3.1`     | yes (dep)                                             |
| `pino-http`                                  | `11.0.0`  | `11.0.0`     | yes (dep)                                             |
| `@temporalio/client`                         | `1.22.0`  | `1.22.0`     | yes (dep)                                             |
| `@temporalio/worker`                         | `1.22.0`  | `1.22.0`     | yes (dep)                                             |
| `@temporalio/workflow`                       | `1.22.0`  | `1.22.0`     | yes (dep)                                             |
| `@temporalio/activity`                       | `1.22.0`  | `1.22.0`     | yes (dep)                                             |
| `@temporalio/common`                         | `1.22.0`  | `1.22.0`     | yes (dep)                                             |
| `@temporalio/interceptors-opentelemetry`     | `1.22.0`  | `1.22.0`     | yes (dep) — **drags OTel 1.x**, see below             |

Transitives that matter, because a duplicate or an unexpected major is what
breaks a build rather than a direct pin:

| Package (transitive)                                   | Resolved           | Arrives via                              |
| ------------------------------------------------------ | ------------------ | ---------------------------------------- |
| `@opentelemetry/sdk-trace-node` / `sdk-metrics`        | `2.10.0`           | `sdk-node`                               |
| `@opentelemetry/sdk-logs` / `api-logs`                 | `0.221.0`          | `sdk-node`                               |
| `@opentelemetry/core` / `resources` / `sdk-trace-base` | **`1.30.1`**       | `@temporalio/interceptors-opentelemetry` |
| `@opentelemetry/instrumentation`                       | `0.220.0`          | `@sentry/node`, `@sentry/nestjs`         |
| `@opentelemetry/instrumentation`                       | `0.213.0`          | `@opentelemetry/instrumentation-fastify` |
| `@grpc/grpc-js` → `protobufjs`                         | `1.14.4` → `7.6.5` | `sdk-node`'s OTLP **gRPC** exporters     |
| `@swc/core`                                            | `1.15.47`          | `@temporalio/worker`                     |
| `import-in-the-middle`                                 | `^3.0.0`           | `@sentry/node`                           |

**Six physical copies of OTel SDK packages** end up in the tree: `core`,
`resources` and `sdk-trace-base` at both `2.10.0` and `1.30.1`, plus three
copies of `@opentelemetry/instrumentation`. `pnpm peers check` reports **"No
peer dependency issues found"** anyway, which is correct and is exactly why it
is not sufficient on its own. The 1.x copies are load-bearing at compile time —
see "What did not work".

#### Node — `apps/web`

| Package          | Latest    | **Pin**   | Direct?   |
| ---------------- | --------- | --------- | --------- |
| `@sentry/nextjs` | `10.70.0` | `10.70.0` | yes (dep) |

#### Python — `apps/workers`

| Package                                    | Latest   | **Pin**  | Direct?                                     |
| ------------------------------------------ | -------- | -------- | ------------------------------------------- |
| `opentelemetry-api`                        | `1.44.0` | `1.44.0` | yes (dep)                                   |
| `opentelemetry-sdk`                        | `1.44.0` | `1.44.0` | yes (dep)                                   |
| `opentelemetry-exporter-otlp-proto-http`   | `1.44.0` | `1.44.0` | yes (dep)                                   |
| `opentelemetry-semantic-conventions`       | `0.65b0` | `0.65b0` | **no** — pinned `==` by `opentelemetry-sdk` |
| `opentelemetry-exporter-otlp-proto-common` | `1.44.0` | `1.44.0` | **no** — from the exporter                  |
| `opentelemetry-proto`                      | `1.44.0` | `1.44.0` | **no** — from the exporter                  |
| `googleapis-common-protos`                 | `1.75.1` | `1.75.1` | **no** — from the exporter                  |
| `requests`                                 | `2.34.2` | `2.34.2` | **no** — from the HTTP exporter             |
| `sentry-sdk`                               | `2.67.1` | `2.67.1` | yes (dep)                                   |
| `structlog`                                | `26.1.0` | `26.1.0` | yes (dep) — already pinned by ADR-0027      |
| `temporalio`                               | `1.31.0` | `1.31.0` | yes (dep) — already pinned by ADR-0027      |

`opentelemetry-semantic-conventions` resolving to **`0.65b0`** — a beta version
string — is normal for that package and is pinned with `==` by
`opentelemetry-sdk==1.44.0` itself. It is recorded so nobody "fixes" it.

**`opentelemetry-exporter-otlp-proto-http`, not `-grpc`.** The gRPC exporter
pulls `grpcio`, which is a compiled extension with a per-platform wheel matrix,
into a worker image that has no other need for it. The HTTP exporter's extra
weight is `requests`. Nothing measured here required gRPC.

**Not `temporalio[opentelemetry]`.** The extra resolves to
`opentelemetry-api<2,>=1.11.1` and `opentelemetry-sdk<2,>=1.11.1` — a floor, not
a pin, on two packages this table already names exactly. Declaring them directly
keeps one source of truth for the version.

### Ranges, checked before installing

This is the step that has caught something every time.

**Node `engines`.** Every `@opentelemetry/*` package declares
`"node": "^18.19.0 || >=20.6.0"`; `@sentry/*` declares `">=18"`;
`@temporalio/interceptors-opentelemetry` declares `">= 20.3.0"`. Node **24.19.0
is in range** for all of them, and nothing declares an upper bound that excludes
Node 24.

**Peer dependencies.** No package in the set declares a `typescript` peer at
all, so TypeScript 6.0.3 is unconstrained here — this stack cannot repeat
ADR-0021's failure, and that is a property of the metadata rather than luck.

| Package                                  | Declared peers                                                                                        | Verdict                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `@opentelemetry/sdk-node@0.221.0`        | `@opentelemetry/api": ">=1.3.0 <1.10.0"`                                                              | `1.9.1` **in range** — note the upper bound        |
| `@opentelemetry/sdk-metrics@2.10.0`      | `@opentelemetry/api": ">=1.9.0 <1.10.0"`                                                              | `1.9.1` **in range** — the tightest floor          |
| `@opentelemetry/instrumentation-*`       | `@opentelemetry/api": "^1.3.0"` (`^1.7.0` for undici)                                                 | **in range**                                       |
| `@prisma/instrumentation@6.19.3`         | `@opentelemetry/api": "^1.8"`                                                                         | **in range**                                       |
| `@sentry/opentelemetry@10.70.0`          | `api "^1.9.0"`, `core "^1.30.1 \|\| ^2.1.0"`, `sdk-trace-base "^1.30.1 \|\| ^2.1.0"`                  | **in range** on `2.10.0`                           |
| `@sentry/nestjs@10.70.0`                 | `@nestjs/core` and `@nestjs/common`: `"^8 \|\| ^9 \|\| ^10 \|\| ^11.0.0"`                             | Nest `11.1.28` **in range**                        |
| `@sentry/nextjs@10.70.0`                 | `next": "^13.2.0 \|\| ^14.0 \|\| ^15.0.0-rc.0 \|\| ^16.0.0-0"`                                        | Next `16.3.0` **in range**                         |
| `@temporalio/interceptors-opentelemetry` | `@temporalio/common": "1.22.0"`, `@temporalio/workflow": "1.22.0"` — **exact, not a range**           | **in range**, and pins the whole `@temporalio` set |
| `nestjs-pino@4.6.1` (not installed)      | `pino "^7 \|\| ^8 \|\| ^9 \|\| ^10.0.0"`, `pino-http "… \|\| ^11.0.0"`, `@nestjs/common "… \|\| ^11"` | in range — recorded so the option stays open       |

**`@opentelemetry/api` has a hard upper bound of `<1.10.0` in nearly every SDK
package's peer range, and `1.9.1` is the current release.** That is the one
range in this table doing real work: the day `@opentelemetry/api@1.10.0`
publishes, an unpinned install crosses it and `pnpm peers check` starts
reporting against every SDK package at once. It is the trigger measurement in
the fallback table below rather than a footnote.

`pnpm peers check` was run after a cold install and again after the
`@temporalio/*` set was added: **"No peer dependency issues found"** both times.
Zero unmet peers is a better result than ADR-0021's three, and it is worth
saying explicitly that it does not cover the two things that actually broke here
— a deprecation and a major-version split inside a dependency's own tree.

**Python `requires_python`**, answered per package from PyPI metadata **before**
`uv add` was run:

| Package                                    | `requires_python` | Classifiers | 3.12   | 3.13   | 3.14 |
| ------------------------------------------ | ----------------- | ----------- | ------ | ------ | ---- |
| `opentelemetry-api` / `-sdk`               | `>=3.10`          | 3.10 – 3.14 | **in** | **in** | in   |
| `opentelemetry-semantic-conventions`       | `>=3.10`          | 3.10 – 3.14 | **in** | **in** | in   |
| `opentelemetry-exporter-otlp-proto-http`   | `>=3.10`          | 3.10 – 3.14 | **in** | **in** | in   |
| `opentelemetry-exporter-otlp-proto-common` | `>=3.10`          | 3.10 – 3.14 | **in** | **in** | in   |
| `opentelemetry-proto`                      | `>=3.10`          | 3.10 – 3.14 | **in** | **in** | in   |
| `googleapis-common-protos`                 | `>=3.10`          | 3.10 – 3.14 | **in** | **in** | in   |
| `requests`                                 | `>=3.10`          | 3.10 – 3.15 | **in** | **in** | in   |
| `urllib3`                                  | `>=3.10`          | 3.10 – 3.14 | **in** | **in** | in   |
| `sentry-sdk`                               | `>=3.6`           | 3.6 – 3.14  | **in** | **in** | in   |
| `structlog`                                | `>=3.10`          | 3.10 – 3.15 | **in** | **in** | in   |

**No package excludes 3.12**, and none introduces a lower bound tighter than
`numpy@2.5.2`'s `>=3.12`, which ADR-0027 already identified as the binding
constraint. Nothing here moves the interpreter decision.

**All four Python packages ship `py.typed`** — `opentelemetry`, `sentry_sdk`,
`structlog`, `temporalio`. This is the check ADR-0027 obligation 3 exists
because of (`boto3` ships none, and `mypy --strict` degrades the whole S3
surface to `Any` without stubs). No stub package is needed on this side.

### Gate results

Exit codes read from `$?` immediately after each command, never off a pipe.

| Gate                                                           | Exit  | Evidence beyond the exit code                                                                        |
| -------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------- |
| `pnpm install`, 29 packages, no `allowBuilds`                  | **1** | `ERR_PNPM_IGNORED_BUILDS: protobufjs@7.6.5` — see "What did not work"                                |
| `pnpm install`, with `allowBuilds`                             | **0** | 176 packages; **one** `[WARN] deprecated` line, on `instrumentation-fastify`                         |
| `pnpm install`, after adding the six `@temporalio/*`           | **1** | `ERR_PNPM_IGNORED_BUILDS: @swc/core@1.15.47`; **0** once denied                                      |
| `pnpm peers check` (both installs)                             | **0** | "No peer dependency issues found"                                                                    |
| `pnpm exec tsc` on the spike sources                           | **0** | after two `as unknown as` casts at the Temporal/OTel boundary — see below                            |
| the same, **without** those casts                              | **2** | `TS2769`, `Property 'instrumentationScope' is missing` — a hard error, not a warning                 |
| real `GET /things/:id` through Nest 11 + Fastify 5             | **0** | **10 spans**, 3 carrying `http.route: "/things/:id"`, 9 of them on one trace                         |
| the same with the ESM loader hook **disabled**                 | **0** | byte-identical span set — the hook is not load-bearing today; see below                              |
| outbound `fetch()` without `instrumentation-undici`            | **0** | **no span at all** — measured, not assumed                                                           |
| outbound `fetch()` with `instrumentation-undici@0.31.0`        | **0** | 11 spans; scope `@opentelemetry/instrumentation-undici` present                                      |
| `Sentry.init()` → `NodeSDK.start()`                            | **0** | **3 diag ERRORs**; OTel's exporter receives **0 spans**                                              |
| `NodeSDK.start()` → `Sentry.init()`                            | **0** | 1 diag ERROR; Sentry emits **0 transaction envelopes**, errors still delivered                       |
| `skipOpenTelemetrySetup: true` + one `NodeSDK`                 | **0** | both pipelines populated; trace ids agree; only benign diag noise                                    |
| the same, Sentry's default integrations left on                | **0** | **19 spans for one request** instead of 10, one named `GET /things/abc123`                           |
| the same, span-producing Sentry integrations trimmed           | **0** | back to **10 spans**, identical to the OTel-only run                                                 |
| `getRequestId()` at 7 probes inside an instrumented request    | **0** | **0 of 7 lost**, under both plain OTel and Sentry's wrapped context manager                          |
| Temporal round trip, W3C propagators                           | **0** | one trace across client → workflow → Node activity → **Python activity**; baggage intact at all four |
| the same with `SentryPropagator` alone                         | **0** | **three different traces**; baggage `null` at the Node activity                                      |
| the same with `CompositePropagator([W3C, W3CBaggage, Sentry])` | **0** | one trace again, baggage intact at all four                                                          |
| `MetrikaRequestId` read back by `ListWorkflowExecutions`       | **0** | query `MetrikaRequestId = '…'` returns the started workflow                                          |
| Temporal worker **without** the `exporter` sink                | **0** | `[ERROR] Workflow referenced an unregistered external sink` ×3; `RunWorkflow` span never exported    |
| Temporal worker **with** the sink                              | **0** | 0 such errors; `RunWorkflow:spikeWorkflow` and both `StartActivity` spans exported                   |
| Pino `redact`, the blueprint list, `{ err }`                   | —     | `err.message` **LEAKED**, `err.stack` **LEAKED**, `err.password`/`projectName`/`signedUrl` redacted  |
| Pino `redact`, blueprint list + `err.message`/`err.stack`      | —     | nothing leaked                                                                                       |
| `logger.error(error.stack)` — the filter's shape today         | —     | leaked in `msg`; **no redact path can reach it**                                                     |
| `uv add` (6 Python packages)                                   | **0** | 20 packages, **zero resolution warnings**                                                            |
| Python `sentry_sdk.init()` then `set_tracer_provider()`        | **0** | provider is OTel's; **zero** OTel warnings; both orders identical                                    |
| Python structlog, `format_exc_info` + `JSONRenderer`           | **0** | the exception text **leaks**; there is no `redact` equivalent                                        |

## Decision

**Adopt the stack `OBSERVABILITY.md` §1 names, at the pins in the tables above**,
with the following obligations on Tasks 2–6. Each is a thing the spike proved is
required, not a suggestion.

1. **One `NodeSDK`, and Sentry initialised first with
   `skipOpenTelemetrySetup: true`.** `Sentry.init()` runs before the SDK so that
   `Sentry.getClient()` exists; the single `NodeSDK` then carries
   `SentrySpanProcessor`, `SentryPropagator` (inside a composite — obligation 3),
   `SentrySampler(client)` and
   `wrapContextManagerClass(AsyncLocalStorageContextManager)`, followed by
   `setupEventContextTrace(client)`. This is the **only** one of the five
   configurations measured in which neither pipeline goes dark. It is why
   `@sentry/opentelemetry` and `@opentelemetry/context-async-hooks` are direct
   dependencies rather than transitive ones.

2. **Sentry's span-producing default integrations are removed** via the
   `integrations` callback. Left on, they double every span and name the HTTP
   span after the raw URL. See "What did not work".

3. **The global propagator is a `CompositePropagator` containing
   `W3CTraceContextPropagator`, `W3CBaggagePropagator` and `SentryPropagator`,
   in that order**, and it is passed **through** the SDK's own registration, not
   set afterwards. `SentryPropagator` alone breaks the correlation property
   `OBSERVABILITY.md` §2 is built on.

4. **The Temporal worker registers the `exporter` sink** built by
   `makeWorkflowExporter`. Without it every workflow-side span is dropped and
   the only signal is an `[ERROR]` log line from the worker, which exits 0.

5. **`@opentelemetry/instrumentation-undici@0.31.0` is installed.** Node 24's
   `fetch` is undici; `instrumentation-http` does not cover it, and an
   uninstrumented outbound call produces no span at all rather than a poor one.

6. **`@prisma/instrumentation` tracks `@prisma/client`, not npm `latest`** —
   `6.19.3` today. This is [ADR-0024](./0024-types-node-pin.md)'s rule applied to
   a second package family: `latest` is `7.9.1`, a major ahead of the pinned
   client.

7. **Pino's redaction list gains `err.message` and `err.stack`, _and_ a custom
   `err` serialiser.** Both, for the reason in Q5 below: the paths are coupled
   to `errorKey` and to nesting depth, and the serialiser is not.

8. **`domain-exception.filter.ts` stops passing `error.stack` as a log
   message.** The carry-forward leak this plan exists to close cannot be closed
   by a redaction path — measured. The cause belongs in a structured `err` field
   where the serialiser and the paths can both reach it.

9. **`PinoInstrumentation` is configured explicitly**: `logKeys` mapped to the
   camelCase names `OBSERVABILITY.md` §3 specifies, and `disableLogSending`
   decided deliberately rather than defaulted.

10. **Custom Temporal search attributes are provisioned, not assumed.**
    `auto-setup` does not register `MetrikaRequestId`; `temporal operator
search-attribute create --name MetrikaRequestId --type Keyword` does. The
    same applies to `MetrikaOrganizationId`, `MetrikaModelVersionId`,
    `MetrikaQuoteId` and `MetrikaTraceId`, in `docker-compose`, in
    `packages/testing`'s harness and in Temporal Cloud.

11. **Every span exporter is constructed with an explicit `Resource`.**
    `SimpleSpanProcessor` defers export until a resource's async attributes
    settle, so a default resource plus a short-lived process exports nothing —
    see "What did not work", where it cost this spike a false reading.

12. **No new `allowBuilds` entry is required**, and this is measured rather than
    assumed: `protobufjs` is already `true` and `@swc/core` already `false` in
    `pnpm-workspace.yaml`, and those are the only two build scripts the whole
    stack adds.

### The five answers

**1. Does the OTel Node SDK instrument Fastify 5 under Nest 11? — Yes,
measured.** One real `GET /things/:id` produced **10 spans** from four
instrumentation scopes, **three of them carrying `http.route: "/things/:id"`**:
the `instrumentation-http` server span (`GET /things/:id`, `kind: SERVER`), the
`instrumentation-fastify` `request handler` span, and the
`instrumentation-nestjs-core` `ThingController.get` span. Nine of the ten share
one trace id; the tenth is `Create Nest App`, emitted at boot, which is correct
and is the reason a naive "all spans are on one trace" assertion fails. The
route is the **template**, not the URL — `/things/:id`, never `/things/abc123` —
so the histogram `OBSERVABILITY.md` §8 asks for has bounded cardinality.

`apps/api` is `"type": "module"`. The ESM loader hook
(`register('@opentelemetry/instrumentation/hook.mjs', …)`) was therefore
installed — and then **measured to be unnecessary today**: with it disabled the
span set is byte-identical, because `fastify`, `@nestjs/*` and `pino` all ship
CommonJS and are reached through the CJS loader that require-in-the-middle
patches. It stays in the bootstrap as insurance for the first instrumented
dependency that ships native ESM, and it is recorded here so nobody removes it
believing it was load-bearing, or keeps it believing it is.

**2. Do Sentry 10 and the OTel SDK coexist? — Only if they share one
`TracerProvider`, and double registration neither throws nor is visible.**

| Order                                        | Global provider        | OTel exporter | Sentry transactions | Sentry errors | `diag`                              |
| -------------------------------------------- | ---------------------- | ------------- | ------------------- | ------------- | ----------------------------------- |
| OTel only                                    | `TracerProvider`       | spans         | —                   | —             | clean                               |
| Sentry only                                  | `SentryTracerProvider` | —             | 3                   | correlated    | clean                               |
| **`Sentry.init()` → `NodeSDK.start()`**      | `SentryTracerProvider` | **0 spans**   | 3                   | correlated    | **3 duplicate-registration ERRORs** |
| **`NodeSDK.start()` → `Sentry.init()`**      | `TracerProvider`       | 3 spans       | **0**               | correlated    | 1 duplicate-registration ERROR      |
| **`skipOpenTelemetrySetup` + one `NodeSDK`** | `TracerProvider`       | 3 spans       | 3                   | correlated    | benign resource warnings            |

`@opentelemetry/api`'s `registerGlobal` **refuses** a second registration of
`context`, `propagation` or `trace`. It does not throw — it writes
`Attempted duplicate registration of API: trace` to the `diag` channel, which is
a **no-op logger unless one is installed**, and then continues. So whichever SDK
initialises first wins all three globals, the process exits 0, and the loser's
entire pipeline is silently dead: Sentry-first kills OTLP export to Grafana,
OTel-first kills Sentry performance monitoring. Error events survive both
orders, which is what makes the failure so easy to miss — Sentry looks like it
is working.

The `skipOpenTelemetrySetup` configuration is the only one where both are
populated and agree on trace ids. It is obligation 1.

**3. Does `AsyncLocalStorage` survive the OTel context manager? — Yes, at every
probe, under both context managers.** Seven probes were taken inside one
instrumented request — in the controller, in a service, across an `await`,
inside an explicitly-started OTel span, across an `await` inside that span,
after the span ended, and after an instrumented outbound HTTP call.
`getRequestId()` returned the real request id at **7 of 7** and `NO_REQUEST_ID`
at **0 of 7**, both under `AsyncLocalStorageContextManager` and under Sentry's
`wrapContextManagerClass(AsyncLocalStorageContextManager)`. `traceId` was
non-empty at all seven as well, so the two mechanisms compose rather than merely
coexist: a log line can carry `requestId` and `traceId` together at any point in
a request.

This is a positive result, and the negative case is what makes it worth
anything: had OTel installed a context manager that reset the store, the probe
after `context.with(...)` would have returned the sentinel and every log line in
that call would have lost its request id with no error anywhere.

**4. Do baggage and Temporal search attributes round-trip? — Yes, across two
languages, and only with the right propagator.** A Node client started a
workflow inside an active span carrying baggage
(`metrika.request_id`, `metrika.organization_id`) and search attributes
(`MetrikaRequestId`, `MetrikaTraceId`) against a real `auto-setup:1.29.7`
server. The workflow ran on a Node worker and invoked two activities: one in
Node, one in **Python** on a second task queue with
`temporalio.contrib.opentelemetry.TracingInterceptor`.

| Propagator                                       | client  | workflow | Node activity               | Python activity  |
| ------------------------------------------------ | ------- | -------- | --------------------------- | ---------------- |
| `Composite(W3CTraceContext, W3CBaggage)`         | trace A | trace A  | trace A, baggage            | trace A, baggage |
| **`SentryPropagator` alone**                     | trace A | trace B  | **trace C, baggage `null`** | trace B, baggage |
| `Composite(W3CTraceContext, W3CBaggage, Sentry)` | trace A | trace A  | trace A, baggage            | trace A, baggage |

Search attributes round-tripped three ways: readable inside the workflow from
`workflowInfo().searchAttributes`, readable from `describe()`, and — the one
that matters operationally — **queryable**:
`MetrikaRequestId = 'req-spike-temporal-0001'` returned the started workflow
from `ListWorkflowExecutions`. The memo round-tripped too. The Python worker's
structlog output carried the same `traceId` as the Node client, which is
`OBSERVABILITY.md` §2's promise demonstrated end to end rather than asserted.

The `SentryPropagator`-alone row is the finding. It is not a failure to start;
it is one request becoming three unrelated traces, with the correlation id
missing from the leg most likely to fail.

**5. What does Pino's `redact` do to an `Error`? — It reaches the Error's own
properties and not its `message` or `stack`, and the leak this plan exists to
close is in neither place.**

| Configuration                                   | `err.message` | `err.stack` | `err.password` | `msg`                    |
| ----------------------------------------------- | ------------- | ----------- | -------------- | ------------------------ |
| blueprint list, `logger.error({ err }, 'boom')` | **LEAKED**    | **LEAKED**  | redacted       | clean                    |
| blueprint list, `logger.error(err)`             | **LEAKED**    | **LEAKED**  | redacted       | **LEAKED**               |
| blueprint list **+ `err.message`, `err.stack`** | redacted      | redacted    | redacted       | clean                    |
| blueprint list **+ `*.message`, `*.stack`**     | redacted      | redacted    | redacted       | clean                    |
| blueprint list **+ a custom `err` serialiser**  | redacted      | redacted    | redacted       | clean                    |
| `errorKey: 'error'`, paths still `err.message`  | **LEAKED**    | **LEAKED**  | redacted       | clean                    |
| an Error nested at `{ outer: { cause: err } }`  | —             | —           | —              | secret still in the line |
| **`logger.error(error.stack)`**                 | —             | —           | —              | **LEAKED**               |

Five things follow, and Task 2 needs all five.

- **The wildcards do reach an `Error`.** `*.password`, `*.projectName` and
  `*.signedUrl` all censor properties assigned onto an `Error` exactly as they
  do on a plain object. The blueprint list is not inert; it is incomplete.
- **It is incomplete in exactly two places**, `message` and `stack`, because no
  path names them. Adding them works.
- **`logger.error(err)` writes the message twice** — into `err.message` and into
  the top-level `msg` — and `msg` is not covered by the blueprint list either.
- **A static `err.*` path is coupled to `errorKey`, and a `*.x` wildcard is
  single-level.** Rename the key or nest the error one level deeper and the
  control silently stops applying. A serialiser is coupled to neither, which is
  why obligation 7 asks for both rather than choosing.
- **`logger.error(error.stack)` cannot be redacted at all.** Once the stack is a
  free-text message there is no path, no wildcard and no serialiser that reaches
  it. `domain-exception.filter.ts:23-26` records that this is what the filter
  does today, and it is why obligation 8 is a code change rather than a
  configuration change. This is the answer Task 2 was blocked on.

On the Python side the same question has a different shape and the same answer:
`structlog.processors.format_exc_info` puts the traceback under `exception`,
there is **no `redact` equivalent at all**, and the default pipeline leaks. A
scrubbing processor placed before the renderer closes it — measured, including
the `exception` key.

### Fallback

The fallback is named with a trigger measurement rather than "if it fails",
because [ADR-0009](./0009-ts-rest-contracts.md)'s was, and a later task was
actually able to execute it.

**If the OTel Node SDK cannot instrument Fastify under Nest, the fallback is
Sentry's own tracing** — `Sentry.init()` without `skipOpenTelemetrySetup`, whose
integrations were measured here producing a complete span tree for the same
request unaided, with OTLP export to Grafana dropped to metrics and logs only.
**It is explicitly not a hand-written instrumentation layer**: that is a
maintenance surface Phase 0 does not need, and the "sentry-only" row of the Q2
table is a measured working configuration rather than a hoped-for one.

That fallback is not needed today. These are the measurements that would make it
needed, or would move a narrower pin:

| Component                                    | Trigger measurement that justifies moving                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`@opentelemetry/api`**                     | A published `1.10.0`. Nearly every SDK package declares `<1.10.0`, so the release itself is the trigger: pin the API to `1.9.x` until the SDK train's peer ranges move, and re-run `pnpm peers check` before touching it. This is the only hard upper bound in the whole set.                                                                                |
| **`@opentelemetry/instrumentation-fastify`** | A request that produces **no span carrying `http.route`** on a version this project needs, **or** the package's removal from npm. It is already deprecated in favour of `@fastify/otel`. The replacement is `@fastify/otel@0.20.1`, which is **unmeasured** — so the trigger is a real request through Nest's adapter, never an install.                     |
| **Sentry ↔ OTel**                            | `trace.getTracerProvider()` reporting a `SentryTracerProvider` delegate after the SDK starts, **or** zero spans reaching the OTLP exporter across a request that produced Sentry transactions. Either means the shared-provider configuration has been broken by an upgrade; take the Sentry-only fallback rather than reordering initialisation and hoping. |
| **`@temporalio/interceptors-opentelemetry`** | An OTel major bump that its `^1.25.1` dependencies cannot span, i.e. the two `as unknown as` casts at `makeWorkflowExporter` stop being sufficient and the sink fails at **runtime** rather than at `tsc`. The fallback is to drop the workflow-span sink and keep client and activity spans, which were measured working independently of it.               |
| **`opentelemetry-*` (Python)**               | A release whose `requires_python` lower bound exceeds 3.12. Nothing is close; every package in the Python table is `>=3.10` or looser. ADR-0027's Python 3.13 fallback is unaffected by anything measured here.                                                                                                                                              |
| **Grafana Cloud**                            | Not a code change by construction — that is the point of OTLP. The trigger is a cost or retention threshold, and the move is an endpoint and a credential.                                                                                                                                                                                                   |

## Alternatives

- **`@opentelemetry/auto-instrumentations-node@0.79.0`**, the umbrella. Rejected:
  it registers around forty instrumentations, of which this project wants five,
  and every one of them is a module-loading hook and a supply-chain surface in
  the process that owns the database. The five are named individually so the
  set is reviewable and so a new one arrives by a commit rather than by a
  transitive bump. The cost is that a package this project starts using is not
  instrumented until someone notices — which is the trade `instrumentation-undici`
  was found by, and it was found by measuring an outbound call rather than by
  reading the list.
- **`@fastify/otel@0.20.1`**, which npm's deprecation notice names. Not chosen
  **today**, and this is a decision about evidence rather than about
  maintainership: the deprecated package was measured producing `http.route`
  through Nest's Fastify adapter, and the replacement was not measured at all.
  Adopting an unmeasured package on the strength of a deprecation notice is the
  same move this repository has been burned by twice. It is the named fallback
  with a trigger measurement, and Task 3 may promote it by measuring it.
- **Sentry's own tracing, with no OpenTelemetry SDK.** Rejected as the primary:
  it is a vendor SDK in the code path, which is the thing `OBSERVABILITY.md` §1
  chose OTLP specifically to avoid, and it makes the backend a refactor rather
  than a configuration change. Kept as the fallback precisely because the spike
  measured it working — a fallback nobody has measured is a wish.
- **OpenTelemetry only, with Sentry dropped.** Rejected on the grounds
  `OBSERVABILITY.md` §1 already gives: grouping, release health and source maps
  are genuinely better than a logs-based approach. The spike adds a second
  reason — Sentry's error events carried the OTel trace id in **every**
  configuration measured, including the two broken ones, so the integration cost
  of keeping it is bounded to spans.
- **`nestjs-pino@4.6.1`**, the idiomatic Nest logger wiring. Not rejected —
  deferred, with its peer ranges recorded above so the option is open. Task 2
  owns the logger's shape, and this ADR should not pre-empt it by pinning a
  wrapper it may not want; what this ADR must not leave to Task 2 is the version
  question, which is why the row exists.
- **`opentelemetry-exporter-otlp-proto-grpc` on the Python side.** Rejected: it
  pulls `grpcio`, a compiled extension with a per-platform wheel matrix, into a
  worker image with no other use for it. The HTTP exporter costs `requests`.
- **`temporalio[opentelemetry]` rather than direct pins.** Rejected: the extra
  declares `>=1.11.1,<2` floors on two packages this ADR pins exactly, so it
  would put a second, looser statement of the same version in the manifest.
- **Setting the propagator with `propagation.setGlobalPropagator` after the
  provider is registered.** Not an alternative at all, as it turns out — it is a
  silent no-op. Recorded here because it is the obvious way to write it and it
  is what this spike did first.

## Consequences

### What did not work

A spike reporting unqualified success is the one to distrust. Fifteen things
broke or surprised, **two of them were this spike's own false readings**, and
one is a defect in a document rather than in a package.

**`pnpm install` exited 1, and the first reading of that said 0.** The command
was run as `pnpm install | tail -60; echo "INSTALL_EXIT=$?"`, which reports
`tail`'s status. The real exit was **1**:
`ERR_PNPM_IGNORED_BUILDS: protobufjs@7.6.5`, reached through
`@grpc/grpc-js` ← `@opentelemetry/otlp-grpc-exporter-base` ← the three OTLP
**gRPC** exporters that `@opentelemetry/sdk-node` depends on unconditionally,
even though this project will only use the HTTP ones. Adding the six
`@temporalio/*` packages produced a second one, `@swc/core@1.15.47`. Both are
already in the repository's `pnpm-workspace.yaml` — `protobufjs: true` and
`'@swc/core': false` — so no change is needed, but that was **verified rather
than assumed**, and it would not have been noticed at all if the exit code had
kept being read off a pipe. This is the exact hazard Plan 0C's own notes warn
about, hit in the first command of the spike.

**`@opentelemetry/instrumentation-fastify@0.57.0` is deprecated on npm.** The
install prints one `[WARN] deprecated` line: _"Deprecated in favor of
@fastify/otel, maintained by the Fastify authors."_ It is the only deprecation
warning in the whole install, it works correctly, and it is the package that
produces the `http.route` attribute question 1 is about. Handled in
Alternatives and in the fallback table rather than by silently taking the
replacement.

**Sentry and OTel both claim the global APIs, and the loser fails silently.**
Covered in Q2. The part worth repeating here is the mechanism:
`@opentelemetry/api`'s `registerGlobal` reports a duplicate registration through
`diag`, whose default logger discards everything. So the observable symptoms of
a broken configuration are "the process starts fine" and "one of the two
backends has no data" — with no error, no warning on stdout and exit 0. **A
`diag` logger must be installed in Task 3's bootstrap for this class of failure
to be visible at all.**

**Sentry's default integrations duplicate every span, and one of them has
unbounded cardinality.** With `skipOpenTelemetrySetup: true` but the default
integrations left on, one request produced **19 spans instead of 10**, from two
sets of HTTP and Fastify instrumentations running side by side. Sentry's HTTP
span is named **`GET /things/abc123`** — the raw URL — where OTel's is
`GET /things/:id`. Worse, the two interfere: OTel's Fastify spans came back
named `request handler - handlerWrapped` and `middleware - startRequestSpanHook`
instead of `request handler - fastify -> @fastify/middie`, because Sentry's
instrumentation had already wrapped the handlers. Filtering the twenty-two
span-producing integrations out of `Sentry.init`'s `integrations` callback
restored the span set to exactly the OTel-only 10, with Sentry still receiving
its transactions through `SentrySpanProcessor`. Hence obligation 2.

**`SentryPropagator` alone breaks the Temporal trace into three.** Covered in
Q4. It is the single most consequential measured property here, because it does
not look like a failure from either end: Sentry is happy, Temporal is happy, the
workflow completes, exit 0 — and a support ticket quoting a request id resolves
to a third of the story with the activity leg missing entirely. The composite
propagator fixes it, and the fix is one line that nothing else in the system
would ever point at.

**`provider.register()` already installs a propagator, so a later
`setGlobalPropagator` is a silent no-op — and this spike measured the wrong
thing because of it.** The first Sentry-propagator run reported
`fields=["traceparent","tracestate","baggage"]` and a perfectly intact trace,
which would have been written up as "Sentry's propagator is fine". It was
running OTel's propagator the whole time. Passing the propagator **through**
`register()` produced the three-trace result above. Same root cause as the
duplicate-registration finding, one layer down, and it is recorded as a mistake
made rather than a hazard avoided.

**`SimpleSpanProcessor` defers every export until the resource's async
attributes settle, and this spike measured zero spans because of it.** With a
default `Resource` (which runs async detectors for host, OS and process) and a
process that finishes promptly, `getFinishedSpans()` returns `[]` — identical to
what an SDK that never started would report. Three of the five Q2
configurations were initially recorded as "exporter received nothing" for this
reason and had to be re-run. The fix is either an explicit
`resourceFromAttributes(...)` or a wait before reading; obligation 11 takes the
first. The general shape — _a green-looking measurement that is actually a
harness artefact_ — is why every claim in this ADR was re-measured rather than
re-read.

**The OTel 1.x/2.x split is a hard compile error, not a warning.**
`@temporalio/interceptors-opentelemetry@1.22.0` depends on
`@opentelemetry/core`, `resources` and `sdk-trace-base` at `^1.25.1`, resolving
to `1.30.1`, while everything else in the stack is on `2.10.0`. `pnpm peers
check` is clean and the install is silent. But `makeWorkflowExporter` takes a
`SpanExporter` typed against `1.30.1`, and `tsc` **exits 2**:

```
TS2769: No overload matches this call.
  Property 'instrumentationScope' is missing in type
  '…/@opentelemetry+sdk-trace-base@1.30.1/…/ReadableSpan' but required in type
  '…/@opentelemetry+sdk-trace@2.10.0/…/ReadableSpan'.
```

`instrumentationScope` replaced `instrumentationLibrary` in the 2.x
`ReadableSpan`, so the two types are structurally incompatible in the direction
that matters. **At runtime it works**: with two `as unknown as` casts the sink
registered, the workflow spans exported, and the trace was intact. So the cost
is two justified casts at one boundary — which is a real cost in a repository
whose rules ban `any` and require a justification comment on every suppression,
and it is a cost Task 3 should pay knowingly at a named seam rather than
discover.

**A Temporal worker silently drops every workflow span if the sink is not
registered.** Without `sinks: { exporter: makeWorkflowExporter(...) }` the
worker logs `[ERROR] Workflow referenced an unregistered external sink
{ ifaceName: 'exporter', fnName: 'export' }` once per span and continues. The
workflow completes, the client gets its result, the process exits 0, client and
activity spans are all present — and `RunWorkflow:spikeWorkflow`,
`StartActivity:echoNode` and `StartActivity:echo_python` are simply absent from
the exporter. A trace that is missing only its middle is harder to notice than
one that is missing entirely. Hence obligation 4.

**`auto-setup` does not register the search attributes this project needs.**
`MetrikaRequestId` had to be created explicitly with
`temporal operator search-attribute create`. Before that,
`ListWorkflowExecutions` with a query naming it fails. This affects three places
that each have their own copy of the Temporal bring-up —
`infra/docker/docker-compose.yml`, `packages/testing/src/temporal.ts` and
Temporal Cloud — and nothing mechanically keeps them in agreement, which is the
same hazard ADR-0028 records for `BIND_ON_IP`.

**`@opentelemetry/instrumentation-pino` disagrees with the blueprint about field
names, and does something else nobody asked for.** It injects `trace_id`,
`span_id` and `trace_flags` — **snake_case** — while `OBSERVABILITY.md` §3's
example log line specifies `traceId` and `spanId`. The `logKeys` option fixes
it. Separately, `disableLogSending` defaults to **`false`**, so the
instrumentation also ships every Pino record to the OpenTelemetry Logs SDK,
which is a second log path and a second exporter that nothing in the blueprint
asked for. Hence obligation 9.

**This spike published a false Q5 finding and caught it by re-measuring.** The
first pass truncated each log line to 620 characters for display; a stack trace
is longer than that, so the truncation cut immediately before `err.password` and
the output looked exactly as it would if the wildcards had failed to reach an
`Error`. It was written up as "`redact` silently skips an `Error`'s own
properties" — a scarier and more interesting claim than the true one — before a
field-by-field re-run showed the wildcards working. The corrected finding is
narrower and is in Q5. **The two false readings in this document were both
produced by the measuring apparatus, not by the stack**, which is worth stating
plainly: a spike's harness needs the same suspicion as its subject.

**Three copies of `@opentelemetry/instrumentation` resolve** — `0.213.0` via
`instrumentation-fastify`, `0.220.0` via `@sentry/node` and `@sentry/nestjs`,
`0.221.0` via everything else. Benign, and measured benign: all four
instrumentations registered and produced spans. Recorded because
`InstrumentationBase` identity differs across the copies, so any future code
doing an `instanceof` check against it will be wrong in a way that is invisible.

**`import-in-the-middle hook has already been initialized`.** A Node warning,
emitted once, when Sentry's own IITM registration and this bootstrap's
`register()` both run. Benign — the combined run produced the full span set —
but it is on stdout at boot and will be mistaken for a problem.

**Python has none of the Node conflict, and that is worth recording as a
negative result.** `sentry_sdk@2.67.1` does **not** register a global
`TracerProvider`: in both initialisation orders the provider was OTel's, the
span exported, the Sentry envelope was sent, and the OTel logger recorded
**zero** warnings. The elaborate coexistence dance obligation 1 requires on the
Node side has no Python counterpart, and a Task 5 that assumes symmetry would
add configuration for a problem that does not exist there.

**structlog has no `redact`.** `OBSERVABILITY.md` §3 gives a Pino `redact`
block and says "structlog (Python)" in the same breath, which reads as though
the same list applies on both sides. It does not: structlog's default pipeline
emitted the exception text verbatim, and the only mechanism is a processor
placed before the renderer. Measured working, including scrubbing the
`exception` key that `format_exc_info` produces — but it is code Task 5 has to
write, not configuration it can copy.

### What is now true

**Accepted:** `apps/api` gains a telemetry bootstrap whose correctness depends
on five things no type or lint rule can check — the initialisation order, the
`skipOpenTelemetrySetup` flag, the composite propagator's membership, the
Temporal `exporter` sink, and an explicit `Resource` — each of which fails
silently, with exit 0, and each of which kills a different part of the picture.
A `diag` logger is the only thing that makes the first of them visible, so it is
part of the bootstrap rather than a debugging aid. Two `as unknown as` casts
live at the `makeWorkflowExporter` boundary because two OTel majors are resident
in the same dependency graph, and they will need re-examining at every
`@temporalio` bump. Six OTel SDK packages exist in duplicate. The pinned Fastify
instrumentation is deprecated the day it is pinned, and its replacement is
unmeasured. `@opentelemetry/api` has a hard `<1.10.0` ceiling in the peer ranges
of nearly every package that uses it, so this stack has a scheduled upgrade
event with no work-around other than waiting for the SDK train. And Sentry's
default integrations must be trimmed by an explicit list of twenty-two names,
which is precisely the kind of list that goes stale — a Sentry upgrade adding a
span-producing integration silently reintroduces duplicate spans.

**Gained:** every pin Tasks 2–6 install was measured against this repository's
actual Node major, TypeScript version, Nest version and Python major on the day,
with ranges answered _before_ installation rather than inferred from a
successful one. All five questions were answered by evidence a no-op could not
produce — a route template on a span from a real HTTP request, a request id
surviving seven probes inside an instrumented call, a baggage entry read back
inside a **Python** activity on the far side of a real Temporal server, a search
attribute returned by a real `ListWorkflowExecutions` query, and a secret
demonstrably present in a log line the blueprint's redaction list claims to
cover. Two of the five answers are corrections to `OBSERVABILITY.md` rather than
confirmations of it: §3's redaction list does not cover the field that leaks,
and its log-key names do not match what the Pino instrumentation emits. The
carry-forward leak in `domain-exception.filter.ts` now has a measured answer —
it is not fixable by configuration, and Task 2 must change the call.

**Never verified, and named so nobody assumes otherwise:** no OTLP exporter ever
contacted a real collector, so Grafana Cloud's endpoint, authentication and
ingest are entirely unmeasured; only **traces** were exercised end to end, and
the metrics and logs pipelines were pinned but never run; Sentry was driven
through a stub transport and never against a real DSN, so `beforeSend`,
source maps and release health are unmeasured; `@prisma/instrumentation` was
installed and range-checked but **never exercised against a query**, and
`packages/database/prisma/schema.prisma` declares no `previewFeatures`, which
Task 4 must confirm is sufficient rather than inherit from this ADR; Temporal
**Cloud** was never contacted, only a local `auto-setup` container, so TLS,
namespaces and mTLS remain unverified exactly as ADR-0027 left them; and
`@sentry/nextjs` was pinned and peer-checked but never installed or built, so
`apps/web`'s half of the stack rests on metadata alone.
