# ADR-0031 — `defaultIntegrations: false` is unusable on `@sentry/nextjs`, so ADR-0029's obligation 2 is wrong

**Status:** Accepted · **Date:** 2026-08-12 · **Corrects** obligation 2 of
[ADR-0029](./0029-observability-stack.md). Its finding — that Sentry's
span-producing default integrations must not be active alongside this project's
own OTel instrumentations — stands unchanged, and so does every count it
records. Only the **mechanism** it prescribes is wrong, and only on
`@sentry/nextjs`.

## Context

ADR-0029 obligation 2 says to initialise Sentry with `defaultIntegrations:
false` plus an explicit allowlist, and gives a good reason: an allowlist
excludes a new span-producing integration by default, where a denylist silently
admits it. That reasoning is untouched here.

The literal `defaultIntegrations: false` was measured on **`@sentry/node`**,
where every default integration has an exported factory and can therefore be
handed back. **`@sentry/nextjs` has two that do not**, and the SDK adds them
inside `init()` rather than exposing them:

- **`NextjsClientStackFrameNormalization`** — rewrites client stack frames
  against `assetPrefix` / `basePath` so uploaded source maps match.
- **`DistDirRewriteFrames`** — rewrites server frames from the absolute
  `distDir` path to `app:///_next`, for the same reason.

Both are what make a Next.js stack trace resolvable in Sentry at all. With
`defaultIntegrations: false` they are dropped, and there is **no exported
factory to add them back** — so the literal form silently trades symbolication
for span suppression.

This was found by Task 5 implementing against the obligation, not by a spike
re-measurement, which is why it is recorded separately rather than folded into
the existing correction — the same reasoning
[ADR-0028](./0028-temporal-bind-on-ip.md) gives for being its own file.

### Why this is ADR-0031 and not an addition to ADR-0030

[ADR-0030](./0030-nest-logger-argument-shape.md) already corrects obligation 8
and four smaller assertions, and it has not merged, so appending a fifth
correction is superficially tempting. Applying **ADR-0030's own rule** — now in
[`docs/adr/README.md`](./README.md) — forecloses it: _an ADR's body may be
corrected in place only while nothing has relied on it; the test is citation,
not merge._ ADR-0030 is cited by
`docs/superpowers/plans/2026-08-12-phase-0c-observability.md` and is being
implemented against in `apps/api`. It has been relied on.

There is a second reason, and it is the stronger one. ADR-0030's thesis is that
ADR-0029 stops being rewritten and that every correction lands in one immutable
place. A correction register that grows by editing is precisely the pattern it
exists to condemn; extending it would also require rewriting its own scope
sentence, which is an assertion a reader has acted on.

## The measurement

`@sentry/nextjs@10.70.0`, `next@16.3.0`, Node 24.19.0, in a throwaway directory
outside the workspace, destroyed afterwards. `next build` was **not** run;
`_sentryRewriteFramesDistDir` was set by hand where noted, which is what
`withSentryConfig` injects at build time.

**ADR-0029's counts reproduce exactly**, so nothing that rests on them moves:

| `getDefaultIntegrations(…)`       | count  |
| --------------------------------- | ------ |
| server, bare                      | **17** |
| server, `{ tracesSampleRate: 1 }` | **44** |
| client                            | **11** |

The two integrations at issue, and what each initialisation form does with them:

| Form                                              | server (`distDir` injected)                     | client                                                         |
| ------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------- |
| `init({ integrations: (d) => d })`                | **18** active, incl. `DistDirRewriteFrames`     | includes `NextjsClientStackFrameNormalization`                 |
| `init({ defaultIntegrations: false })`            | **0** active                                    | **0** active                                                   |
| `init({ integrations: (d) => d.filter(byName) })` | **15** active, **incl. `DistDirRewriteFrames`** | **11** active, **incl. `NextjsClientStackFrameNormalization`** |

And there is nothing to hand back:

```
'distDirRewriteFramesIntegration' in require('@sentry/nextjs')        -> false
'distDirRewriteFramesIntegration' in require('…/index.client.js')     -> false
exports matching /distDir|StackFrameNormal|nextjsClient/, both sides  -> ['rewriteFramesIntegration']
```

Only the generic `rewriteFramesIntegration` from `@sentry/core` is public. The
Next.js-specific wrappers are internal
(`build/cjs/server/distDirRewriteFramesIntegration.js`,
`build/cjs/client/clientNormalizationIntegration.js`), reachable only through a
deep import into a path the package's `exports` map does not publish.

### Two things the source shows that the counts do not

Read from `build/cjs/{server,client}/index.js` and then confirmed by running it.

**1. `DistDirRewriteFrames` is conditional.** `server/index.js:88` pushes it only
when `_sentryRewriteFramesDistDir` is set, from the environment or from the
global `withSentryConfig` injects. Without it the server defaults are **17** and
the integration is simply absent — which is why a test written outside a real
build can pass while proving nothing. The count is **18** once it is set.

