# Metrika — Implementation Roadmap

> Sixteen phases in dependency order. Every task names its repository location, its contracts, its database impact, its tests and its definition of done. This document is meant to be executed from, not admired.

**Sequencing note.** One change from the original phase list: **the pricing engine (Phase 7) moves before slicing infrastructure (Phase 6)**. The pricing kernel is pure, has zero infrastructure dependency, is the highest-risk business logic in the system, and can be developed and golden-file tested against synthetic slice metrics. Building it first means Phase 6 has a real consumer to validate against and front-loads the work most likely to expose domain misunderstandings. Phases are numbered by their original identity, executed in the order shown in §Execution order.

---

## Scope classification

| Feature                                                            | MVP | V1  | V2  | Future |
| ------------------------------------------------------------------ | :-: | :-: | :-: | :----: |
| Email/Google/Microsoft signup                                      |  ●  |     |     |        |
| Personal + team organizations, invitations, 4 roles                |  ●  |     |     |        |
| Projects, models, model versions                                   |  ●  |     |     |        |
| STL / OBJ / 3MF upload, multipart, checksum                        |  ●  |     |     |        |
| Geometry analysis — exact metrics                                  |  ●  |     |     |        |
| Geometry heuristics — thickness, overhangs                         |  ●  |     |     |        |
| Conservative auto-repair + repair log                              |  ●  |     |     |        |
| Destructive repair with customer approval                          |     |  ●  |     |        |
| GLB preview generation + LOD                                       |  ●  |     |     |        |
| 3D viewer: orbit, ortho, grid, dimensions, bbox, overhangs, issues |  ●  |     |     |        |
| Cross-section, wireframe, component selection                      |     |  ●  |     |        |
| Layer preview from G-code                                          |     |     |  ●  |        |
| Architectural scale (ratio / target size) + fit check              |  ●  |     |     |        |
| Unit ambiguity detection + confirmation                            |  ●  |     |     |        |
| Print configuration with curated presets                           |  ●  |     |     |        |
| Advanced parameter overrides (admin)                               |     |  ●  |     |        |
| Real slicing (OrcaSlicer) + content-addressed cache                |  ●  |     |     |        |
| Versioned pricing engine + trace                                   |  ●  |     |     |        |
| Admin pricing management + publish preview diff                    |  ●  |     |     |        |
| Promotions, customer-specific pricing                              |     |  ●  |     |        |
| Quotes: lifecycle, expiry, acceptance                              |  ●  |     |     |        |
| Multi-item quotes and orders                                       |     |  ●  |     |        |
| Payments: one Colombian provider, PSE + card                       |  ●  |     |     |        |
| Orders + customer-facing state machine                             |  ●  |     |     |        |
| Manufacturing jobs + operator tracking + actuals capture           |  ●  |     |     |        |
| Shipping and tracking                                              |     |  ●  |     |        |
| Minimal internal admin (route group)                               |  ●  |     |     |        |
| Full ops platform (`apps/admin`)                                   |     |  ●  |     |        |
| Transactional email (es-CO)                                        |  ●  |     |     |        |
| In-app notifications                                               |     |  ●  |     |        |
| WhatsApp / SMS                                                     |     |     |  ●  |        |
| `en-US` locale                                                     |     |  ●  |     |        |
| Resin (SLA) as a second technology                                 |     |  ●  |     |        |
| Automatic model segmentation                                       |     |     |  ●  |        |
| Auto-orientation                                                   |     |     |  ●  |        |
| Printer integration (OctoPrint, Klipper)                           |     |     |  ●  |        |
| Printer telemetry over WebSockets                                  |     |     |  ●  |        |
| Partner manufacturing network                                      |     |     |     |   ●    |
| Multi-region manufacturing, data residency                         |     |     |     |   ●    |
| Enterprise SSO / SCIM                                              |     |     |     |   ●    |
| CAD conversion (STEP / IFC / RVT)                                  |     |     |     |   ●    |
| Public quoting API for third parties                               |     |     |     |   ●    |

---

## Phase 0 — Foundations

**Objective.** A repository where every gate that will protect the project for the next two years already works, and a "hello world" flows end to end through every runtime.

**Deliverables**

