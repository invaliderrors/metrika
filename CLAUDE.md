# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

Phase 0A and Plan 0B-1 are complete: the monorepo and quality gates,
`packages/contracts`, `packages/database` (Prisma + RLS + soft delete),
`packages/testing` (Testcontainers Postgres) and `apps/api` (NestJS on Fastify,
health probes, OpenAPI 3.1) exist and are tested. `apps/web` and `apps/workers`
do not exist yet — Plans 0B-2 and 0B-3 build them.

Read [`docs/ROADMAP.md`](./docs/ROADMAP.md) before starting work and confirm
which phase and which sub-plan the work belongs to.

Do not scaffold `apps/` or `packages/` ad hoc — Phase 0 defines the exact order and contents, and skipping it produces a repo the later phases assume does not exist.

The blueprint is the source of truth. If a request conflicts with it, say so and either follow the blueprint or write an ADR superseding the relevant decision — do not silently diverge.

## Commands

Working today: `verify` (format:check + build + lint + typecheck + test:unit),
`build`, `test:integration` (Docker required), `infra:up`/`infra:down`/`infra:reset`,
`db:generate`/`db:migrate`/`db:deploy`/`db:reset`/`db:studio` (all from the
repository root — they load the root `.env` and pass `--schema` explicitly; a
bare `pnpm exec prisma` inside `packages/database` cannot find
`DATABASE_ADMIN_URL`), and `pnpm --filter @metrika/api dev`.
Not yet created (Plans 0B-2/0B-3): `dev` across all runtimes, `test:e2e`,
`db:seed`, `contracts:emit`.

```bash
pnpm verify                    # format:check + build + lint + typecheck + test:unit — the gate to run before claiming done
pnpm build                     # tsc -b per package, topological through Turbo
pnpm lint                      # eslint --max-warnings=0 across the workspace
pnpm typecheck                 # tsc -b --force (the --force is load-bearing; see .github/workflows/ci.yml)
pnpm test:unit
pnpm test:integration          # Testcontainers; Docker must be running
pnpm infra:up | infra:down | infra:reset   # postgres, redis, minio, mailpit
pnpm db:generate | db:migrate | db:deploy | db:reset | db:studio
pnpm --filter @metrika/api dev # the only runtime that exists yet
pnpm --filter @metrika/api openapi:emit    # regenerate apps/api/openapi/openapi.json; CI fails if this produces a diff
```

Single test: `pnpm --filter @metrika/api test:unit -- <pattern>` (Vitest).
Local infrastructure: `pnpm infra:up` (postgres, redis, minio, mailpit — `temporal` and `temporal-ui` land in Plan 0B-3). See [`docs/LOCAL_DEVELOPMENT.md`](./docs/LOCAL_DEVELOPMENT.md).

CI runs three jobs on every pull request: `verify` (the gates above plus the two
suppression greps), `integration` (`pnpm test:integration` against
Testcontainers), and `openapi` (re-emits the document and fails on a diff).

## Architecture in one paragraph

Metrika turns an uploaded 3D model into a binding, reproducible manufacturing quote. **Modular monolith + stateless workers + durable workflows**: `apps/api` (NestJS/Fastify) owns all business logic, authorization and persistence and is the only writer to Postgres; `apps/workers` (Python) does geometry analysis and slicing as stateless compute with **no database credentials**; `apps/web` (Next.js) is presentation only; Temporal Cloud orchestrates the multi-minute pipelines. Full detail in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

**Everything is subordinate to one property:** an accepted quote must be reconstructible indefinitely, after every profile, rule and slicer version has changed. That is why configuration is immutably versioned, inputs are content-addressed, and the pricing kernel is pure. Do not trade this away for convenience.

## Rules that are easy to break and expensive to fix

These are the mistakes most likely to be made here. Each is enforced by lint, types or a database constraint — if you are fighting one, the design is probably wrong, not the rule.

**Versioning and reproducibility**

