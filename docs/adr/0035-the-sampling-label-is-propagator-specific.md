# ADR-0035 — "A floor, not a ceiling" holds only for W3C-only callers; on `sentry-trace` the caller decides both ways

**Status:** Accepted · **Date:** 2026-08-12 · **Corrects part of**
[ADR-0034](./0034-sampling-is-a-floor-not-a-ceiling.md), whose measurements are
all reproduced and whose Correction 2 (`dsnConfigured`) is untouched. What moves
is the SCOPE of its headline: it was measured for one propagator and written for
all of them.

Not a supersession, and the distinction is load-bearing rather than procedural:
ADR-0034 corrects ADR-0033 and is the live record of the Sentry/Fastify chain.
Superseding it to change one qualifier would put that whole chain into a fourth
document and leave a reader tracing five files for a fact that has not changed.
This corrects one claim, in the shape [ADR-0028](./0028-temporal-bind-on-ip.md),
[ADR-0030](./0030-nest-logger-argument-shape.md) and
[ADR-0031](./0031-sentry-nextjs-integration-allowlist.md) already use.

## Context

ADR-0034 measured four cells — `{-01, -00} × {rate 1, rate 0}` — and wrote the
result down as **"`TRACES_SAMPLE_RATE` is a floor, not a ceiling"**, unqualified,
in a bolded consequence. It went into `.env.example`'s headline and
`docs/OBSERVABILITY.md` §2's heading in the same words.

Every one of those cells is correct and reproduces. **The label is not**, because
all four were sent on `traceparent` and the stack has a second propagator whose
answer is the opposite.

## The measurement

Same harness as ADR-0034: one child per rate, `dist/main.js`, a local OTLP
receiver counting spans, one request to `/health/live` per case, `$?` read
directly. Eight spans is a fully-exported request on that route.

| Inbound headers                                                   | rate 1 | rate 0 |
| ----------------------------------------------------------------- | ------ | ------ |
| `traceparent …-01` (control)                                      | 8      | 8      |
| `traceparent …-00` (control)                                      | 8      | **0**  |
| **`sentry-trace …-0`** alone                                      | **0**  | 0      |
| **`sentry-trace …-1`** alone                                      | 8      | **8**  |
| `sentry-trace …-0` **+ `traceparent …-01`**                       | **0**  | 0      |
| `sentry-trace …-1` **+ `traceparent …-00`**                       | 8      | **8**  |
| `traceparent …-03` (sampled, plus an unknown flag bit)            | 8      | **0**  |
| `traceparent …-00` + `tracestate: sentry.sampled_not_recording=1` | 8      | 0      |

So on Sentry's own header **the caller decides in both directions and the local
rate is never consulted** — and it overrides `traceparent` either way, because
`SentryPropagator.extract` runs after the W3C members in the composite and calls
`trace.setSpanContext` outright.

### Why the two propagators differ, read after the measurement

`makeTraceState` (`@sentry/opentelemetry@10.70.0`, `asyncContextStrategy-*.js:400`)
sets `sentry.sampled_not_recording` when the `sentry-trace` header says `-0`, and
it does so on **`@sentry/opentelemetry`'s own `TraceState` class** (same file,
line 366) — a Map with **no key validation**. `getSamplingDecision` then returns
`false`, and `sampleSpan` inherits any defined `parentSampled` ahead of
`tracesSampleRate`. A cleared W3C flag has no such member, returns `undefined`,
and falls through to the rate. That is the whole difference.

## Decision

1. **The label is qualified wherever it appears.** "A floor, not a ceiling" is
   true **for callers that send only W3C trace context**. For `sentry-trace` the
   correct statement is that the caller decides outright, in both directions.

2. **Both `sentry-trace` directions are pinned**, each in the rate where it
   contradicts the local decision hardest: `-0` at rate 1 asserting the trace is
   absent, `-1` at rate 0 asserting it is present. In those rates nothing but the
   caller can explain the result.

3. **This is operationally live, not pedantic.** `apps/web` ships
   `@sentry/nextjs`, so the browser sends `sentry-trace` and its own client-side
   sample rate silently becomes this API's — including zero. A reader of "a
   floor, not a ceiling" would not expect a front-end configuration value to be
   able to switch server-side tracing off, and that is exactly what it does.

## Two things measured alongside, recorded and deliberately not worked around

**A conformant sampled caller is dropped.** `traceparent …-03` — the sampled bit
set, plus an unknown future flag bit — exports 8 spans at rate 1 and **0 at rate
0**, i.e. it is treated as "no decision" rather than "sampled".
`getSamplingDecision` tests `traceFlags === TraceFlags.SAMPLED`, a strict
equality against `1`, while OTel parses `03` to `3`. The W3C trace-context spec
requires unknown flag bits to be ignored, so this is a conformance gap in
`@sentry/core` / `@sentry/opentelemetry`, not in this repository. **Left alone**:
working around somebody else's spec bug in our sampler would put a second,
divergent sampling rule in the one place this stack has to agree with itself.
The trigger for revisiting is a caller that really sends a flag bit beyond `01`.

**One branch of `getSamplingDecision` is unreachable from the wire.** An inbound
`tracestate: sentry.sampled_not_recording=1` is **inert** — 8 spans at rate 1,
identical to a plain `-00`. `@opentelemetry/core`'s `TraceState` validates keys
against `[a-z][_0-9a-z\-*/]{0,255}`, the dot is illegal, and the member is
dropped on parse: measured directly, `get()` returns `undefined` and it is absent
from `serialize()`. The same is true of `set()`, so the member exists only inside
Sentry's own unvalidated `TraceState`. ADR-0034's mechanism paragraph names that
branch as "the one thing that returns `false`", which is true of the code and not
of anything a client can send.

## Alternatives

- **Edit ADR-0034's bolded consequence in place.** Rejected under
  `docs/adr/README.md`'s rule, and specifically forbidden for this correction:
  the claim has been relied on by `.env.example`, `docs/OBSERVABILITY.md`, a code
  comment and a review.
- **Supersede ADR-0034.** Rejected; see the header. Its four cells reproduce and
  its Correction 2 stands, so a supersession would restate a correct document to
  change an adjective.
- **Make the local rate authoritative with a `tracesSampler`.** Rejected here as
  out of scope, and named with its trigger, as ADR-0034 did: `sampleSpan`
  consults `tracesSampler` ahead of `parentSampled`, so that is the hook, and the
  trigger is a caller — plausibly our own browser — pinning this API somewhere
  the operator did not choose.

## Consequences

**Accepted:** ADR-0029's observability record is now six documents, and the
sampling story alone spans two of them. The rate-1 child carries a second
absence assertion, which is the weakest kind, mitigated only by the fact that
rate 1 exports everything the caller has not refused. And this repository has
written down that a browser-side Sentry configuration can turn server tracing
off, without doing anything about it.

**Gained:** the label now names the propagator it holds for, and both propagators
are pinned in both directions — six sampling cells under test where there were
two. A spec-conformance gap in a vendor's sampler is on record with its
measurement rather than discovered by a caller. And the `false` branch that
ADR-0034's mechanism paragraph leans on is now known to be unreachable from any
header, which is the sort of thing that reads as covered until somebody tries it.
