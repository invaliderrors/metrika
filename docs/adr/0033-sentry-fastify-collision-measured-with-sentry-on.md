# ADR-0033 — ADR-0032 measured Sentry with Sentry switched off; obligation 2's severity is correct

**Status:** Superseded by [ADR-0034](./0034-sampling-is-a-floor-not-a-ceiling.md) · **Date:** 2026-08-12

> **Two statements in this document are wrong, and the body below is kept as
> written.** Its Consequences claim that a low `TRACES_SAMPLE_RATE` "cuts both
> ways" and can drop a caller's sampled trace: measured at rate 0, a `-01` caller
> exports in full and only `-00` is dropped, so the rate is a floor and never a
> ceiling. And its §3 credits `dsnConfigured` with detecting a return to the
> DSN-less state: `getOptions().dsn` echoes `''` back, so that field read `true`
> in exactly that state. ADR-0034 carries both measurements, and restates
> everything here that survives them.

· This document supersedes [ADR-0032](./0032-sentry-fastify-collision-is-swallowed.md) · **Restores** the
severity claim in obligation 2 of [ADR-0029](./0029-observability-stack.md),
which ADR-0032 wrongly replaced. ADR-0029's obligation 2 therefore stands
**entirely unchanged**, mechanism and severity both, as corrected for
`@sentry/nextjs` only by [ADR-0031](./0031-sentry-nextjs-integration-allowlist.md).

## Context

ADR-0032 said that leaving Sentry's default integrations on alongside
`@fastify/otel` does not make the application exit 1, that Sentry catches the
Fastify decorator collision in a `.after(err)` callback "a non-debug build
discards", and that the allowlist therefore has no end-to-end fixture. It was
written from a mutation that ran the real `dist/main.js`, produced an identical
span set, and left a seventeen-assertion suite green.

**Every one of those runs had Sentry switched off.**
`apps/api/test/telemetry.integration.test.ts` hardcoded `SENTRY_DSN: ''`;
`tracing.ts` turns an empty string into `dsn: undefined`; and `@sentry/node` does
not reach `_setupIntegrations()` for a client with no DSN. So the allowlist was
mutated away in a process that constructs **no Sentry integrations at all**, and
the mutation could not have changed anything. The finding was not that the
collision is harmless. It was that the apparatus had removed the subject.

This is the sixth instance in Plan 0C of the failure this repository keeps
recording — an apparatus reporting a success it did not earn — and the first to
reach an ADR. The previous five were an `InMemorySpanExporter` standing in for a
collector, an exit code read off a pipe, a propagator that was never installed, a
`.pyc` whose `(mtime,size)` matched reverted source, and a `perl` substitution
that silently did not apply. This one is worse than all of them in one respect:
the others were caught before they were written down.

## The measurement

`apps/api` as Task 3 built it, `@sentry/node@10.70.0`, `@fastify/otel@0.20.1`,
`fastify@5.10.0`, `@nestjs/platform-fastify@11.1.28`, Node 24.19.0, against the
built `dist/main.js`. Exit codes read from `$?` directly. The DSN is a real one
pointed at `127.0.0.1`; nothing has to receive an envelope for `init` to build
the integrations. Integration names read from
`Object.keys(getClient()._integrations)` inside the process.

|                 | allowlist                            | allowlist REMOVED                                                                 |
| --------------- | ------------------------------------ | --------------------------------------------------------------------------------- |
| `SENTRY_DSN=''` | exit 0, integrations `[]`            | exit 0, integrations `[]`                                                         |
| DSN set         | exit 0, the **15** allowlisted names | **exit 1, `FastifyError: The decorator 'opentelemetry' has already been added!`** |

The bottom-left and top-left cells are the whole of ADR-0032: two runs that
differ in a configuration neither of them ever reached.

**And ADR-0032's mechanism is wrong twice over.** It claimed the throw is
swallowed by `.after(err)` because "a non-debug build discards it". Neither half
holds:

- `DEBUG_BUILD` is **`true`** in the shipped CJS build. `@sentry/node/build/cjs/debug-build.js`
  is `const DEBUG_BUILD = (typeof __SENTRY_DEBUG__ === 'undefined' || __SENTRY_DEBUG__)`,
  and `__SENTRY_DEBUG__` is undefined at runtime, so the guard is satisfied. What
  is off is the separate runtime `debug` flag that `core.debug.error` checks — so
  the callback runs and prints nothing, which is not the same claim.
- The callback running does not stop the failure. Measured: the error propagates
  out of the plugin registration and the process exits **1** before it listens.

## Decision

1. **ADR-0032 is superseded in full.** Its decision (keep the allowlist) was
   right for reasons that did not need it; its severity claim, its mechanism and
   its conclusion that no fixture is constructible are all withdrawn.

2. **ADR-0029 obligation 2 stands as written**, severity included: with
   `@fastify/otel` and a configured DSN, leaving Sentry's default integrations
   on means the application does not boot. It is the loud failure that document
   says it is, and it is load-bearing rather than tidy.