| #    | Task                                                                                                                                                                                                     | Location                                                                      |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 0.1  | ✅ pnpm workspace + Turborepo pipeline (`typecheck`, `lint`, `test:unit`, `test:integration`, `build`), remote cache                                                                                     | root                                                                          |
| 0.2  | ✅ `packages/typescript-config` — `base`, `node`, `react-library`, `next`, `nest` configs with every flag from [TYPESCRIPT_AND_TOOLING.md](./TYPESCRIPT_AND_TOOLING.md)                                  | `packages/typescript-config`                                                  |
| 0.3  | ✅ `packages/eslint-config` — flat config profiles: `base`, `typeChecked`, `react`, `next`, `nest`, `workflows`, `test`, `boundaries`                                                                    | `packages/eslint-config`                                                      |
| 0.4  | ✅ Prettier (exact-pinned) + `.editorconfig` + `ruff` + `mypy --strict` for Python                                                                                                                       | root, `apps/workers`                                                          |
| 0.5  | ✅ `packages/contracts` skeleton: `Brand` helper, all branded IDs, `Money`, unit types, `Result`, `assertNever`, `DomainErrorCode`, canonical JSON hashing                                               | `packages/contracts/src`                                                      |
| 0.6  | ✅ `packages/database`: Prisma init, `createPrismaClient()` with RLS + soft-delete extensions, migration harness                                                                                         | `packages/database`                                                           |
| 0.7  | ✅ `apps/api` skeleton: Nest + Fastify, `config/env.ts` (Zod), exception filter, request-context middleware, `/health/{live,ready,deep}`                                                                 | `apps/api/src`                                                                |
| 0.8  | ✅ `apps/web` skeleton: Next App Router, Tailwind, shadcn init, `config/env.ts`, root layout, `next-intl` with `es-CO`                                                                                   | `apps/web/src`                                                                |
| 0.9  | ✅ `apps/workers`: uv workspace, `metrika_core` (settings via pydantic-settings, S3 client, structlog, Temporal base), geometry + slicer entrypoint stubs                                                | `apps/workers`                                                                |
| 0.10 | ✅ `docker-compose.yml`: postgres, redis, minio, temporal, temporal-ui, mailpit — all six, each pinned by exact tag in [IMAGE_PINS.md](../infra/docker/IMAGE_PINS.md) and each with a healthcheck        | `infra/docker`                                                                |
| 0.11 | OpenTelemetry bootstrap in API and workers; correlation ID propagation across all three runtimes; Pino + structlog with the redaction list                                                               | `apps/api/src/infrastructure/telemetry`, `apps/workers/packages/metrika_core` |
| 0.12 | ✅ GitHub Actions CI with every gate from [INFRASTRUCTURE.md](./INFRASTRUCTURE.md#4-cicd)                                                                                                                | `.github/workflows`                                                           |
| 0.13 | ◐ `packages/testing`: Testcontainers harnesses for Postgres, Redis, MinIO, Temporal test env — Postgres and Temporal done; Redis and MinIO follow their consumers                                        | `packages/testing`                                                            |
| 0.14 | Terraform `shared` state: ECR, state bucket, GitHub OIDC role                                                                                                                                            | `infra/terraform/shared`                                                      |
| 0.15 | ✅ **Spike: ts-rest viability.** Verify against the chosen Zod major, Nest+Fastify, and OpenAPI 3.1 emission. Decide and record in an ADR. **Outcome: ts-rest failed; `nestjs-zod` adopted in ADR-0019** | throwaway branch                                                              |
| 0.16 | Root docs: `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, ADRs 0001–0018                                                                                                                                 | root, `docs/`                                                                 |

✅ = done · ◐ = partially done, with the remainder named on the row.

Progress: 0.1–0.10, 0.12 and 0.15 are complete. 0.13 is partial: the Postgres
and Temporal harnesses exist in `packages/testing`; Redis and MinIO follow
their consumers. Remaining: 0.11, 0.14, and 0.13's Redis and MinIO harnesses.

0.9 ships the runtime skeleton only — a shared library, two entry points and a
stub activity each. There is no geometry, no slicing and no OrcaSlicer image;
those are Phases 3 and 6.

Caveats on the ✅ rows: several describe end-state work that lands incrementally
as the runtimes that need it are built. 0.1's Turbo remote caching is still off
— `pnpm verify` logs "Remote caching disabled" — and turning it on is gated on
a real fix, not a token: no tsconfig in this repository declares project
`references`, so `tsc -b`'s up-to-date check cannot see a workspace
dependency's `.d.ts` change, and a restored `.turbo` cache would silently
convert CI's cross-package type gate into a pass. `.github/workflows/ci.yml`
carries the measurement. 0.2 is complete — `base`, `node`, `react-library`,
`web-library`, `nest` and `next` all exist. 0.3's `react` and `next` profiles landed with
Plan 0B-2 Task 2, each with a fixture asserting a named rule reports; the
`workflows` profile landed with Plan 0B-3 Task 7, ahead of the
`apps/api/src/workflows` directory it constrains, and is composed into
`apps/api` today.
`base`, `typeChecked`, `nest`, `test` and seven boundary exports
(`contractsBoundary`, `prismaImportBoundary`, `rawSqlBan`, their `prismaBoundary`
composite, and `webBoundary`, `serverActionBoundary`, `featureBoundary` from Plan
0B-2 Task 7) exist, plus `workflows` from Plan 0B-3 Task 7. 0.4's `ruff` and
`mypy --strict` are live in `apps/workers`, wired into `pnpm lint`, `typecheck`,
`test:unit` and `format:check` through Turbo shims.
0.8 is the **shell** the row describes and no more: App Router, Tailwind v4 with
the shadcn tokens, `config/env.ts`, a localised root layout, `next-intl` on
`es-CO` and a seven-case Playwright suite. There is no data fetching, no route
group, no `packages/api-client`, no `packages/ui`, no TanStack Query, no Zustand
store and no viewer — those arrive with the phases that need them (1.8, 1.10,
Phase 4). An `en-US` catalogue exists so the structure is exercised, but nothing
serves it: `DEFAULT_LOCALE` is a constant and there is no negotiation, and the
locale itself is V1 in the scope table above.
0.12's CI now runs five jobs — `verify` (format, build, lint, typecheck, unit
tests, suppression greps), `integration` (Testcontainers Postgres), `web`
(`pnpm build` + the Playwright suite in chromium, added by Plan 0B-2 Task 8) and
`openapi` (re-emit and diff) — but the rest of
[INFRASTRUCTURE.md](./INFRASTRUCTURE.md#4-cicd)'s gate list (`contracts:emit`,
security scanning, container scanning, deploys) grows in later plans. 0.16's root docs
(`README.md`, `CONTRIBUTING.md`, `SECURITY.md`) and ADRs 0001–0018 in
[`docs/adr/`](./adr/) all predate Plan 0A and were not produced by it;
ADR-0019 and ADR-0020 were.

### Carried into Plan 0B from Plan 0A's final review

Plan 0A's whole-branch review ran 51 mutations against `packages/contracts`; 46
were killed and 5 survived, all of which were fixed. These items were
adjudicated as deferrable rather than merge-blocking. None lets a bad quote
through today; each is cheap to close and should be closed early in 0B, before
more code depends on the surface it protects.

**Blocks `apps/api` — resolve first**

1. ~~**`@metrika/contracts` exports raw TypeScript and no package has a `build`
   script.**~~ **Closed by Plan 0B-1 Task 1.** `exports` was `./src/index.ts`,
   with no `main` and no `types`, though `turbo.json` declared a `build` task.
   NestJS compiling to `dist/main.js` would have resolved the package to a
   `.ts` file and failed at runtime. `packages/contracts` now has a `build`
   script (`tsc -b tsconfig.build.json`) and a conditional `exports` map
   pointing at `dist/`, proven by a real `node` subprocess resolving the
   package by bare specifier in `test/package-exports.test.ts`. This reverses
   part of the source-only decision in ADR-0001; see
   [ADR-0020](./adr/0020-internal-package-build-output.md) for why the
   original decision was right for its assumptions and what changed.
2. ~~**No decorator support.**~~ **Closed by Plan 0B-1 Task 2.**
   `packages/typescript-config` had no `experimentalDecorators`, no
   `emitDecoratorMetadata`, and no `nest.json` or `next.json` (both named in
   row 0.2). Compounding it, `base.json` sets `verbatimModuleSyntax: true`,
   which is the known NestJS DI friction point — `import type` erases the
   constructor parameter type that `emitDecoratorMetadata` needs, producing
   runtime failures rather than compile errors. `nest.json` now sets **both**
   decorator flags, which is also what makes typescript-eslint suppress
   `consistent-type-imports` on decorated classes — with only the metadata
   flag, `pnpm lint:fix` would rewrite every Nest constructor import into the
   broken form. A fixture pins it, and the hazard itself is now a rule in
   [`CLAUDE.md`](../CLAUDE.md) because `tsc` exits 0 and ESLint says nothing:
   the only guard is `apps/api/test/boot.integration.test.ts`.
3. ~~**`composite: true` in `base.json`**~~ **Closed by Plan 0B-1 Task 2.**
   Right for project references but it fights Next.js, which rewrites
   `tsconfig.json` on `next dev`. `next.json` turns it off. A premise was
   corrected on the way: `composite: true` with `noEmit: true` is legal at
   TypeScript 6.0.3 — the old restriction was relaxed upstream.

**Test and gate gaps**

4. ~~**ID distinctness covers 11 of 55 pairs.**~~ **Closed by Plan 0B-1 Task 1.** `test/ids.test-d.ts` asserted a declaration-order ring, so an
   _adjacent_ brand collision failed but a non-adjacent one (e.g. `UserId =
brandedUuid('QuoteId')`) still passed the whole suite. It now asserts a
   `NoCollision<K>` check per ID against the union of the other ten, covering
   the full 55-pair matrix in both assignability directions — mutation-tested
   against a non-adjacent collision, an adjacent collision, a second
   independent non-adjacent collision, and a total brand loss (one ID's
   schema stops calling `.brand()`), all four confirmed to fail the specific
   assertion(s) they should and nothing else.
5. ~~**The dynamic-import boundary rule misses template literals.**~~
   **Closed by Plan 0B-1 Task 3.** The selector was narrowed to
   `ImportExpression[source.type='Literal']`, so ``import(`node:crypto`)``
   with backticks linted clean.
6. ~~**`packages/contracts/tsconfig.json` admits Node ambients into
   `src/**`.**~~ **Closed by Plan 0B-1 Task 3.** Only
   `tsc -b tsconfig.build.json` rejected `Buffer`/`__dirname`/`require`, so a
   Node global in `src/` looked clean in-editor — editors and ESLint's
   type-aware program both read `tsconfig.json` — and failed only in CI.
7. ~~**`lib` is duplicated** across `tsconfig.json` and
   `tsconfig.build.json`.~~ **Closed by Plan 0B-1 Task 2.** Divergence would
   have silently undone the browser-safety guarantee; the shared
   `web-library.json` in `@metrika/typescript-config` is now the single home.
8. ~~**`packages/typescript-config`'s local ESLint config is weaker than the
   shared one.**~~ **Closed by Plan 0B-1 Task 3.** It composed the libraries
   directly to avoid a real package cycle, and so missed the four type-aware
   rules plus `base`'s `no-restricted-properties` on `process.env`. Task 3
   also found that four boundary controls — including the
   `$executeRawUnsafe` ban and the `ignores` glob deciding whether
   `apps/api`'s persistence layer may import Prisma — had no fixture at all
   and stayed green when deleted. All four now gate by exit code.

**Domain obligations**

9. ~~**Validate `Money.exponent` against `CURRENCY_REGISTRY` at the API request
   boundary.**~~ **Closed by Plan 0B-1 Task 11.** `Money` deliberately does
   not, for the reason in [ADR-0014](./adr/0014-money-representation.md); the
   check now lives at the request boundary in `apps/api`, where today's
   registry is the right authority, and `apps/api/test/money-request.test.ts`
   pins both directions — a request whose `exponent` contradicts its
   `currency` is rejected, and an already-persisted `Money` is never
   revalidated against the registry.
10. ~~**Add `ORDER_NOT_FOUND` to `DomainErrorCode`**~~ **Closed by Plan 0B-1
    Task 11**, alongside the HTTP-status mapping it was waiting for. Every
    `DomainErrorCode` now has a status, enforced by the type system in one
    direction and by a runtime test in the other; no known domain failure maps
    to 500.
11. ~~**The production Docker base image** is still pinned to
    `node:22-bookworm-slim`~~ **Closed by Plan 0B-1 Task 13.** Both
    [ARCHITECTURE.md](./ARCHITECTURE.md) and
    [INFRASTRUCTURE.md](./INFRASTRUCTURE.md) now name
    `node:24-bookworm-slim`, matching the major pinned in `.nvmrc`. The tag
    names the major; the digest that Plan 0D's Dockerfile pins names the
    bytes. No Dockerfile exists yet — this closed the documentation half only.

**Contracts.** `Brand<T,K>`, every `*Id`, `Money`, `Millimeters`/`Grams`/`Seconds`/`CubicMillimeters`, `Result<T,E>`, `DomainErrorCode`, `canonicalJson()` + `sha256Canonical()`.

**Database.** Initial migration: none beyond a health-check table. RLS helper functions and the `app.current_org_id` convention established.

**Tests.** Config fixture tests (files that must and must not lint/compile); canonical-hashing property tests; Testcontainers harness self-test; a smoke test proving a request traverses web → API → Temporal → Python worker with one correlation ID.

**Observability.** Correlation propagation working end to end. This must be Phase 0 — retrofitting it means touching every log call in the codebase.

**Security.** Gitleaks in CI and pre-commit; Dependabot/Renovate configured; base images pinned by digest.

**Definition of done.** `pnpm verify` passes on a clean clone. CI green. A trace spanning all three runtimes is visible in Grafana with a single request ID. ADR-0019 records the contract-layer decision with evidence, superseding ADR-0009.

**Dependencies.** None. **Risks.** R6, R12, R16.

---

## Phase 1 — Identity, Organizations & Projects

**Objective.** Multi-tenancy that is correct by construction, with authorization enforced at three independent layers.

**Deliverables**

| #    | Task                                                                                                                                                                                   | Location                                                  |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 1.1  | Clerk integration: JWKS verification, `AuthContext` construction, Nest guard, Next middleware                                                                                          | `apps/api/src/modules/auth`, `apps/web/src/features/auth` |
| 1.2  | `UsersModule`: local `User` with `externalAuthId`, first-login provisioning, **automatic personal organization creation**                                                              | `apps/api/src/modules/users`                              |
| 1.3  | `OrganizationsModule`: organizations, members, roles, invitation issue/accept/revoke with hashed tokens; last-owner protection inside the transaction                                  | `apps/api/src/modules/organizations`                      |
| 1.4  | `ProjectsModule`: CRUD, org scoping, cursor pagination                                                                                                                                 | `apps/api/src/modules/projects`                           |
| 1.5  | **Authorization layer**: `Action`/`Resource` unions in contracts; pure policy functions per resource; `@Policy()` decorator + guard; `AuthContext` required on every repository method | `apps/api/src/authorization`                              |
| 1.6  | **Postgres RLS**: enable on every tenant table; Prisma extension setting `app.current_org_id` per transaction; separate elevated client for platform admins with mandatory audit       | `packages/database/src`                                   |
| 1.7  | `AuditModule`: append-only `AuditLog`, injected `AuditRecorder`, no update/delete grants on the table for the app role                                                                 | `apps/api/src/modules/audit`                              |
| 1.8  | `packages/api-client`: client factory, auth injection, request IDs, retry policy, typed errors, TanStack Query hooks                                                                   | `packages/api-client`                                     |
| 1.9  | Web: signup/login, org switcher, member management, invitation acceptance, project list/detail                                                                                         | `apps/web/src/features/{auth,organizations,projects}`     |
| 1.10 | `packages/ui`: Button, Input, Select, Dialog, DataTable, Toast, Card, Badge, tokens                                                                                                    | `packages/ui`                                             |
| 1.11 | Terraform `staging`: VPC + endpoints, RDS, ECS cluster, ALB, secrets                                                                                                                   | `infra/terraform/envs/staging`                            |

**Contracts.** `organizationsContract`, `projectsContract`, `usersContract`; `AuthContext`, `OrganizationRole`, `PlatformRole`, `PolicyResult`.

**Database.** `User`, `Organization`, `OrganizationMember`, `OrganizationInvitation`, `PlatformRoleAssignment`, `Project`, `AuditLog`, `StatusTransition`. RLS policies on all tenant tables. Indexes: `(organizationId, createdAt DESC)`, unique `(organizationId, userId)`, unique `Organization.slug`, unique `User.email`.

**APIs.** `/organizations`, `/organizations/:id/members`, `/organizations/:id/invitations`, `/invitations/:token/accept`, `/projects` (CRUD + cursor list), `/me`.

**Events.** `OrganizationCreated`, `MemberInvited`, `MemberJoined`, `MemberRemoved`.

**Tests.** Policy truth tables at 100% branch. **The cross-tenant IDOR suite, generated from the route table** — this is the phase where it is built. RLS tests with the application check bypassed. Invitation expiry and revocation. Last-owner-removal rejection. E2E: signup → create org → invite → accept → create project.

**Security.** IDOR suite green. Invitation tokens hashed at rest. Roles read from the database only, never from the JWT. Every elevated-client use audited.

**Definition of done.** A user in org A cannot reach any resource of org B through any endpoint, verified by the automated suite, with RLS proven to catch it independently.

**Dependencies.** Phase 0. **Risks.** R4, R16.

---

## Phase 2 — Upload Infrastructure

**Objective.** A confidential file moves from a browser to private storage without touching the API, and is verified.

**Deliverables**

| #   | Task                                                                                                                                   | Location                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 2.1 | `StorageModule`: S3 adapter, key namespaces, presigned single + multipart, HEAD verification, lifecycle policy definitions             | `apps/api/src/infrastructure/storage`  |
| 2.2 | `ModelsModule`: `Model`, `ModelVersion`, `UploadSession`, `FileAsset`; upload-session creation, completion verification, state machine | `apps/api/src/modules/models`          |
| 2.3 | Generic state-machine helper: transition table type, `transition()` writing entity + `StatusTransition` + event in one transaction     | `apps/api/src/shared/state-machine`    |
| 2.4 | Transactional outbox: table, Prisma helper, poller with `FOR UPDATE SKIP LOCKED`, Temporal starter                                     | `apps/api/src/infrastructure/temporal` |
| 2.5 | Rate limiting + per-org quotas in Redis                                                                                                | `apps/api/src/shared/rate-limit`       |
| 2.6 | Web upload UX: drag-and-drop, streaming SHA-256 in a Web Worker, real progress, cancel, retry, multipart orchestration                 | `apps/web/src/features/models`         |
| 2.7 | Orphan cleanup job: abandoned sessions, unreferenced objects                                                                           | `apps/api/src/workflows/cleanup`       |
| 2.8 | Terraform: S3 buckets, lifecycle rules, KMS keys, CloudFront distribution for previews                                                 | `infra/terraform/modules/storage`      |

**Contracts.** `CreateUploadSessionRequest/Response`, `CompleteUploadRequest`, `ModelVersionState`, `FileAssetNamespace`, `ModelVersionResponse`.

**Database.** `Model`, `ModelVersion`, `FileAsset`, `UploadSession`, `OutboxEvent`. Unique `(modelId, versionNumber)`. Partial index on `OutboxEvent WHERE processedAt IS NULL`.

**APIs.** `POST /model-versions/upload-session`, `POST /upload-sessions/:id/complete`, `DELETE /upload-sessions/:id`, `GET /model-versions/:id`.

**Events.** `ModelVersionUploaded` (via outbox).

**Tests.** Integration against MinIO: single and multipart, checksum mismatch, size mismatch, expired session, double completion. Outbox at-least-once delivery under concurrent writers. Rate-limit integration tests. E2E: real fixture file upload with progress.

**Security.** Presigned URLs with 5-minute TTL and content-length conditions; buckets private with Block Public Access; SSE-KMS; upload URLs never logged; extension allowlist and size gates before any URL is issued.

**Observability.** `metrika_upload_total{result}`, upload duration histogram, outbox lag gauge.

**Definition of done.** A 500 MB file uploads directly to S3 with real progress and resumes after a cancelled part; the API never sees a model byte; a duplicate completion is a no-op.

**Dependencies.** Phase 1. **Risks.** R4, R10.

---

## Phase 3 — Geometry Analysis

**Objective.** A file becomes trustworthy structured knowledge, with hostile input contained and units resolved.

**Deliverables**

| #    | Task                                                                                                           | Location                                               |
| ---- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 3.1  | Geometry worker: format sniffing, sandboxed parsing, archive/XML guards, rlimits, tmpfs scratch                | `apps/workers/geometry/src/metrika_geometry`           |
| 3.2  | Exact metrics module (volume `null` when not watertight)                                                       | `.../analysis/exact.py`                                |
| 3.3  | Heuristics module with `{value, method, confidence}` envelopes                                                 | `.../analysis/heuristics.py`                           |
| 3.4  | **Unit inference + plausibility bounds**; `unitInterpretation` construction                                    | `.../units.py`                                         |
| 3.5  | Conservative repair + `RepairLog` emission                                                                     | `.../repair.py`                                        |
| 3.6  | Preview generation: decimation, LOD, GLB export, compression; thumbnail                                        | `.../preview.py`                                       |
| 3.7  | Slice-input generation: full-resolution unit-normalised 3MF                                                    | `.../slice_input.py`                                   |
| 3.8  | `ModelProcessingWorkflow` + activities, with `confirmUnits` and `approveDestructiveRepair` signals             | `apps/api/src/workflows/model-processing`              |
| 3.9  | `GeometryModule`: persist analysis, issues, derivatives; analysis read endpoints; unit confirmation endpoint   | `apps/api/src/modules/geometry`                        |
| 3.10 | SSE progress endpoint + Redis pub/sub fan-out + `Last-Event-ID` resume                                         | `apps/api/src/modules/models/api/events.controller.ts` |
| 3.11 | Web: processing status UI, analysis results, **unit confirmation card showing implied real and printed sizes** | `apps/web/src/features/geometry-analysis`              |
| 3.12 | `fixtures/models/` + generator script; every fixture from [TESTING.md](./TESTING.md#5-geometry-tests)          | `fixtures/models`                                      |
| 3.13 | Terraform: geometry worker services (small + large), no-egress networking, autoscaling on queue depth          | `infra/terraform/envs/*`                               |
| 3.14 | **Decisions:** wall-thickness algorithm; Meshopt vs Draco. Resolved by measurement, recorded in ADRs           | —                                                      |

**Contracts.** `GeometryAnalysisResult`, `GeometryIssue`, `UnitInterpretation`, `HeuristicValue<T>`, `ModelDerivativeKind`, `RepairOperation`, `ModelProcessingEvent`.

**Database.** `GeometryAnalysis`, `GeometryIssue`, `ModelDerivative`, `RepairLog`. Unique `(modelVersionId, analyzerVersion)`, `(modelVersionId, kind, producerVersion)`. Check constraint: destructive repairs require `approvedByUserId`.

**APIs.** `GET /model-versions/:id/analysis`, `POST /model-versions/:id/confirm-units`, `POST /model-versions/:id/approve-repair`, `GET /model-versions/:id/preview-url`, `GET /model-versions/:id/events` (SSE).

**Events.** `ModelAnalysisCompleted`, `ModelAnalysisFailed`, `ModelUnitsAmbiguous`.

**Tests.** Every fixture asserts a specific outcome including exact error codes for hostile files. Hypothesis property tests (scaling invariants, repair monotonicity, unit-normalisation idempotence). Workflow tests with the time-skipping environment including the 7-day unit timeout. SSE reconnection with `Last-Event-ID`.

**Security.** **This is the phase where the primary attack surface lands.** No network egress, no DB credentials, read-only root, tmpfs scratch, non-root, capabilities dropped, `RLIMIT_AS`/`RLIMIT_CPU`, `defusedxml`, zip guards, OBJ reference stripping. Every control has a fixture test.

**Observability.** `metrika_analysis_duration_seconds`, `metrika_analysis_total{result}`, `metrika_model_triangles`, `metrika_units_ambiguous_ratio`.

**Definition of done.** All hostile fixtures rejected with correct codes. The ambiguous-units fixture blocks at `AWAITING_UNIT_CONFIRMATION` and cannot be quoted. A 20 M-triangle model either completes on the large queue or fails cleanly at the limit — never OOMs the task.

**Dependencies.** Phase 2. **Risks.** R1, R5, R7.

---

## Phase 4 — 3D Viewer

**Objective.** The flagship surface. An architect recognises their building and understands its problems.

**Deliverables**

| #    | Task                                                                                               | Location                                  |
| ---- | -------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 4.1  | `coordinates.ts` — `MM_TO_SCENE`, `PRINTER_TO_SCENE`, the only place these exist                   | `apps/web/src/features/model-viewer/lib`  |
| 4.2  | `ModelViewer` shell: Canvas, Suspense, error boundary, `frameloop="demand"`, context-loss recovery | `.../components`                          |
| 4.3  | GLB loading with lazy decoder, LOD swap, **mandatory disposal**                                    | `.../hooks/useModelGeometry.ts`           |
| 4.4  | Controls: orbit/zoom/pan, perspective ↔ orthographic, camera presets, fit-to-view                  | `.../components/ViewerControls.tsx`       |
| 4.5  | Build plate + mm grid from `PrinterProfileVersion`                                                 | `.../components/BuildPlate.tsx`           |
| 4.6  | Dimension annotations (printed mm + real-world equivalent at current scale)                        | `.../components/DimensionAnnotations.tsx` |
| 4.7  | Overhang shader overlay                                                                            | `.../components/OverhangOverlay.tsx`      |
| 4.8  | Issue highlighting from `GeometryIssue.detail.faceIndices`                                         | `.../components/IssueHighlight.tsx`       |
| 4.9  | Wireframe + transparency modes                                                                     | `.../components`                          |
| 4.10 | `viewerStore` (Zustand): camera mode, overlay toggles, selection — **ephemeral UI state only**     | `.../hooks/useViewerStore.ts`             |
| 4.11 | Bundle budget check in CI                                                                          | `.github/workflows`                       |

**Contracts.** No new API contracts — consumes analysis and derivative endpoints.

**Tests.** Mount/unmount ×50 memory test asserting return to baseline. Coordinate-conversion unit tests. Component tests for overlay toggles. E2E: load a model, toggle every overlay, switch camera modes, reset.

**Observability.** Viewer load duration, GLB size, decode duration, WebGL context-loss counter.

**Definition of done.** A 300 k-triangle model is interactive within 1.5 s of GLB fetch. Memory returns to baseline after 50 mount/unmount cycles. The viewer chunk is lazily loaded and under 400 KB gzip.

**Dependencies.** Phase 3. **Risks.** R9.

---

## Phase 5 — Print Configuration

**Objective.** Curated, typed, validated manufacturing choices — including the architectural scale feature.

**Deliverables**

| #   | Task                                                                                                                         | Location                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 5.1 | `MaterialsModule`: `Material`, `MaterialProfileVersion`, `MaterialColor`, publish flow                                       | `apps/api/src/modules/materials`                                   |
| 5.2 | `PrintersModule`: `PrinterProfile` + versions, build volumes, capabilities                                                   | `apps/api/src/modules/printers`                                    |
| 5.3 | `PrintProfilesModule`: customer-facing presets + internal advanced parameters                                                | `apps/api/src/modules/print-profiles`                              |
| 5.4 | Generic versioning helper: content hashing, publish/archive, `currentVersionId` pointer discipline                           | `apps/api/src/shared/versioning`                                   |
| 5.5 | `ConfigurationModule`: assembly, compatibility validation, override allowlist, content hashing                               | `apps/api/src/modules/configuration`                               |
| 5.6 | **`ScaleSpec` + fit check** as pure functions                                                                                | `packages/contracts` + `apps/api/src/modules/configuration/domain` |
| 5.7 | Web: configuration form (RHF + Zod), material/colour picker, **scale control with live printed-size preview**, fit indicator | `apps/web/src/features/print-configuration`                        |
| 5.8 | Seed data: 3 printer profiles, 4 materials, 4 print profiles                                                                 | `packages/database/src/seed`                                       |

**Contracts.** `PrintConfigurationRequest`, `ScaleSpec`, `Orientation`, `FitResult`, `MaterialSummary`, `PrintProfileSummary`, `SupportStrategy`.

**Database.** `Material`, `MaterialProfileVersion`, `MaterialColor`, `PrinterProfile`, `PrinterProfileVersion`, `PrintProfile`, `PrintProfileVersion`, `PrinterProfileMaterialCompatibility`, `PrintConfiguration`. Unique `(profileId, versionNumber)`, `(profileId, contentHash)`, `(modelVersionId, contentHash)`.

**APIs.** `GET /materials`, `GET /print-profiles`, `GET /printer-profiles`, `POST /print-configurations/validate`, `POST /print-configurations/fit-check`.

**Tests.** Fit-check unit tests including rotation and clearance-margin edges. Non-uniform `TARGET_BBOX` rejection. Content-hash stability property test. Compatibility-validation matrix. E2E: configure at 1:100 and see printed dimensions and fit status.

**Definition of done.** The 18.4 m × 12.7 m × 7.2 m worked example from [DOMAIN_MODEL.md](./DOMAIN_MODEL.md#5-scale--the-architectural-differentiator) produces 184 × 127 × 72 mm and a correct fit verdict. An identical reconfiguration reuses the existing `PrintConfiguration` row.

**Dependencies.** Phase 3. **Risks.** R1.

---

## Phase 7 — Pricing Engine _(executed before Phase 6)_

**Objective.** The pure kernel. Deterministic, versioned, traced, 100% covered — built against synthetic slice metrics so it needs no infrastructure.

**Deliverables**

| #    | Task                                                                                                    | Location                                  |
| ---- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 7.1  | `PricingComponent` union, rule-set payload schema, `engineSchemaVersion`                                | `packages/contracts/src/pricing`          |
| 7.2  | `computePrice()` — pure, `Result`-returning, phase-ordered evaluation                                   | `packages/pricing-engine/src`             |
| 7.3  | Money arithmetic + `RoundingPolicy` + `ROUNDING_ADJUSTMENT` reconciliation                              | `packages/pricing-engine/src/money.ts`    |
| 7.4  | Trace construction                                                                                      | `packages/pricing-engine/src/trace.ts`    |
| 7.5  | Rule-set validation (phase ordering, referential completeness)                                          | `packages/pricing-engine/src/validate.ts` |
| 7.6  | `PricingModule`: `PricingRuleSet` + versions, publish flow, **publish preview diff over recent quotes** | `apps/api/src/modules/pricing`            |
| 7.7  | `TaxConfiguration` + jurisdiction resolution                                                            | `apps/api/src/modules/pricing/domain`     |
| 7.8  | Golden-file corpus                                                                                      | `packages/pricing-engine/test/__golden__` |
| 7.9  | Admin UI: rule-set editor, diff preview, publish                                                        | `apps/web/src/app/(admin)/pricing`        |
| 7.10 | Seed: one published rule set with a full component chain + one draft                                    | `packages/database/src/seed`              |

**Contracts.** `PricingRuleSetPayload`, `PricingComponent`, `PricingTrace`, `PricingTraceLine`, `RoundingPolicy`, `TaxConfigurationSnapshot`, `PriceInput`, `PriceOutput`.

**Database.** `PricingRuleSet`, `PricingRuleSetVersion`, `TaxConfiguration`.

**APIs.** `GET/POST /admin/pricing-rule-sets`, `POST /admin/pricing-rule-sets/:id/versions`, `POST /.../versions/:v/preview-diff`, `POST /.../versions/:v/publish`.

**Events.** `PricingRuleSetPublished` (audited).

**Tests.** **100% line and branch.** Golden files for every component kind and combination phase. Property tests: determinism, line-sum reconciliation, monotonicity, non-negativity. Schema-version compatibility both directions. Publish-diff correctness.

**Security.** Publishing requires an elevated platform role and writes an `AuditLog` entry. Published versions are immutable.

**Definition of done.** 100% coverage. The worked example in [PRICING_ENGINE.md](./PRICING_ENGINE.md#4-worked-example) reproduces exactly. Publishing a new version provably does not alter any existing quote.

**Dependencies.** Phase 0 only — deliberately. **Risks.** R2, R16.

---

## Phase 6 — Slicing Infrastructure

**Objective.** Real manufacturing metrics, reproducibly, with duplicate work impossible.

**Deliverables**

| #   | Task                                                                                     | Location                                           |
| --- | ---------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 6.1 | `SlicerEngine` port + `SlicingModule`                                                    | `apps/api/src/modules/slicing`                     |
| 6.2 | **Cache-key computation** using canonical hashing, with `cacheKeySchemaVersion`          | `apps/api/src/modules/slicing/domain/cache-key.ts` |
| 6.3 | Slicer worker: profile rendering, override allowlist, subprocess with limits, heartbeats | `apps/workers/slicer/src/metrika_slicer`           |
| 6.4 | G-code + `--info` parser with cross-check tolerance                                      | `.../parser.py`                                    |
| 6.5 | `FakeSlicerEngine` (deterministic)                                                       | `packages/testing/src/fakes`                       |
| 6.6 | Slicer container: pinned binary, `PROVENANCE.md`                                         | `infra/docker/slicer`                              |
| 6.7 | Regression suite + nightly workflow                                                      | `apps/workers/slicer/tests`                        |
| 6.8 | Terraform: slicer service on Fargate Spot, queue-depth autoscaling                       | `infra/terraform/envs/*`                           |

**Contracts.** `SliceRequest`, `SliceOutput`, `SliceMetrics`, `SlicerVersion`, `SlicerCapabilities`, `SlicingError`.

**Database.** `SliceJob` (**unique `cacheKey`**), `SliceResult`.

**Events.** `SliceCompleted`, `SliceFailed`.

**Tests.** Parser tests against committed G-code fixtures. Cache-key stability property tests. Duplicate-key concurrency test (two simultaneous identical requests → one slice). Nightly regression within ±2% mass / ±5% time. Non-retryable failures asserted not to retry.

**Security.** Override allowlist enforced — config injection into the CLI is a real attack surface. Same sandbox as the geometry worker.

**Observability.** `metrika_slice_duration_seconds`, `metrika_slice_total{result,cached}`, `metrika_slice_cache_hit_ratio`.

**Definition of done.** The same configuration sliced twice runs the slicer once. Changing any versioned input changes the cache key. `slicerVersion` is recorded on every result.

**Dependencies.** Phases 5, 7. **Risks.** R3, R11.

---

## Phase 8 — Quote Experience

**Objective.** The commercial artefact: immutable, reproducible, expiring, acceptable.

**Deliverables**

| #   | Task                                                                                               | Location                                     |
| --- | -------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 8.1 | `QuotesModule`: lifecycle, state machine, immutable snapshotting, supersession                     | `apps/api/src/modules/quotes`                |
| 8.2 | `QuoteWorkflow`: validate → fit-check → cache lookup → slice → price → persist                     | `apps/api/src/workflows/quote`               |
| 8.3 | Lazy expiry on read + sweeper job for notifications                                                | `apps/api/src/modules/quotes`                |
| 8.4 | `PriceEstimate` endpoint (`isEstimate: true`, never a `Quote`)                                     | `apps/api/src/modules/quotes/api`            |
| 8.5 | Web: quote view with **price breakdown from the trace**, expiry countdown, reconfigure → new quote | `apps/web/src/features/quotes`               |
| 8.6 | Quote PDF generation                                                                               | `apps/api/src/modules/quotes/infrastructure` |

**Contracts.** `CreateQuoteRequest`, `QuoteResponse`, `QuoteState`, `QuoteSummary`, `PriceEstimateRequest/Response`.

**Database.** `Quote`, `QuoteItem`. Unique `(printConfigurationHash, pricingRuleSetVersionId)` per model version. Partial index `Quote(state) WHERE state='READY'`.

**APIs.** `POST /quotes`, `GET /quotes/:id`, `GET /quotes/:id/events` (SSE), `GET /quotes` (list), `POST /price-estimates`.

**Events.** `QuoteReady`, `QuoteFailed`, `QuoteExpired`.

**Tests.** State-machine exhaustiveness. Expired quote cannot be accepted (both lazy and swept paths). Reconfiguration supersedes rather than mutates. **Reproducibility test: re-evaluate an old quote's stored inputs and assert the identical total.** E2E: upload → configure → quote → see breakdown.

**Definition of done.** A quote is fully reproducible from stored references after every profile and rule set has been republished. An expired quote is unacceptable through every path.

**Dependencies.** Phases 6, 7. **Risks.** R2.

---

## Phase 9 — Checkout & Payments

**Objective.** Money, safely, with a provider that can be changed.

**Deliverables**

| #   | Task                                                                                                                                  | Location                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 9.1 | `PaymentProvider` port designed around **redirect + async webhook**                                                                   | `apps/api/src/modules/payments/application/ports` |
| 9.2 | First Colombian adapter (Wompi or Mercado Pago — decided here) with PSE + card                                                        | `.../infrastructure/providers`                    |
| 9.3 | `FakePaymentProvider`                                                                                                                 | `packages/testing/src/fakes`                      |
| 9.4 | Webhook endpoint: raw-body HMAC verification, timestamp window, `WebhookEvent` dedupe, immediate 200, async processing                | `.../api/webhooks.controller.ts`                  |
| 9.5 | `Payment` + `Refund` entities and state machines                                                                                      | `.../domain`                                      |
| 9.6 | `Idempotency-Key` middleware                                                                                                          | `apps/api/src/shared/idempotency`                 |
| 9.7 | Web checkout: address, method selection, redirect handling, return page that **polls server state rather than trusting the redirect** | `apps/web/src/features/checkout`                  |

**Contracts.** `CreatePaymentIntentRequest/Response`, `PaymentState`, `PaymentMethod`, `RefundRequest`.

**Database.** `Payment`, `Refund`, `WebhookEvent` (**unique `(provider, providerEventId)`**), `Address`.

**Events.** `PaymentSucceeded`, `PaymentFailed`, `RefundProcessed`.

**Tests.** Forged-signature rejection. Duplicate webhook → single effect. Out-of-order webhook handling. `Idempotency-Key` replay (same body → cached response; different body → 409). E2E with the fake provider.

**Security.** Raw-body verification **before** JSON parsing. Secrets in Secrets Manager. No card data touches Metrika. Refunds require an elevated role and are audited.

**Definition of done.** Browser-reported success never changes order state. A webhook delivered three times has one effect.

**Dependencies.** Phase 8. **Risks.** R8.

---

## Phase 10 — Orders

**Objective.** The commercial record, atomically created, with manufacturing states kept out of it.

**Deliverables**

| #    | Task                                                                              | Location                                   |
| ---- | --------------------------------------------------------------------------------- | ------------------------------------------ |
| 10.1 | `OrdersModule`: `Order`, `OrderItem` with **denormalised snapshot at acceptance** | `apps/api/src/modules/orders`              |
| 10.2 | **Quote acceptance transaction** — the most important transaction in the system   | `.../application/accept-quote.use-case.ts` |
| 10.3 | Customer-facing order state machine + projection from manufacturing jobs          | `.../domain`                               |
| 10.4 | `OrderFulfillmentWorkflow`                                                        | `apps/api/src/workflows/order-fulfillment` |
| 10.5 | `NotificationsModule` + email adapter + localised templates                       | `apps/api/src/modules/notifications`       |
| 10.6 | Web: order list, detail, timeline, invoice download                               | `apps/web/src/features/orders`             |

**Contracts.** `AcceptQuoteRequest`, `OrderResponse`, `OrderState`, `OrderItemSnapshot`, `NotificationTemplateKey`.

**Database.** `Order` (**unique `quoteId`**), `OrderItem`, `Notification`.

**Events.** `QuoteAccepted`, `OrderCreated`, `OrderCancelled`.

**Tests.** Double acceptance → one order (concurrency test). Accepting an expired quote → 410. Snapshot immutability after the source quote is archived. Order-state projection unit tests. E2E: accept → pay → order created.

**Definition of done.** Quote acceptance and order creation are atomic. A double-click creates exactly one order. `Order` carries no manufacturing states.

**Dependencies.** Phase 9. **Risks.** —

---

## Phase 11 — Manufacturing Operations

**Objective.** Operational reality, and the calibration loop that protects margin.

**Deliverables**

| #    | Task                                                                                                          | Location                                 |
| ---- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 11.1 | `ManufacturingModule`: `ManufacturingJob`, `PrintJob`, independent state machines                             | `apps/api/src/modules/manufacturing`     |
| 11.2 | `packages/printer-sdk`: `PrinterDriver` interface, `Null`/`Manual`/`Simulator` drivers, **conformance suite** | `packages/printer-sdk`                   |
| 11.3 | `Printer` entity with `driverKind: MANUAL`                                                                    | `.../domain`                             |
| 11.4 | **Actuals capture** (`actualPrintSeconds`, `actualMassG`) in the operator UI                                  | `apps/web/src/app/(admin)/manufacturing` |
| 11.5 | **`EstimateCalibrationJob`**: deviation analysis by profile, alerting                                         | `apps/api/src/workflows/calibration`     |
| 11.6 | Ops UI: job queue, assignment, status transitions, G-code download, reprint                                   | `apps/web/src/app/(admin)`               |
| 11.7 | Admin: users, orgs, quotes, orders, failed jobs, manual price override (audited)                              | `apps/web/src/app/(admin)`               |

**Contracts.** `ManufacturingJobState`, `PrintJobState`, `PrinterDriver`, `PrinterCapabilities`, `PrinterTelemetry`, `RecordActualsRequest`.

**Database.** `ManufacturingJob`, `PrintJob`, `Printer`.

**Events.** `ManufacturingJobCreated/Completed/Failed`, `PrintJobStarted/Succeeded/Failed`.

**Tests.** Manufacturing state machine exhaustiveness. Order-state projection from job states. Reprint creates a new `PrintJob` with an incremented attempt. Driver conformance suite against the simulator. Calibration job correctness against synthetic actuals.

**Observability.** `metrika_estimate_deviation_ratio{profile}` with alerting at 15% median deviation.

**Definition of done.** A paid order flows to completion through operator actions with no hardware. Actuals are captured on every completed job and the calibration report is produced.

**Dependencies.** Phase 10. **Risks.** R2, R15.

---

## Phase 12 — Observability & Hardening

**Objective.** Know what is happening; survive what goes wrong.

**Deliverables.** Full dashboards (Platform Health, Pipeline, Business, Cost) and alert routing with runbooks · load testing with k6 against the documented budgets · **external penetration test** · WAF rules · backup restore drill with a recorded RTO · DR runbook · production Terraform environment · migration safety CI checks · per-endpoint query-count budgets · bundle-size CI gates · chaos exercises (kill a worker mid-slice; interrupt Spot capacity; expire a Temporal activity).

**Definition of done.** Every alert has a runbook. A restore drill has been performed and timed. Penetration-test findings are triaged, with criticals fixed. All performance budgets are measured and met.

**Dependencies.** Phase 11. **Risks.** R4, R11.

---

## Phase 13 — Production Launch

**Objective.** Real customers, real money, with the legal questions answered.

**Deliverables.** **AGPL legal review completed (launch gate)** · **Ley 1581 compliance review completed (launch gate)** · terms and privacy policy · production Clerk and payment provider credentials · real printer profiles and materials replacing seed data · **initial pricing rule set calibrated and reviewed** · support runbooks · status page · beta with 5–10 friendly architecture studios · feedback loop into the calibration job.

**Definition of done.** Both legal reviews are cleared in writing. A paying customer has completed upload → quote → payment → delivered order. The first calibration report has been reviewed and the rule set adjusted.

**Dependencies.** Phase 12. **Risks.** R2, R3, R17.

---

## Phase 14 — Printer Integration

**Objective.** Replace operator actions with machine telemetry. **No domain changes.**

**Deliverables.** `OctoPrintDriver` and `KlipperDriver` passing the existing conformance suite · `printer-gateway` service holding WebSocket connections on an isolated network · assignment scheduler as a pure function over queued jobs and printers, accounting for material changeover · live telemetry in the ops UI · automatic actuals capture replacing manual entry · printer utilisation metrics.

**Definition of done.** A job dispatches to a physical printer and completes without operator state changes. **The `PrintJob` state machine is unchanged from Phase 11** — that is the test of whether the abstraction worked.

**Dependencies.** Phase 13 + hardware. **Risks.** R15.

---

## Phase 15 — Advanced Features

Automatic segmentation with keyed joints · auto-orientation optimisation · layer preview from G-code · cross-section with capped stencil rendering · resin (SLA) as a second technology with its own geometry checks and slicer · `en-US` locale · multi-item orders and shipping · full `apps/admin` extraction · partner manufacturing capacity.

Each of these is a spec → plan → build cycle of its own. None is a prerequisite for a viable business.

---

## Execution order

```
0 → 1 → 2 → 3 → 4 ─┐
              ↓    │
              5 ───┼→ 6 → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15
              7 ───┘
```

Phase 7 (pricing) has no infrastructure dependency and is the natural thing to build while waiting on anything in 3–6. Phase 4 (viewer) is independent of 5–7 and is the best context-switch when backend work stalls.

## Per-phase definition of done — the constant part

Every phase, in addition to its specific criteria: `pnpm verify` green · CI green including the cross-tenant IDOR suite · package coverage targets met · migrations reviewed and expand/contract-safe · new endpoints in the generated OpenAPI and the typed client · new async work idempotent by a database constraint · observability (span, metric or correlated log) for anything that can fail · no unjustified `eslint-disable`, `@ts-expect-error`, or skipped test · the risk register reviewed and updated · relevant documentation updated in the same pull request.
