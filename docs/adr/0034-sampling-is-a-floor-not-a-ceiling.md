# ADR-0034 — Sampling is a floor, not a ceiling; and `dsnConfigured` never detected what it was named for

**Status:** Accepted, supersedes [ADR-0033](./0033-sentry-fastify-collision-measured-with-sentry-on.md) · **Date:** 2026-08-12

ADR-0033's central content is **restated here unchanged and still holds**: ADR-0029
obligation 2's severity is correct, ADR-0032 measured it with Sentry switched
off, and the allowlist has an end-to-end fixture. Two of ADR-0033's own
statements were wrong, both of them claims that sounded like consequences of
something measured rather than measurements, and both are corrected below. It
supersedes rather than annotates because one of the two is in its Decision list
and the other in its Consequences, and a reader should not have to reconcile
three documents to learn what a sampling rate does.

**Every claim below names the measurement beside it.** That is the rule this
plan has now had to apply four times.

## What ADR-0033 got right, restated so it stays in one live document

- **ADR-0029 obligation 2 stands as written, severity included.** With
  `@fastify/otel` and a configured DSN, leaving Sentry's default integrations on
  means the application does not boot. MEASURED 2×2 against `dist/main.js`, exit
  codes from `$?`, integration names from `Object.keys(getClient()._integrations)`:

  |                 | allowlist            | allowlist REMOVED                                                                 |
  | --------------- | -------------------- | --------------------------------------------------------------------------------- |
  | `SENTRY_DSN=''` | exit 0, `[]`         | exit 0, `[]`                                                                      |
  | DSN set         | exit 0, the 15 names | **exit 1, `FastifyError: The decorator 'opentelemetry' has already been added!`** |

- **ADR-0032 is superseded and wrong**, having measured only the left column.
- **`DEBUG_BUILD` is `true` in the shipped CJS build** — MEASURED by reading
  `@sentry/node/build/cjs/debug-build.js`, which is
  `typeof __SENTRY_DEBUG__ === 'undefined' || __SENTRY_DEBUG__`. What is off is
  the separate runtime `debug` flag.
- **The integration suite runs the child against a real DSN**, because a client
  without one constructs no integrations at all.
- **A green mutation is a claim about the harness** until the harness has been
  shown capable of killing it.

## Correction 1 — sampling is a floor, not a ceiling

ADR-0033 recorded, of a caller that sends W3C trace context and no
`sentry-trace`: _"at `TRACES_SAMPLE_RATE < 1` the boundary cuts both ways: a
caller's sampled trace can be dropped here, leaving whatever this API calls next
as orphaned children."_

**Nothing measured that.** The suite only ever sent `-00`, so the `-01` direction
was inferred from the sampler being "not parent-based" and written down as a
consequence.

MEASURED, one child per rate, spans counted at a real OTLP receiver, same two
requests each:

| `traceparent` in  | `TRACES_SAMPLE_RATE=1` | `TRACES_SAMPLE_RATE=0` |
| ----------------- | ---------------------- | ---------------------- |
| `-01` (sampled)   | 14 spans               | **14 spans**           |
| `-00` (unsampled) | 8 spans                | **0 spans**            |

So the sampled direction is **always honoured** and the rate never drops it. The
mechanism, read from source after the measurement rather than before:

- `getSamplingDecision` (`@sentry/opentelemetry@10.70.0`,
  `asyncContextStrategy-*.js:148`) returns `true` when `traceFlags === SAMPLED`,
  returns `false` only for Sentry's own `sampled_not_recording` tracestate, and
  otherwise falls through to `undefined`. A cleared W3C flag is therefore
  `undefined`, not `false`.
- `sampleSpan` (`@sentry/core@10.70.0`, `tracing/sampling.js:28`) is
  `else if (samplingContext.parentSampled !== void 0) { sampleRate = samplingContext.parentSampled }`
  — a defined `parentSampled` wins over `tracesSampleRate` in both directions.

**The real consequence, which is the opposite of the recorded one:**
`TRACES_SAMPLE_RATE` cannot hold sampling DOWN. Any caller that sends `-01` pins
this API at 100% for that trace, and `traceparent` is caller-supplied — so the
rate is a floor for anyone who asks, not a ceiling anyone can enforce. There is
no orphaned-child failure, because the API never drops a trace its caller
sampled.

