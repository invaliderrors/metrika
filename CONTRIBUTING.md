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
pnpm verify          # format:check + build + lint + typecheck + unit — CI's `verify` job
pnpm test:integration # if you touched packages/database, apps/api or apps/workers; Docker must be running
git commit           # conventional commits — a convention today; commitlint is not installed yet
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

- [ ] `pnpm verify` passes — it is `format:check` **+ `build`** + `lint` + `typecheck` + `test:unit`, in that order, and the `build` is not incidental: `lint` and `typecheck` both depend on `^build`, so a workspace dependency that does not compile has to fail as a build
- [ ] `pnpm test:integration` passes locally if the change touches `packages/database`, `apps/api` or `apps/workers`. Neither `pnpm verify` nor any other local gate can see what it sees — an `import type` on an injected provider, an RLS policy that stops isolating, a probe that answers 200 while its dependency is down, a stack trace escaping the exception filter, or an S3 addressing style the endpoint rejects are all green under lint, types and unit tests
- [ ] CI passes — all five jobs: `verify`, `integration`, `web` (Playwright against a production build of `apps/web`), `openapi` and `contracts` (the generated pydantic models, diffed). From Phase 1 that includes the cross-tenant IDOR suite, which does not exist yet
- [ ] Coverage targets for the touched packages are met ([docs/TESTING.md](./docs/TESTING.md))
- [ ] No `any`. No unjustified `@ts-expect-error`. No unjustified `eslint-disable`. No skipped tests without a linked issue
- [ ] Database changes ship as a reviewed migration that is expand/contract-safe
- [ ] New endpoints appear in the regenerated `apps/api/openapi/openapi.json`, committed in the same pull request — CI's `openapi` job re-emits it and fails on a diff. `packages/api-client`, the typed client generated from it, arrives in Phase 1 (roadmap 1.8) — Plan 0B-2 built the web shell, not the client
- [ ] New asynchronous work is idempotent by a **database constraint**, not by an application check
- [ ] Anything that can fail has observability — a span, a metric, or a log with correlation IDs
- [ ] Security-relevant changes name the control they rely on
- [ ] Documentation is updated in the same pull request

## Non-negotiables

These are enforced mechanically. If you find yourself fighting one, the design is probably wrong, not the rule.

Each rule's enforcement lands with the code it protects, so some of the rows below name a control that is not installed yet. Live today: the `any` rules, the `process.env` restriction, the Prisma and `@metrika/database` import zones, the `$queryRawUnsafe` / `$executeRawUnsafe` ban, and the three `apps/web` zones — no `@metrika/database` / `@metrika/pricing-engine` / `@prisma/client`, `'use server'` only in the two paths ADR-0015 names, and no deep import into another feature's internals. The `workflows` ESLint profile is live — it is composed into `apps/api` and scoped to `src/workflows/**`, which does not exist yet, so the rule landed before the code it constrains; the money, `transition()` and versioning rules arrive with the schemas they apply to.

| Rule                                               | Enforcement                                           |
| -------------------------------------------------- | ----------------------------------------------------- |
| No `any`; parse external data with Zod             | `no-explicit-any` + `no-unsafe-*` as errors           |
| No floating-point money                            | `bigint` minor units; lint rule on Prisma field names |
| No `process.env` outside `config/env.ts`           | `no-restricted-properties`                            |
| No Prisma outside `infrastructure/persistence`     | `no-restricted-imports` zone                          |
| No `Date`/`Math`/`crypto`/IO inside `workflows/**` | dedicated ESLint profile                              |
| No Prisma entity as an API response                | response types come from `packages/contracts`         |
| No state field written outside `transition()`      | lint rule on Prisma `update`                          |
| No unversioned pricing or manufacturing profile    | schema design; publish flow                           |

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

Documentation lives with the code and changes with it. Where drift can be detected mechanically it is — today that means `.env.example` against `apps/api`'s Zod schema (`apps/api/test/env-example.test.ts`, a unit test, so `pnpm verify` fails on drift) and `apps/api/openapi/openapi.json` against the emitted document (CI's `openapi` job). A mechanical check of the repository tree in `ARCHITECTURE.md` against the actual directory listing is intended and does not exist yet; until it does, that tree is maintained by hand and is the first thing to check when a document looks stale.

Every module directory should carry a short `README.md` stating its responsibility and allowed dependencies. That starts with the feature modules in Phase 1 — `apps/api`'s current tree is a runtime skeleton, and nothing in it has module READMEs yet.
