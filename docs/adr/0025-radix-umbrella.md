# ADR-0025 — `radix-ui` as an umbrella, not `@radix-ui/react-slot`

**Status:** Accepted · **Date:** 2026-08-09

## Context

Plan 0B-2 Task 4 ran `shadcn init` in `apps/web`. The Button it copied in opens
with

```ts
import { Slot } from 'radix-ui';
```

`Slot` is the whole of Radix's involvement in that component: it is what makes
`asChild` work, so `<Button asChild><Link/></Button>` renders one element rather
than a button wrapping a link. It is also, today, the only Radix primitive this
repository uses.

`radix-ui` is an **umbrella** package that re-exports every Radix primitive. The
alternative, `@radix-ui/react-slot`, is the single package `Slot` actually lives
in. So the question is whether to keep the import the generator wrote or rewrite
it to the narrow package.

[ADR-0021](./0021-next-major-and-frontend-stack.md) does not answer this. Its
table is captioned "Registry state, measured 2026-08-09" — a dated measurement
of the fifteen packages Tasks 2–6 were expected to install — and `radix-ui` is
not among them because nobody knew `shadcn init` would pull it. ADR-0023 and
ADR-0024 scope ADR-0021 because reality contradicted specific claims it _made_.
This contradicts nothing; it is a decision ADR-0021 never took. Adding two rows
to a dated measurement table would misrepresent that table as a live inventory,
which is what a third scoping ADR in one day would really have been recording.
The pin itself is now protected by a test rather than a table — see
"Consequences".

## Measurements

Taken on the installed tree at `f11b42b`, Node 24.19.0 / pnpm 11.20.0.

|                                                  | `radix-ui@1.6.7`                     | `@radix-ui/react-slot@1.3.3` |
| ------------------------------------------------ | ------------------------------------ | ---------------------------- |
| direct dependencies declared                     | **55**                               | 2                            |
| `@radix-ui/*` packages materialised in the store | **60**                               | 1                            |
| disk, package itself                             | 1.0 MB                               | **68 KB**                    |
| disk, package + its `@radix-ui/*` closure        | **6.5 MB**                           | 68 KB                        |
| lines added to `pnpm-lock.yaml`                  | **481** of the 1962 the commit added | —                            |
| `sideEffects`                                    | `false`                              | `false`                      |
| bytes in any client chunk of the shipped build   | **0**                                | 0                            |

That last row is the one that reframes the trade. `grep -rl radix
apps/web/.next/static/chunks` after a production build returns nothing: with
`sideEffects: false` and only `Slot` imported, the other 59 primitives are
tree-shaken out entirely. **The umbrella costs no bundle size.** What it costs is
install weight, lockfile churn, and supply-chain surface — 60 packages that
`pnpm audit` and any future advisory must consider, in exchange for one 68 KB
one.

## Decision

**Keep `radix-ui`, pinned to `1.6.7`.** `apps/web/src/components/ui/button.tsx`
imports `Slot` from it, as the generator wrote.

The deciding reason is not the measurement — it is that the shadcn registry
emits this import. Every component `shadcn add` produces today imports its
primitives from `radix-ui`. Rewriting Button to `@radix-ui/react-slot` does not
stay rewritten: it makes every future `shadcn add` produce a file that
contradicts the one before it, and the choice has to be re-litigated by whoever
runs the command next, who will usually just accept the generator's output. The
repository would then carry both spellings, both installed, which is strictly
worse than either.

This is the same reasoning that decided the rest of the shadcn reconciliation in
`f11b42b`: fight the generator where it is wrong about _this application_
(it wrote a second colour system, a duplicate `cn`, a Geist font import and four
unpinned dependencies, all removed), and follow it where it is merely expressing
its own conventions.

## Alternatives

- **`@radix-ui/react-slot` alone.** 68 KB against 6.5 MB, one package against 60. Rejected on the churn argument above, not on the numbers — if the numbers
  were the whole story this would win. Reconsider if the registry ever stops
  emitting `from "radix-ui"`, or if `shadcn add` is retired from this repository
  in favour of hand-written components, at which point the narrow package is
  strictly better and the migration is one import line.
- **Hand-write `Slot`.** It is about forty lines of `cloneElement` plus ref
  merging. Rejected: ref forwarding across React 19's transition is exactly the
  kind of thing that looks right and is subtly wrong, and this buys a
  maintenance obligation to save a dependency that costs nothing at runtime.
- **Drop `asChild` from Button and take no Radix dependency at all.** Genuinely
  tempting for a Phase 0 skeleton — nothing uses `asChild` yet. Rejected because
  the first `<Button asChild>` wrapping a `next/link` is a certainty rather than
  a maybe, and because a Button that diverges from the registry's shape makes
  every later `shadcn add` a merge instead of a copy.

## Consequences

**Accepted:** 60 `@radix-ui/*` packages and 6.5 MB in the store for one
primitive; 481 lockfile lines that move whenever Radix publishes; 60 packages of
supply-chain surface instead of one. Install time on a cold CI checkout grows by
that closure. None of it reaches a user's browser.

**Gained:** `shadcn add <component>` produces a file whose imports already
resolve, so the reconciliation work on the next component is confined to its
class names — which is itself now enforced, by
`apps/web/test/shadcn-palette.test.ts`.

**The pin is protected by a test, not by a table.** ADR-0021's registry table
records what was measured on one day; it cannot notice a caret arriving later,
and in fact did not — `shadcn init` added four dependencies at ranges
(`^0.7.1`, `^1.6.7`, `^1.30.0`, `^4.16.2`) and only a human reading the diff
caught them. `packages/typescript-config/test/dependency-pins.test.ts` now walks
every workspace manifest and fails on any caret, tilde, range, star or dist-tag,
so the property "exact pins, no ranges" is enforced for `radix-ui` and for
everything else at the same time. That test, not this ADR, is what keeps
`1.6.7` from drifting.

**Not re-litigated per component.** Adding a second Radix primitive is not a new
decision; it is this one already taken. A decision to _leave_ the umbrella needs
a superseding ADR.