**Kept as it is**, for ADR-0029 obligation 1's reason: `SentrySampler` is on the
shared provider and a `ParentBasedSampler` would take Sentry's DSC handling with
it. What changes is that both directions are now pinned —
`apps/api/test/telemetry.integration.test.ts` runs a second child at rate `0`
precisely because a rate is read once at boot, and nothing in a single-rate suite
can tell "the rate decides" from "the caller decides".

## Correction 2 — `dsnConfigured` could not detect the state it was named for

ADR-0033 §3 said the suite asserts `dsnConfigured` on the child's ready line "so
the apparatus cannot quietly return to that state". It could.

MEASURED, three cases, reading both fields off the real client in the built
process:

| `SENTRY_DSN`  | `getOptions().dsn` | `getDsn()` | integrations |
| ------------- | ------------------ | ---------- | ------------ |
| `''`          | `''`               | undefined  | **0**        |
| `'not-a-dsn'` | `'not-a-dsn'`      | undefined  | **0**        |
| a real DSN    | the DSN            | set        | 15           |

`@sentry/node-core@10.70.0`'s `getClientOptions` is
`dsn: options.dsn ?? process.env.SENTRY_DSN`, so an empty string is echoed back
and `getOptions().dsn !== undefined` reads **true** in exactly the state the
field existed to catch — and a malformed DSN disables the client silently the
same way. Only the set-equality assertion over the produced integrations caught
either.

**Replaced by two assertions, not one.** The fixture now reports
`client.getDsn() !== undefined`, which is the parsed value and is false for both
bad cases; and the suite additionally asserts `integrations.length > 0`, which is
the direct statement of the property rather than a proxy for it.

## Two smaller things fixed with them

- **A case named "carries the route template rather than the URL" could not
  assert it.** The receiver kept attribute KEYS and never values, so the
  strongest available assertion was that `http.route` exists — true of a span
  carrying `/health/abc123` too. Values are now captured and the value is
  asserted.
- **An assertion that could not fail.** `expect(ready.integrations).not.toContain('Fastify')`
  runs against the allowlist's output, and `Fastify` is not among the seventeen
  `getDefaultIntegrations({})` the filter runs over — it appears only in the
  forty-four that tracing adds. MEASURED by adding `'Fastify'` to the allowlist:
  the integration suite stays **green at 26 passed**, while
  `test/telemetry.test.ts` — which runs the filter over the full forty-four —
  goes **red** with `expected [ … ] to not include 'Fastify'`. Adding
  `'NodeFetch'` instead, which IS among the seventeen, reddens the integration
  suite on two cases. So the line is removed where it cannot fail and kept where
  it does.

## Alternatives

- **Annotate ADR-0033 in place.** Rejected under the rule in
  `docs/adr/README.md`: it has been relied on, by this task's code comments,
  `docs/OBSERVABILITY.md`, `env.ts` and a review.
- **Correct only the sampling claim and leave §3.** Rejected: §3 credits a guard
  with a property it does not have, which is the same defect as ADR-0032's, one
  document later.
- **Change the sampler so the rate is a ceiling.** Rejected here as out of scope
  and contrary to obligation 1 — but named, because it is the change somebody
  will want the first time a caller pins this API at 100%. The trigger is that
  request volume, and the move is a `tracesSampler` function, which
  `sampleSpan` consults ahead of `parentSampled`.

## Consequences

**Accepted:** ADR-0029's obligation set is now read through a chain of four
documents, two of which exist only because a measurement was written down that
nobody took. The suite spawns a second application process and takes about
twenty-five seconds, and the rate-0 block asserts an ABSENCE, which is the
weakest kind of assertion and is why it waits for the sampled trace first and
then waits again. And this repository now has a written statement that its own
sampling rate cannot bound what a caller asks for, which is a small operational
surface nobody had noticed.

**Gained:** the sampling behaviour is measured in all four cells rather than
inferred from one, and both directions are pinned by tests, so the next person to
change the sampler learns it from a red suite. The DSN guard now fails for the
malformed case as well as the empty one. And two assertions that could not fail
are gone — one replaced with the value it was named for, one moved to the file
where it is falsifiable.