3. **The integration suite runs the child against a REAL DSN**, pointed at a
   local sink that answers 200 and is never read. This is not a detail of one
   test: an empty DSN silently removes the entire Sentry half of this bootstrap
   from every assertion, and the only visible symptom is a suite that passes.
   `apps/api/test/telemetry.integration.test.ts` asserts `dsnConfigured` on the
   child's own ready line so the apparatus cannot quietly return to that state.

4. **The allowlist has an end-to-end fixture.** The child reports
   `Object.keys(client._integrations)` — what the allowlist PRODUCED, not
   `getDefaultIntegrations()`, which is what it was subtracted from — and the
   suite asserts SET EQUALITY against the fifteen names, plus the absence of
   `Http`, `NodeFetch` and `Fastify` by name. Measured red with the allowlist
   removed (the child never reports ready) and green with it.

5. **A green mutation is a claim about the harness until the harness has been
   shown capable of killing it.** Any mutation reported green must name the
   configuration it ran under. That sentence is what this ADR is really for.

## Two corrections that travelled with the first

- **The span counts in Task 3's report were wrong, and wrong by conflation.** It
  reported "9 spans, 4 carrying `http.route`" from a whole-process dump that
  included the `Create Nest App` boot span on its own trace. Per REQUEST, on the
  suite's own fixture: the diagnostics-channel probe route yields **6 spans, 2
  route-bearing** (`@fastify/otel`, `-http`, `-undici`) and a real Nest route
  (`/health/live`) yields **8 spans, 4 route-bearing**, including two from
  `instrumentation-nestjs-core`. ADR-0029's comparative finding — 3 route-bearing
  spans for the deprecated instrumentation against 4 for `@fastify/otel` — is
  unaffected; ADR-0030 already warns that absolute counts are harness artefacts,
  and this is another instance.
- **The probe route never enters Nest**, being attached to the root Fastify
  instance, so a case asserting "spans from Fastify and from Nest" against it was
  asserting the first half: deleting `new NestInstrumentation()` left the suite
  green. The Nest assertion now runs against a real controller and that mutation
  is red.

## The sampling behaviour this measurement surfaced

Recorded here rather than in its own ADR because it is a consequence of
obligation 1's `SentrySampler`, which ADR-0029 already decided.

**A `traceparent` arriving with the sampled flag CLEARED is joined and then
re-sampled.** `SentrySampler` is parent-based only for a caller that also sends
Sentry's own `sentry-trace` / DSC; for a W3C-only caller every span whose parent
is remote gets a fresh head-based decision from `tracesSampleRate`. Measured, and
only this: `00-…-00` in, same trace id, the server span parented on the caller's
span id, and eight spans exported — where honouring the flag would have exported
none. What this project's own runs have NOT measured is what the re-sampled
decision looks like on the way out of the API; that leg is asserted for baggage
and trace id in the suite, not for the sampled bit.

**Kept, with the cost named.** Swapping in a `ParentBasedSampler` would take
Sentry's DSC handling with it, which obligation 1 exists to preserve. The cost is
that at `TRACES_SAMPLE_RATE < 1` the boundary cuts both ways: a caller's sampled
trace can be dropped here, leaving whatever this API calls next as orphaned
children. `apps/api/test/telemetry.integration.test.ts` asserts the current
behaviour, so changing it is a red test rather than a silent change in what a
browser's sampling decision means.

## Alternatives

- **Correct ADR-0032 in place.** Rejected under the rule ADR-0030 states and
  `docs/adr/README.md` carries. ADR-0032 has been relied on — by this task's own
  code comments and report — and its central claim is wrong, which is the
  strongest possible case for superseding rather than editing.
- **Withdraw ADR-0032 with no successor**, as a document that should never have
  existed. Rejected: it was cited, and a reader who acted on it needs to find out
  why it was wrong, which is exactly the property this repository keeps its
  wrong documents for.
- **Keep the empty DSN and accept that Sentry is untested.** Rejected. That was
  the status quo, and its cost is now measured: with the allowlist loosened, the
  first environment to exit 1 would have been a deployed one, because a
  deployment is the first place a DSN is set.

## Consequences

**Accepted:** ADR-0029 now has three corrections against it of which one is
itself corrected, so the pin document is read as a set of five and one of them
exists only to say that another was wrong. The integration suite is slower and
carries a local Sentry ingest, and it now depends on `client._integrations` — a
private field — which a Sentry release can rename with no type error; the
fixture would go red naming it, which is the acceptable failure. And this
repository has now written down, and then had to unwrite, a measurement of a
disabled subject.

**Gained:** the allowlist is a control with a fixture instead of a comment
asking to be believed, and the fixture fails for the reason ADR-0029 named.
Sentry is exercised at all — before this, no test and no local run constructed a
single Sentry integration. The measurement that mattered took four runs of a 2×2
that ADR-0032 never enumerated: two configurations crossed with the one variable
that decides whether the subject exists.