- Never read `currentVersionId` from anywhere in the quote chain. It exists for admin UI convenience only. A quote resolves and stores a `*VersionId` at creation and never looks at the pointer again.
- Never mutate a `PUBLISHED` version entity. Correct a mistake by publishing a new version; the wrong one stays in history.
- Every manufacturing-relevant config (`PrintProfile`, `PrinterProfile`, `MaterialProfile`, `PricingRuleSet`) is Identity + immutable Version. See [`docs/DOMAIN_MODEL.md`](./docs/DOMAIN_MODEL.md#1-the-organising-principle).

**Money and units**

- Money is `bigint` minor units + currency + **explicit exponent**. On the wire `amountMinor` is an **integer** string (base-10 digits, optional leading `-`, no decimal point — `"350000"`, never `"3500.00"`). Never `number`, never `Float`, never an implicit exponent (COP renders wrong without it).
- `Money` deliberately does **not** cross-check `exponent` against `CURRENCY_REGISTRY`. Pinning a stored value to today's registry would make an old quote unparseable the moment a currency's used exponent changes, which breaks the reconstruct-indefinitely property. The gap that leaves — a request supplying an `exponent` that contradicts its `currency` — is closed at the **API request boundary** in `apps/api`, where today's registry is the right authority. Already-persisted `Money` is never revalidated against it.
- Every physical quantity carries its unit in its name (`lengthMm`, `massG`, `volumeMm3`, `durationS`). The five that flow into money are branded types.
- Rounding happens at exactly two declared points, using the policy stored on the rule-set version. The total is authoritative; a `ROUNDING_ADJUSTMENT` line reconciles displayed lines to it.

**Geometry**

- The slicer gets `SLICE_INPUT_3MF` (repaired, full resolution). The browser gets `PREVIEW_GLB` (decimated). **Never slice the preview** — it silently under-reports material.
- Exact results (watertight, manifold, triangle count, AABB, volume) get typed columns. Heuristics (wall thickness, overhangs, fragility) live in JSONB with `{value, method, confidence}` and are labelled as heuristics in the UI. A `BLOCKER`-severity issue may only ever have `certainty: EXACT`.
- A non-watertight mesh has **no volume**. Return `null`, never a plausible-looking number.
- No geometry work inside an HTTP request. Ever.

**Boundaries**

- `@prisma/client` may only be imported from `apps/api/src/infrastructure/persistence/**`.
- **Never `import type` a class used in NestJS constructor injection.** It erases
  the `design:paramtypes` metadata Nest resolves against and produces
  `UnknownDependenciesException` at boot. `tsc` exits 0 and ESLint reports
  nothing — the only guard is the app-boot integration test.
- `@metrika/database` is restricted exactly like `@prisma/client`: importable
  only from `apps/api/src/infrastructure/persistence/**`.
- `$queryRawUnsafe` and `$executeRawUnsafe` are banned everywhere, persistence
  included. Use the tagged-template forms.
- **`packages/testing` must not depend on `packages/database`, in either
  dependency block.** The edge runs one way: `database` and `api` depend on
  `testing`. Adding the reverse makes Turbo's `^build` graph cyclic and every
  `pnpm build` fails with `Cyclic dependency detected`. That is why
  `startDatabase()` takes the migrations location as an option and
  `withDatabase()` takes a client factory.
- **Every Prisma CLI call goes through the root `db:*` scripts.** Prisma's
  dotenv search never reaches the repository root, so
  `cd packages/database && pnpm exec prisma …` fails with
  `Environment variable not found: DATABASE_ADMIN_URL` on a correctly
  configured machine.
- Soft-deleted rows are revealed by `withDeleted(fn)` — a scoped function, so
  "forgot to turn filtering back on" is not a reachable state. Do not add a
  flag or a second client.
- `process.env` may only be read in `apps/api/src/config/env.ts` and `apps/web/src/config/env.ts`.
- `packages/contracts` imports nothing but `zod`. `packages/pricing-engine` imports only contracts + `decimal.js` — no framework, no I/O, no `Date`, no `Math.random`.
- `apps/web` must not import `packages/database` or `packages/pricing-engine`. Prices are computed server-side; a client-side recomputation is a second source of truth.
- Workers never touch Postgres. They receive activity args, read/write S3 under scoped IAM, return structured results.

**Authorization**

- Policies take the **loaded resource**, not an ID — this forces load-then-authorize, which forces the tenant predicate into the query.
- Every repository method requires an `AuthContext`. Roles come from our database, never from the JWT's claims.
- Postgres RLS is the backstop, not the primary control. Both, always.

**Async and state**

- Workflow code (`apps/api/src/workflows/**`) must be deterministic: no `Date`, `Math`, `crypto`, `node:*` or infrastructure imports. Do side effects in activities.
- Every async operation is idempotent by a **database unique constraint**, not an application check. A constraint is a guarantee; a check is a hope.
- State fields are only ever written through `transition()`, which validates against the declared table and writes a `StatusTransition` row in the same transaction. No booleans for lifecycle state.
- `Order` carries customer-facing states only. Manufacturing states live on `ManufacturingJob`.

**Frontend**

- Server state lives in TanStack Query and is never mirrored into Zustand. SSE events write into the query cache via `setQueryData` — one cache, one read path.
- Exactly two Zustand stores exist (`viewerStore`, `uploadStore`), both feature-scoped. There is no `useAppStore`.
- Server Actions are for cookies, the SSE relay, and Vercel-side form posts only. **No domain mutations.** See [ADR-0015](./docs/adr/0015-server-actions.md).
- Upload progress is real bytes. Never fake a progress bar.

**Types and tests**

- No `any`, no exceptions. External data is `unknown` and is parsed with Zod. `@ts-ignore` is banned; `@ts-expect-error` and `eslint-disable` require a `-- <justification>` or CI fails.
- Vitest, not Jest. Zod contracts, not class-validator DTOs. Cursor pagination, not offset.
- `packages/pricing-engine`, authorization policies and state machines are 100% coverage. Pricing changes must update golden files — **the golden-file diff is the review**.
- A security control without a fixture asserting rejection with the correct error code is an intention, not a control.

## Git

- **Commit every change.** Do not leave the working tree dirty at the end of a task. Commit each logical unit as you go rather than batching unrelated work into one commit.
- **Do not add `Co-Authored-By` trailers for AI models, or any other AI attribution, to commit messages.** Commits are authored by the repository owner.
- Conventional commits, scoped by package: `feat(pricing-engine): add quantity discount component`.
- Branches `feat/*`, `fix/*`, `chore/*`, `docs/*`; squash merge into `main`.
- `pnpm verify` before claiming work is done. Definition of done is in [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Documentation

- **ADRs are immutable.** Supersede with a new ADR; never edit an existing one.
- Documentation changes ship in the same commit as the code they describe.
- Adding a dependency to `packages/contracts` or `packages/pricing-engine` requires justification — those two have deliberately tiny dependency surfaces.