**2. `getDefaultIntegrations` is not the set `init` uses**, and this corrects a
second sentence of obligation 2 — its suggestion to "pin the set with a snapshot
test" against that export.

- **Client:** `client/index.js:85` defines its own internal
  `getDefaultIntegrations` that takes `@sentry/react`'s list and **pushes**
  `browserTracingIntegration()` and
  `nextjsClientStackFrameNormalizationIntegration(…)`. The **exported**
  `getDefaultIntegrations({})` returns 11 names and does **not** include either.
  Measured: exported list has `NextjsClientStackFrameNormalization` → **false**;
  the same integration is **active** after `init` with a filter.
- **Server:** `server/index.js:78` takes `@sentry/node`'s defaults, **removes**
  `Http`, and concatenates `httpIntegration({ disableIncomingRequestSpans:
true })` in its place, because Next.js instruments incoming requests itself.
  A name-keyed snapshot cannot see that substitution at all.

So a snapshot test over the exported `getDefaultIntegrations` on
`@sentry/nextjs` pins a list that is neither what ships nor what an upgrade would
change. On `@sentry/node` — where ADR-0029 measured it — the suggestion is fine.

## Decision

**Obligation 2 of ADR-0029 is replaced by the following.** Its intent is
unchanged; only the mechanism moves.

1. **Sentry is initialised with an `integrations` callback that FILTERS the
   SDK's own defaults by name.** Not `defaultIntegrations: false`, and not a
   denylist:

   ```ts
   Sentry.init({
     // …
     integrations: (defaults) => defaults.filter((i) => ERROR_SIDE.has(i.name)),
   });
   ```

   `ERROR_SIDE` is an explicit allowlist of names. This keeps the property
   obligation 2 was written for — a Sentry release that adds a span-producing
   integration is **excluded by default**, because a name not in the set is not
   kept — while leaving every integration the SDK constructed for itself intact,
   including the two with no public factory.

2. **The allowlist carries `NextjsClientStackFrameNormalization` and
   `DistDirRewriteFrames`** in `apps/web`. They produce no spans; dropping them
   costs symbolication, which is one of the two things
   [`OBSERVABILITY.md`](../OBSERVABILITY.md) §1 keeps Sentry for.

3. **The drift test asserts against the ACTIVE integrations after `init`, not
   against `getDefaultIntegrations`.** On `@sentry/nextjs` the exported helper
   omits what `init` adds and misses what `init` substitutes. Asserting on the
   client's own integration map is the only form that sees the real set.
   ADR-0029's snapshot suggestion remains correct for `apps/api`'s
   `@sentry/node`, where no such divergence was measured.

4. **A test that exercises `DistDirRewriteFrames` sets
   `_sentryRewriteFramesDistDir`**, or it asserts on an integration that is not
   there and passes for the wrong reason.

## Alternatives

- **Deep-import the internal factories** (`@sentry/nextjs/build/cjs/server/…`)
  and pass them back under `defaultIntegrations: false`. Rejected: the paths are
  outside the package's `exports` map, so this is reaching into a private build
  layout that a patch release may rename, to reconstruct by hand a list the SDK
  already builds correctly.
- **Keep `defaultIntegrations: false` and accept the loss.** Rejected: it trades
  a working control for a broken one. Stack frames that do not resolve to
  sources make Sentry a list of anonymous bundle offsets.
- **A denylist over the defaults.** Rejected for the reason ADR-0029 gives, which
  is still the right reason: a new span-producing integration is silently
  admitted. The filter form above is an allowlist, so it inherits that argument
  unchanged.
- **Fold this into ADR-0030.** Rejected under ADR-0030's own rule; see Context.

## Consequences

**Accepted:** `apps/api` and `apps/web` now configure Sentry's integrations by
two different mechanisms in principle — though in practice both use the filter
form, since it is correct on `@sentry/node` too and one shape across two sinks
is worth more than a marginal difference. The allowlist is a list of names,
which is the kind of thing that goes stale silently; obligation 2's drift test
is what keeps it honest, and this ADR moves that test onto the active set where
it can actually see drift. `DistDirRewriteFrames` is conditional on a value
injected at build time, so a unit test proves less about it than it appears to.
And this is ADR-0029's second correction ADR, which means the pin document is now
read as a set of three — the cost of a spike whose findings were consumed before
they were finished.

**Gained:** the correction was found by an implementer hitting it, which is the
cheapest place to find it, and it was verified independently before being
recorded rather than transcribed. Two Next.js integrations that make stack traces
resolvable stay active. And obligation 2's second sentence — the snapshot-test
suggestion — turned out to be wrong on `@sentry/nextjs` for a reason nobody was
looking for: the exported `getDefaultIntegrations` is not the set `init` uses, on
either side, which no amount of counting integrations would have surfaced.
