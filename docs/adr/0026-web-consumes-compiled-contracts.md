# ADR-0026 — `apps/web` consumes compiled `dist/` too, so ADR-0020's scoping sentence is wrong

**Status:** Accepted · **Date:** 2026-08-10 · **Scopes:** two statements in [ADR-0020](./0020-internal-package-build-output.md) about which consumers are affected. ADR-0020's decision — internal packages `apps/api` imports at runtime emit compiled `dist/` behind a conditional `exports` map — stands unchanged, and so does everything it says about why.

## Context

ADR-0020 was written before `apps/web` existed, and it drew a boundary around its own decision twice:

> Next.js and Vitest are unaffected by any of this: `transpilePackages` and Vitest's resolver both handle `.ts` sources directly […] The defect is specific to "a consumer that executes compiled JavaScript with no loader" — in this repository, that is `apps/api`, and nothing else so far.

and, in its Consequences:

> Packages Next.js and Vitest consume directly […] keep ADR-0001's zero-build inner loop unchanged.

Plan 0B-2 built `apps/web`, and the premise turned out not to hold. **`apps/web` does not set `transpilePackages`.** It resolves `@metrika/contracts` exactly as `apps/api` does — through the conditional `exports` map, at `dist/`.

Measured during Plan 0B-2 Task 8, on a tree where `packages/contracts` had not been built: `apps/web` fails to typecheck with **`TS2307`**, unable to find the module. That is also why the CI `web` job's `pnpm build` step is load-bearing rather than incidental, and why a clean clone must build before it can typecheck.

The scoping sentence was reasonable when written — it described the consumers that existed. It stopped being true the moment a second consumer arrived, and nothing flagged it, because a claim about "nothing else so far" cannot be tested.

## Decision

ADR-0020's decision is unchanged and is **not** scoped to `apps/api`. Any internal package that `apps/web` or `apps/api` imports at runtime emits compiled `dist/` behind a conditional `exports` map, and its consumers build before they typecheck.

The two statements above are corrected here rather than in ADR-0020, which is immutable. `docs/ARCHITECTURE.md` §5, `docs/TYPESCRIPT_AND_TOOLING.md` §5 and `docs/LOCAL_DEVELOPMENT.md` already describe the corrected behaviour; this record is what makes the ADR trail agree with them.

## Consequences

**Accepted:** ADR-0001's zero-build inner loop now survives only for packages that no runtime consumer imports — a smaller set than ADR-0020 anticipated, and one that will keep shrinking. The honest framing is that the build step is the default and the zero-build loop is the exception, which is the reverse of how ADR-0001 put it.

**Gained:** The ADR trail stops asserting a boundary that measurement has removed. A reader arriving at ADR-0020 and concluding "Next.js is unaffected, so my new Next-facing package can stay source-only" would ship a package that fails `tsc` on a clean checkout and works on their machine.

**Not decided here:** whether `apps/web` _should_ use `transpilePackages`. It currently does not, the `dist/` path works, and adding it would reintroduce two resolution modes for the same package — but that is a trade worth making deliberately if the inner loop becomes painful, not a defect to fix in passing.

## Alternatives

- **Correct ADR-0020 in place.** Forbidden: ADRs are immutable apart from a status line, and this repository has held that line through three supersessions and three scoping ADRs.
- **Fix only the prose docs.** That is what Plan 0B-2 Task 8 did, and it left the ADR trail — the thing a reader consults for _why_ — still asserting the opposite. ADR-0021's falsified claims got scoping ADRs on the same branch; the identical situation was being handled two different ways.
- **Add `transpilePackages` to `apps/web`** so ADR-0020's sentence becomes true again. Rejected: changing the code to match a document is the wrong direction, and it would give one package two resolution modes.
