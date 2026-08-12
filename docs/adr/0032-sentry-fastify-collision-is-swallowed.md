# ADR-0032 — Sentry's Fastify collision is swallowed, so ADR-0029 obligation 2's severity is wrong on `@sentry/node`

**Status:** Accepted · **Date:** 2026-08-12 · **Corrects** the severity claim in
obligation 2 of [ADR-0029](./0029-observability-stack.md). The **decision** that
obligation makes — `defaultIntegrations: false` plus an explicit allowlist, in
the allowlist direction — is unchanged and is what `apps/api` ships. Only the
failure mode it names moves, from loud to silent.

## Context

ADR-0029 obligation 2 says, of leaving Sentry's default integrations on
alongside `@fastify/otel`:

> Measured with the corrected Fastify pin, the cost is that **the application
> does not boot**: `@fastify/otel` and Sentry's own `Fastify` integration both
> decorate a Fastify property called `opentelemetry`, and the second one throws
> `FST_ERR_DEC_ALREADY_PRESENT` at listen time, exit 1. That is a better failure
> than round 1's silent duplication, and it makes this obligation load-bearing
> rather than tidy.

Plan 0C Task 3 carries the same sentence forward — _"Loud, and it will be the
first thing you hit"_ — and it is the reason the obligation reads as mandatory
rather than advisory.

**It did not happen.** Task 3's implementation mutated the allowlist away, twice,
and the application booted and served a fully correlated request both times.

## The measurement

`apps/api` as Task 3 built it, on `@sentry/node@10.70.0`, `@fastify/otel@0.20.1`,
`fastify@5.10.0`, `@nestjs/platform-fastify@11.1.28`, Node 24.19.0, against the
real `dist/main.js` and a local OTLP receiver that parses the exporter's body.
The mutation removes `defaultIntegrations: false` and the `integrations`
allowlist, so `init()` builds its own 44 — `Fastify` included.

| Configuration                                     | Boots | Exported spans | Span scopes and parenting        |
| ------------------------------------------------- | ----- | -------------- | -------------------------------- |
| the allowlist (15 of 44)                          | yes   | **9**          | baseline                         |
| defaults ON, `registerEsmLoaderHooks: false`      | yes   | **9**          | **identical, span for span**     |
| defaults ON, Sentry's ESM loader hooks ON as well | yes   | not re-read    | one extra stdout warning at boot |

The full integration suite — seventeen assertions covering the trace join, the
parent linkage, the request id on the log line, the baggage round trip and the
route template — is **green in all three**. The only observable difference is
that the third prints `Warning: The 'import-in-the-middle' hook has already been
initialized`, which ADR-0029 already records as benign.

### Why, in one line of somebody else's source

The collision is real; the throw is caught.
`@sentry/server-utils@10.70.0/build/cjs/integrations/tracing-channel/fastify/instrumentation.js:264`:

```js
diagnosticsChannel.subscribe('fastify.initialization', (message) => {
  const fastifyInstance = message.fastify;
  fastifyInstance?.register(fastifyOtelPlugin).after((err) => {
    if (err) {
      DEBUG_BUILD && debug.error('Failed to setup Fastify instrumentation', err);
    } else if (fastifyInstance) { instrumentOnRequest(fastifyInstance); }
  });
});
```

`fastify.register(...)` is lazily executed, so `instance.decorateRequest('opentelemetry', …)`
at line 46 of the same file throws **inside the plugin's own registration** and
is delivered to `.after(err)` — where a non-debug build discards it. Both
packages now reach Fastify through the same `fastify.initialization`
diagnostics channel, which is also why neither has to patch the module and why
load order does not affect this.

So on this version the outcome is not "exit 1" and it is not the duplicate spans
of ADR-0029's round 1 either: Sentry's Fastify instrumentation **fails to install
and says nothing**, and OpenTelemetry's is untouched.

## Decision

1. **ADR-0029 obligation 2's decision stands, unchanged.** `apps/api` ships
   `defaultIntegrations: false` and an explicit allowlist, in the allowlist
   direction, for the reason ADR-0029 gives and this ADR does not touch: a
   Sentry release that adds a span-producing integration is excluded by default,
   where a denylist admits it silently.

2. **Its severity claim is replaced.** On `@sentry/node@10.70.0` the cost of
   leaving the defaults on is **not** a boot failure. It is a Sentry
   instrumentation that silently does not install, plus every other default
   integration running unreviewed. Nobody implementing against obligation 2
   should expect `FST_ERR_DEC_ALREADY_PRESENT` to tell them they got it wrong.

3. **Therefore the allowlist has no end-to-end fixture, and that is recorded
   rather than papered over.** Removing it changes no observable output, so
   there is nothing for an integration test to assert. The control is graded by
   `apps/api/test/telemetry.test.ts` at the level it actually operates —
   the default set is pinned by name, the allowlist is asserted to be a subset of
   it, and the two module-patching integrations are asserted absent — and the
   mutation of the allowlist itself is **green** in the integration suite. Plan
   0C Task 3's report says so plainly.

4. **`registerEsmLoaderHooks: false` is part of this bootstrap**, and it is not
   what makes the above true — it was measured in both positions. It is set
   because this process registers `@opentelemetry/instrumentation/hook.mjs`
   itself and the allowlist keeps no Sentry integration that patches a module, so
   Sentry's loader hook has nothing to do and its only effect is the boot warning
   ADR-0029 records.

## Alternatives

- **Edit ADR-0029's obligation 2 in place.** Rejected under the rule ADR-0030
  states and `docs/adr/README.md` carries: the test is citation, not merge, and
  this sentence has been cited by the plan and implemented against.
- **Fold this into ADR-0031**, which already corrects obligation 2. Rejected for
  ADR-0031's own reason: it has been relied on, and a correction register that
  grows by editing is the pattern the rule exists to condemn. The two are also
  about different things — ADR-0031 corrects the mechanism on `@sentry/nextjs`,
  this corrects the severity on `@sentry/node`.
- **Drop the allowlist, since its stated failure does not reproduce.** Rejected.
  The reproduced facts still support it: 44 default integrations, 27 of which
  exist only to instrument something, and one of them measurably failing to
  install in a way nothing reports. A control whose failure is silent is a
  stronger argument for an allowlist than one whose failure is loud.
- **Report it only in the task report.** Rejected: a decision-bearing claim that
  a plan repeats verbatim is exactly what ADR-0028 says belongs in an ADR, and a
  report is not where the next implementer looks.

## Consequences

**Accepted:** ADR-0029 now has three correction ADRs and is read as a set of
four. One of its obligations is enforced by a unit test and a code comment
rather than by anything an end-to-end run can see, which is a weaker position
than the document claims and than a reader of that document would assume. And
this repository now depends, in one more place, on behaviour that lives inside a
vendor's `.after(err)` callback: if a future `@sentry/node` stops swallowing that
error, the boot failure ADR-0029 describes becomes real again — for anyone who
removed the allowlist on the strength of this ADR.

**Gained:** the claim was tested rather than inherited, by mutating the control
and looking at what actually changed, which is the step that turns an obligation
into a measurement. The mechanism is identified in the vendor's source rather
than guessed at, so the trigger for revisiting this is a specific line rather
than a version bump. And a control that cannot be graded end to end is now
labelled as such in three places — here, in the code, and in the task report —
instead of being assumed to be covered by a suite that passes either way.
