# Contributing to Metrika

## Before you write code

Read [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) and the [ADRs](./docs/adr/). If your change contradicts an ADR, that is fine — but write a new ADR superseding it. Do not edit an existing one; the record of why we thought something is worth keeping even when it turns out to be wrong.

Check [docs/ROADMAP.md](./docs/ROADMAP.md) for which phase the work belongs to and what its definition of done is.

## Setup

See [docs/LOCAL_DEVELOPMENT.md](./docs/LOCAL_DEVELOPMENT.md).

## Workflow

```bash
git switch -c feat/quote-expiry-sweeper
# ... work ...
pnpm verify          # format + lint + typecheck + unit — the same gates CI runs
git commit           # conventional commits, enforced by commitlint
```

Branches: `feat/*`, `fix/*`, `chore/*`, `docs/*`, `refactor/*`. Squash merge into `main`.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/), scoped by package:

```
feat(pricing-engine): add quantity discount component
fix(models): reject STL with mismatched header triangle count
docs(adr): supersede ADR-0009 after ts-rest spike
```

Two conventions that apply to every commit:

- **Commit every change.** Do not leave the working tree dirty at the end of a piece of work, and commit each logical unit as you go rather than batching unrelated changes together.
- **No AI attribution in commit messages.** Do not add `Co-Authored-By` trailers for AI models or any equivalent. Commits are authored by the repository owner regardless of what tooling assisted.

## Definition of done

A change is ready when **all** of these hold:

- [ ] `pnpm verify` passes
- [ ] CI passes, including the cross-tenant IDOR suite
- [ ] Coverage targets for the touched packages are met ([docs/TESTING.md](./docs/TESTING.md))
- [ ] No `any`. No unjustified `@ts-expect-error`. No unjustified `eslint-disable`. No skipped tests without a linked issue
- [ ] Database changes ship as a reviewed migration that is expand/contract-safe
- [ ] New endpoints appear in the generated OpenAPI and the typed client
- [ ] New asynchronous work is idempotent by a **database constraint**, not by an application check
- [ ] Anything that can fail has observability — a span, a metric, or a log with correlation IDs
- [ ] Security-relevant changes name the control they rely on
- [ ] Documentation is updated in the same pull request

## Non-negotiables

These are enforced mechanically. If you find yourself fighting one, the design is probably wrong, not the rule.

| Rule | Enforcement |
|---|---|
| No `any`; parse external data with Zod | `no-explicit-any` + `no-unsafe-*` as errors |
| No floating-point money | `bigint` minor units; lint rule on Prisma field names |
| No `process.env` outside `config/env.ts` | `no-restricted-properties` |
| No Prisma outside `infrastructure/persistence` | `no-restricted-imports` zone |
| No `Date`/`Math`/`crypto`/IO inside `workflows/**` | dedicated ESLint profile |
| No Prisma entity as an API response | response types come from `packages/contracts` |
| No state field written outside `transition()` | lint rule on Prisma `update` |
| No unversioned pricing or manufacturing profile | schema design; publish flow |

## Suppressions

Every suppression carries a justification, and CI fails without one:

```ts
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Three.js GLTF result is untyped upstream; validated on the next line
```

`@ts-ignore` is banned outright. Use `@ts-expect-error`, which at least fails when the underlying error disappears.

## Tests

Write the test first for anything in a pure kernel — `packages/pricing-engine`, authorization policies, state machines. These are 100%-coverage packages and the tests are cheap because the code is pure.

Pricing changes must update golden files. **The diff in the golden files is the review.** If a change moves prices, that must be visible in the pull request.

Security controls need a fixture asserting rejection with the correct error code. A control without a test is an intention.

## Adding a dependency

Justify it. The bar rises with the layer:

- `packages/contracts` — Zod only. Nothing else, ever.
- `packages/pricing-engine` — `contracts` and a decimal library.
- Everything else — prefer the standard library, then a well-maintained small dependency, then a framework.

Pin infrastructure and tool versions exactly. Renovate is configured to exclude the slicer image; upgrading it is a deliberate, reviewed event.

## Documentation

Documentation lives with the code and changes with it. Where drift can be detected mechanically it is — the repository tree in `ARCHITECTURE.md` is checked against the actual directory listing, and the environment table against the Zod schemas.

Every module directory carries a short `README.md` stating its responsibility and allowed dependencies.
