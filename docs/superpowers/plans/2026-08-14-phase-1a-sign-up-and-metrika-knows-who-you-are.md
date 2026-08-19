# Phase 1A — Sign up, and Metrika knows who you are Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A visitor completes Clerk sign-up and lands on a page rendering their own display name and the personal organization Metrika created for them, fetched from `GET /api/v1/me` over a bearer token this API verified — with the tenant boundary enforced by Postgres itself from the first row, and with no authorization layer, no elevated client, no browser data layer and no tenant-scoped resource yet.

**Architecture:** This is the slice that turns three empty properties into machinery. Identity comes from Clerk and stops there: `Organization`, `OrganizationMember` and every role are ours, and an `organizationId` in a request is a claim verified against membership, never a fact read from a JWT (ADR-0012). Tenancy is a transaction-local Postgres setting that every RLS policy reads, and the migration that creates a table carries its policy — because `FORCE` plus `WITH CHECK` retrofitted onto a populated table turns a working query into a silent deny-all, and `packages/database/test/migration-sql.test.ts:35-49` only polices tables that already say `ENABLE`. Provisioning is idempotent by a database unique constraint rather than an application pre-check, because a constraint is a guarantee and a check is a hope.

**Tech Stack:** Clerk (`@clerk/backend`, `@clerk/nextjs`), Prisma 7 + Postgres RLS, NestJS on Fastify, `nestjs-zod`, Next.js App Router, Vitest, Testcontainers, Playwright.

## Prerequisites

| Task | What needs it                                                                                                                                                                          |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3    | Docker for the integration suites (Testcontainers starts its own Postgres) **and `pnpm infra:up` plus a root `.env` carrying `DATABASE_ADMIN_URL`** for the migration authoring itself |
| 4    | Docker — `tenant-context.integration.test.ts` only                                                                                                                                     |
| 8    | A Clerk **development** instance, for the browser half only. See the fallback below.                                                                                                   |

```bash
docker info > /dev/null 2>&1;                     echo "DOCKER=$?"
grep -q '^DATABASE_ADMIN_URL=' .env;              echo "ADMIN_URL=$?"
node -e "net=require('node:net');s=net.connect(5432,'127.0.0.1',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1))"; echo "POSTGRES=$?"
```

All three expected **0**. If `DOCKER` is not 0, start Docker Desktop; `pnpm test:integration` cannot run without it (`docs/LOCAL_DEVELOPMENT.md`).

**Task 3's compose dependency is real and the table used to deny it.** Step 3 opens with
`pnpm db:migrate --create-only`, which is `prisma migrate dev --create-only`: it connects to
`DATABASE_ADMIN_URL` (`packages/database/prisma.config.ts` is
`datasource: { url: env('DATABASE_ADMIN_URL') }`) and creates a **shadow database** to diff the
schema against. Testcontainers is not involved in that command at all, and Prisma 7 does no
dotenv loading — the root `.env` reaches it only through `--env-file-if-exists` in the root
`db:*` script (ADR-0037). With no `infra:up` the first command of the task fails, and the failure
names Prisma config rather than a missing container.

**THERE ARE NO CLERK CREDENTIALS ON THIS MACHINE, AND THIS PLAN IS WRITTEN SO THAT ONLY TASK 8 NEEDS ANY.** `.env.example` has no `CLERK_*` key today; `apps/api/src/config/env.ts`'s `EnvSchema` declares none; and `@clerk/backend` / `@clerk/nextjs` appear nowhere in `pnpm-lock.yaml`. Tasks 1 and 5 are built around that:

- **Task 1's spike must produce a way to mint and verify a token with no Clerk instance** — a locally generated RS256 keypair, a JWKS document served or injected in-process, and a token signed with the issuer/audience the verifier expects. Every negative fixture in Task 5 (forged signature, wrong issuer, expired, `kid` not in the key set) then runs in `verify` and `integration` with no network and no account. If the spike cannot make that work, the whole authentication half of Phase 1 is untestable in CI and that is a finding, not an inconvenience — record it and stop.
- **Task 8's browser sign-up is the one thing a real instance is required for.** Create a free Clerk development instance and put its publishable and secret keys in `.env` (never in `.env.example`, which is committed). **If no instance can be created**, take the stated fallback: `apps/web` still ships the provider, the routes and the middleware; `pnpm build` still passes on publishable-key-shaped placeholders; and the Playwright assertion is narrowed to _the unauthenticated visitor is redirected to the sign-in route and the skip link is still the first focusable element_. The signed-in journey then moves to 1C, which owns the full E2E anyway. Write down which of the two shipped.

```bash
grep -c CLERK .env.example; echo "EXIT=$?"     # expected 0 matches today
```

## Task tiering

Each task is marked **REVIEW** or **SELF-VERIFIED**. Reviewed tasks get a fresh reviewer and a fix loop; self-verified tasks are trusted on their own mutation evidence unless they report a deviation or a green mutation. The split is by blast radius, not by size — and for a slice whose subject is the tenant boundary, almost everything is blast radius.

| Task                                               | Tier              | Why                                                                        |
| -------------------------------------------------- | ----------------- | -------------------------------------------------------------------------- |
| 1 — the Clerk spike and ADR-0038                   | **REVIEW**        | Decides every auth pin, and whether CI can test auth at all                |
| 2 — the contracts fork and ADR-0039                | **REVIEW**        | Rewrites a gate every later slice depends on                               |
| 3 — the first real migration, RLS and ADR-0040     | **REVIEW**        | The backstop; a wrong predicate is corrected by `ALTER`, never `DROP`      |
| 4 — the tenancy primitive and ADR-0041             | **REVIEW**        | Freezes every repository signature in every later phase                    |
| 5 — the auth guard and `AuthContext`               | **REVIEW**        | Security control; roles must come from our database, never from the JWT    |
| 6 — first-login provisioning                       | **REVIEW**        | Idempotency by constraint, under real concurrency                          |
| 7 — `/me`, and the HTTP infrastructure it lands    | **REVIEW**        | The validation pipe and error DTO every later route inherits               |
| 8 — `apps/web`: Clerk, sign-in, and the `/me` page | **SELF-VERIFIED** | Presentation; no credential path of its own beyond the publishable key     |
| 9 — CI, CODEOWNERS and documentation               | **REVIEW**        | The place this repository has repeatedly shipped claims that were not true |

## Global Constraints

Copy these values verbatim. Every task's requirements implicitly include this section.

- **Exact version pins, no ranges.** TypeScript `6.0.3` · ESLint `10.8.0` · Vitest `4.1.10` · Zod `4.4.3` · Prisma `7.9.1` · Nest `11.1.28` · Next `16.3.0` · React `19.2.8` · Node `24.19.0` (`.nvmrc`; `preinstall` fails on another major).
- **Every Clerk-side version is decided by Task 1's spike.** Later tasks write `<pin>` and read ADR-0038's table. A pin decided ad hoc inside a later task is a pin nobody reviewed.
- **No `any`.** External data — a JWT payload, a JWKS document, a request body — is `unknown` and parsed with Zod. `@ts-ignore` is banned. `@ts-expect-error` and `eslint-disable` need a `-- <justification>` on the same line, and CI's grep also fails if `--` appears anywhere in the path.
- **`process.env` may be read only in `apps/api/src/config/env.ts` and `apps/web/src/config/env.ts`.** A new key goes in the Zod schema **and** the root `.env.example` in the same commit: `apps/api/test/env-example.test.ts` asserts every key in `EnvSchema.shape` is documented there.
- **`@prisma/client` and `@metrika/database` are importable only from the paths `prismaImportBoundary` exempts** — today the literal glob `src/infrastructure/persistence/**/*.ts` (`packages/eslint-config/src/boundaries.js:120-122`). Task 4 decides whether that widens. `$queryRawUnsafe` and `$executeRawUnsafe` are banned everywhere, persistence included.
- **`packages/contracts` imports nothing but `zod`**, and under ADR-0019 it may hold neither `initContract().router()` nor `createZodDto()`. Contract modules are plain Zod; the DTO wrapper is one line in `apps/api` through `metrikaDto()`.
- **Every DTO goes through `metrikaDto()`** (`apps/api/src/shared/http/zod-dto.ts`). A bare `createZodDto` import anywhere else in `src/**` is an ESLint error, and without `{ codec: true }` `@ZodResponse` checks the schema's INPUT type, so a branded ID ships unvalidated.
- **Guards, pipes and interceptors throw `DomainError`, never `UnauthorizedException`/`ForbiddenException`.** A Nest 4xx's English `message` is forwarded verbatim into the user-facing `error.message` (`domain-exception.filter.ts:67-69`). `apps/api/src/modules/health/deep-health.guard.ts:59-113` is the worked example.
- **`packages/testing` must not depend on `packages/database`, in either dependency block.** Turbo's `^build` graph goes cyclic and every `pnpm build` fails. Anything new arrives as a caller-supplied option, the way `databasePackageRoot` and `createClient` already do.
- **Never `import type` a class used in NestJS constructor injection.** It erases `design:paramtypes` and produces `UnknownDependenciesException` at boot; `tsc` exits 0 and ESLint reports nothing. The only guard is `apps/api/test/boot.integration.test.ts`, so **every new injectable must be reachable from `AppModule`** or the gate does not cover it.
- **Do not add `RequestContextModule` to `AppModule.imports`.** The middleware is registered once via `app.use()` in `bootstrap.ts:118-119`; adding the module makes it run twice per prefixed request and gives the probes no request ID. Two tests fail.
- **Do not add `dangerouslyIgnoreUnhandledErrors` to `apps/api/vitest.integration.config.ts`.** A DI failure arrives as `process.abort()` from `NestFactory`; the blank test counts are the boot gate working.
- **Every async operation is idempotent by a DATABASE UNIQUE CONSTRAINT, not an application check.** On Prisma 7 the discriminator is `meta.driverAdapterError.cause.kind === 'UniqueConstraintViolation'` — **not** `code === 'P2002'` (raw SQL raises P2010 for the same event) and **never** `meta.target`, which was removed in 7 and reads `undefined` with no complaint from `tsc` (`packages/database/test/error-shape.integration.test.ts:9-33`).
- **Every Prisma CLI call goes through the root `db:*` scripts.** Prisma 7 does no dotenv loading at all; `--env-file-if-exists` in those scripts is the only thing that sets `DATABASE_ADMIN_URL`, and they run the child with `cwd = packages/database` where `prisma.config.ts` is discovered. See [ADR-0037](../../adr/0037-prisma-7-driver-adapter.md).
- **`RlsProbe` and `HealthCheck` survive this plan unchanged.** `RlsProbe` is the permanent RLS/soft-delete regression fixture and says so in `schema.prisma:17-23`; `HealthCheck` is `/health/deep`'s round-trip target and the harness's own reachability probe.
- **Nothing untrusted goes in a log `msg`.** Redaction is field-granular. `organizationId`, `requestId` and `traceId` are declared MUST_SURVIVE and must not be renamed into a redacted spelling. `email` is measured **not** redacted today — Task 2 decides whether that changes.
- **Documentation ships in the same commit as the code it describes.** ADRs are immutable — supersede, never edit, apart from a status line. `docs/adr/README.md` ends at **0037**; this plan writes 0038–0041 in task order.
- **Conventional commits, scoped by package** (`feat(api): …`). **No `Co-Authored-By` trailers or any other AI attribution.**
- **Do not add an `actions/cache` step for `.turbo`** and do not enable a Turbo remote cache — `tsc -b` skips re-checking when only a workspace dependency's `.d.ts` changed, and a fresh checkout carrying no build-info is the only reason CI catches it. See [R19](../../RISK_REGISTER.md#r19--tsc--b-skips-stale-cross-package-dependencies) and the banner at the top of `.github/workflows/ci.yml`.
- **A test that reads a file outside its own package is silently unhashed by Turbo and passes from cache.** Declare `inputs` with `$TURBO_ROOT$` and prove invalidation by mutating the outside file.
- **Gates, all from `$?` directly** — never off a pipe, since `cmd | tail; echo $?` reports `tail`'s status:
  - `pnpm verify` exit 0
  - `pnpm test:integration` exit 0 (Docker required)
  - `tsc -b --force` exit 0 for every Node package
  - `pnpm contracts:emit` then `git diff --exit-code` over `apps/workers/packages/metrika_core/src/metrika_core/contracts/` **and** `packages/contracts/redaction-corpus.json` — the second path was measured outside the gate once
  - `pnpm --filter @metrika/api openapi:emit` then `git diff --exit-code -- apps/api/openapi/openapi.json`
  - both CI suppression greps, run verbatim from `.github/workflows/ci.yml`

### Deferred out of this plan, deliberately

| Deferred                                                                                                                          | Why                                                                                                                                                                                                                                                                                                        | Lands in |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| The authorization layer (`@Policy()`, policies, truth tables), and `PolicyResult`                                                 | `/me` is self-scoped. Inventing a policy layer with no resource to authorize is how you get a layer nobody tested. `PolicyResult`'s **home** is decided here anyway (Task 2 Step 4) so 1B inherits an answer rather than a precedent                                                                       | 1B       |
| The cross-tenant IDOR suite                                                                                                       | It needs a tenant-scoped route, and it must ship **with** the first one so an undecorated route fails CI rather than an audit                                                                                                                                                                              | 1B       |
| The **100%-branch** coverage gate on `apps/api/src/authorization/policies`                                                        | That target is on policy functions, which do not exist yet. **The other target is NOT deferred**: `docs/TESTING.md:17` declares "API modules ≥ 70%" independently of it, `:21` says coverage is enforced per-package in CI, and 1A ships three API modules — so Task 9 Step 6 adds the ≥70% gate here      | 1B       |
| `packages/api-client`, TanStack Query                                                                                             | `/me` is rendered from an RSC. The browser data layer arrives with the first mutation. **1B's obligation, not an implication:** when the client lands, `/me` migrates onto it and `apps/web` stops calling `apiFetch` directly — the constant DoD wants every endpoint in the typed client, `/me` included | 1B       |
| The elevated BYPASSRLS client and `AuditModule`                                                                                   | It has no caller here. `/me`'s cross-org read is answered by the second GUC and the pre-identity read by the third pair (Task 3 Step 1) — both narrower than bypass, neither of them a bypass                                                                                                              | 1D       |
| `Project`, `OrganizationInvitation`, `PlatformRoleAssignment`, `AuditLog`, `StatusTransition`, and the Prisma `PlatformRole` enum | Each belongs to the slice that writes to it; a table with no writer is a control with no consumer, and a Postgres enum type with no column is a schema object nothing can be wrong about. **`AuthContext.platformRoles` is deferred with the table it would be read from** — see Task 5's Interfaces       | 1B–1D    |
| The four Phase 1 domain events (`OrganizationCreated`, `MemberInvited`, `MemberJoined`, `MemberRemoved`)                          | In-process Nest `EventEmitter`, per `docs/ARCHITECTURE.md:817` — no outbox, no ROADMAP 2.4 pull-forward. Their only Phase 1 subscriber is `AuditRecorder`, and §24 forbids an event with no consumer, so they ship with it. **1A emits none, deliberately.** Decomposition, Declared deviations item 6     | 1D       |
| `Address` and `Organization.billingAddressId`                                                                                     | A nullable UUID column with no referent is a fact nobody can check                                                                                                                                                                                                                                         | commerce |
| Cursor pagination, `packages/ui`, `pnpm db:seed`                                                                                  | Nothing in 1A lists a collection or renders a table                                                                                                                                                                                                                                                        | 1B, 1C   |

## What this plan does **not** build

Named explicitly so no task quietly grows into them: any policy function or `@Policy()` decorator, `PolicyResult` itself (only its **home** is decided here), the IDOR suite, `packages/api-client`, `packages/ui`, TanStack Query, either Zustand store, cursor pagination, `AuditLog`, `PlatformRoleAssignment` and `AuthContext.platformRoles`, the Prisma `PlatformRole` enum, the elevated client, invitations, projects, `pnpm db:seed`, `transition()`, the transactional outbox, **any emission of the four Phase 1 domain events**, and any locale switcher (`en-US` stays structurally identical and unserved).

## File structure

| File                                                                          | Responsibility                                                                                   | Task |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---- |
| `docs/adr/0038-clerk-integration.md`                                          | Auth pins, JWKS verification, offline token minting, middleware decision                         | 1    |
| `docs/adr/0039-contracts-typescript-only-exports.md`                          | How a Zod schema is exported without crossing to Python                                          | 2    |
| `docs/adr/0040-tenant-context-gucs.md`                                        | The three tenancy primitives, the four predicates, and the two declared `AuthContext` exemptions | 3    |
| `docs/adr/0041-repository-location.md`                                        | Where a Prisma repository may live, and the boundary's scope                                     | 4    |
| `packages/contracts/src/organization.ts`                                      | `OrganizationKind`, `OrganizationRole`, `PlatformRole`                                           | 2    |
| `packages/contracts/src/ids.ts` (modify)                                      | `OrganizationMemberId`                                                                           | 2    |
| `packages/contracts/src/auth.ts`                                              | `MeResponse`, `MembershipSummary` — TypeScript-only                                              | 2    |
| `packages/contracts/src/json-schema.ts` (modify)                              | `EMITTED` plus the declared TypeScript-only set                                                  | 2    |
| `packages/contracts/test/json-schema.test.ts` (modify)                        | The rewritten "no more, no fewer" assertion                                                      | 2    |
| `packages/database/prisma/schema.prisma` (modify)                             | `User`, `Organization`, `OrganizationMember`, two enums                                          | 3    |
| `packages/database/prisma/migrations/<ts>_identity_and_tenancy/migration.sql` | Tables, indexes, the personal-owner `CHECK`, three SQL functions, four RLS policies              | 3    |
| `packages/database/src/extensions/soft-delete.ts` (modify)                    | `SOFT_DELETABLE_MODELS` widened                                                                  | 3    |
| `packages/database/test/soft-delete-coverage.test.ts`                         | Binds the hand-written set to the models carrying `deletedAt`                                    | 3    |
| `packages/database/test/rls-coverage.integration.test.ts`                     | The catalog-driven meta-gate over every table                                                    | 3    |
| `packages/database/test/identity-rls.integration.test.ts`                     | Behavioural RLS on the three new tables, no tenant predicate anywhere                            | 3    |
| `packages/database/src/client.ts` (modify)                                    | `withTenantContext(client, scope, fn)`, `withIdentityContext(client, identity, fn)`              | 4    |
| `apps/api/src/infrastructure/persistence/branding.ts`                         | `brandUnsafe`, `newUuidV7`                                                                       | 4    |
| `apps/api/src/authorization/auth-context.ts`                                  | `AuthContext` (an interface, not a wire type) — Task 4 needs it to type `runInTenant`            | 4    |
| `apps/api/src/infrastructure/persistence/tenant-context.ts`                   | The three scope entry points, and the only module that calls either `with*Context`               | 4    |
| `packages/eslint-config/src/boundaries.js` (modify)                           | The repository-location glob and the `branding.ts` restriction                                   | 4    |
| `apps/api/src/modules/auth/**`                                                | Token verifier, `AuthContext` factory, `AuthGuard`, the identity binding onto `RequestContext`   | 5    |
| `apps/api/src/config/env.ts` (modify), `.env.example` (modify)                | `CLERK_*` keys                                                                                   | 5    |
| `apps/api/test/auth-guard.integration.test.ts`                                | Forged, expired, wrong-issuer, unknown-`kid`, and the happy path                                 | 5    |
| `apps/api/src/shared/request-context/request-context.ts` (modify)             | The identity slot `userId`/`organizationId` bind into                                            | 5    |
| `apps/api/src/modules/users/**`                                               | Provisioning use case, `UserRepository` (which owns the unit of work)                            | 6    |
| `apps/api/test/provisioning.integration.test.ts`                              | Concurrency, idempotency, slug collision                                                         | 6    |
| `apps/api/src/modules/users/api/me.controller.ts`, `me.dto.ts`                | `GET /api/v1/me`                                                                                 | 7    |
| `apps/api/src/shared/http/validation.pipe.ts`                                 | `APP_PIPE`; Zod issues into `error.details`, in Spanish                                          | 7    |
| `apps/api/src/shared/http/error-response.dto.ts`                              | The error envelope, finally a schema                                                             | 7    |
| `apps/api/src/openapi/build-document.ts` (modify)                             | The Clerk JWT security scheme beside the static `bearer`                                         | 7    |
| `apps/api/openapi/openapi.json` (regenerated)                                 | `/api/v1/me`, the error DTO, two schemes                                                         | 7    |
| `apps/web/src/middleware.ts`, `src/app/(app)/**`, `src/features/auth/**`      | Provider, sign-in/sign-up, the `/me` page — `page.tsx` is **moved**, not created (Task 8 Step 0) | 8    |
| `apps/web/messages/{es-CO,en-US}.json` (modify)                               | Every new string, identical key paths                                                            | 8    |
| `.github/CODEOWNERS`                                                          | Migrations and `sql/` — R16's stop-and-think control                                             | 9    |
| `.github/workflows/ci.yml` (modify, if measured necessary)                    | Clerk placeholders, at the scope Task 9 records                                                  | 9    |

---

### Task 1: The Clerk spike, and ADR-0038 — **REVIEW**

Every greenfield plan in this repository opened with a throwaway spike, and each one caught something: Plan 0A found TypeScript resolving outside `typescript-eslint`'s peer range, which disabled **all** type-aware linting with no error; 0B-2 found `eslint-config-next/flat` does not exist; 0C found that Sentry's default integrations and `@fastify/otel` both decorate a Fastify property called `opentelemetry`, so leaving the defaults on made the app fail to boot.

This spike has a second reason beyond habit, and it is the one that decides whether Phase 1 is testable: **there is no Clerk instance on this machine and CI has never held a secret.** Every environment variable in `.github/workflows/ci.yml` today is a non-secret literal, and the two `NEXT_PUBLIC_*` keys carry an inline comment saying they are "NOT SECRETS, and they never can be". If verifying a token requires reaching Clerk, then the forged-token fixture that `docs/SECURITY.md:213-226` row #12 demands cannot run in `verify` or `integration`, and neither can any test that boots the app behind the guard.

Nothing in this task ships in `apps/api` or `apps/web`. It produces a measurement and a decision.

**Files:**

- Create: `docs/adr/0038-clerk-integration.md`
- Modify: `docs/adr/README.md`
- Test: none — the deliverable is a measurement, recorded

**Interfaces:**

- Consumes: nothing
- Produces: the exact pin for every package Tasks 5 and 8 install (`@clerk/backend`, `@clerk/nextjs`, and `jose` if the verification is hand-rolled), plus the five answers below. Later tasks write `<pin>`; that placeholder means "read ADR-0038's table", never "choose one now".

- [ ] **Step 0: Create the branch — nothing else in this plan does**

```bash
git checkout -b feat/phase-1a-identity-and-tenancy
git rev-parse --abbrev-ref HEAD    # must print feat/phase-1a-identity-and-tenancy
```

Every subsequent task commits onto this branch. Without it the nine commits land on `main` —
which CLAUDE.md and `CONTRIBUTING.md` both forbid (`feat/*`, squash merge) — and Task 9 Step 7's
`git push -u origin feat/phase-1a-identity-and-tenancy` fails with
`src refspec … does not match any`, at the very end, after everything is already committed to the
wrong place.

- [ ] **Step 1: Build the spike outside the workspace**

```bash
SPIKE=$(mktemp -d); echo "SPIKE=$SPIKE"; cd "$SPIKE"
```

A workspace member that fails to install breaks `pnpm install` for everyone.

- [ ] **Step 2: Record what the registry offers**

```bash
for p in @clerk/backend @clerk/nextjs jose; do echo "$p: $(npm view "$p" version)"; done
```

- [ ] **Step 3: Check peer and engine ranges before installing anything**

```bash
npm view @clerk/backend@latest peerDependencies engines --json
npm view @clerk/nextjs@latest peerDependencies --json
```

Answer in writing: do the ranges include **Node 24.19.0**, **TypeScript 6.0.3**, **Next 16.3.0** and **React 19.2.8**? An excluded range is a spike failure for that component, not a warning to ignore. `pnpm` installs a package whose peer range excludes the installed version and merely warns; the tool then silently degrades.

- [ ] **Step 4: Answer the five questions Tasks 5 and 8 depend on.** Each needs a measurement, not a reading.

1. **Can a token be verified with no network and no Clerk account?** Generate an RS256 keypair, build a JWKS document from it, sign a token with `iss`/`aud`/`sub`/`exp`, and verify it through the chosen path. Measure whether `@clerk/backend`'s `verifyToken` accepts an injected key or a `jwtKey`, or whether it insists on fetching from a Clerk-hosted JWKS URL. **If it insists, the spike's answer is `jose` + a hand-rolled JWKS client**, and that becomes ADR-0038's decision rather than a compromise. Record the exact API surface either way — Task 5 writes against it.
2. **What does an invalid token produce?** For each of: bad signature, expired `exp`, wrong `iss`, `kid` not in the key set, `alg: none`, and a token signed with HS256 using the public key as the secret (the classic algorithm-confusion attack). Record the exact thrown type and message. Task 5 maps every one of them to `DomainError('UNAUTHENTICATED')` and asserts it.
3. **What is actually in the token?** Print the decoded payload of a Clerk session token (from the development instance if one exists; from the SDK's documented claim set if not). Which claim is the stable user identifier that becomes `User.externalAuthId`? Does an `org_id` / `org_role` claim appear, and under what conditions? **The answer changes nothing about our authorization** — ADR-0012 forbids reading a role from the JWT — but Task 5 must know which claims exist in order to _ignore_ them deliberately rather than by omission.
4. **Does `@clerk/nextjs` need a `middleware.ts`, and at which runtime?** `apps/web` has no `middleware.ts` today (neither `apps/web/middleware.ts` nor `apps/web/src/middleware.ts`), and `src/instrumentation.ts` notes there is no middleware and no edge route. A middleware is a fourth runtime with no Sentry init branch, no request-ID story and no `process.env` access path — `apps/web/src/config/env.ts` is the only sanctioned reader. Measure whether the provider works without one, and what is lost.
5. **How does an RSC obtain the token to send to our API?** `apps/web/src/lib/api/fetch.ts`'s `apiFetch` adds only `X-Request-Id`. Measure the server-side accessor and whether it is callable from a Server Component. This is what makes Task 8 an RSC fetch rather than a client-side one.

- [ ] **Step 5: Write ADR-0038**

House style — read `docs/adr/0027-python-toolchain.md` and `docs/adr/0021-next-major-and-frontend-stack.md` first for the `Status` / `Context` / `Decision` / `Alternatives` / `Consequences` shape. Confirm the next free number against `docs/adr/README.md`, which ends at 0037, and add the row in numeric order.

It must carry: the pin table with the date measured; the peer-range answers quoted; every exit code; the five answers above; the **offline verification recipe** in enough detail that Task 5 can implement it without re-deriving it; **a stated fallback** naming the trigger measurement that would justify it; and **what did not work**. A spike reporting unqualified success is the one to distrust.

- [ ] **Step 6: Destroy the spike and commit**

```bash
rm -rf "$SPIKE"
git add docs/adr/0038-clerk-integration.md docs/adr/README.md
git commit -m "docs(adr): pin the Clerk integration against a measured spike"
```

`git status` must show no trace of the spike directory.

---

### Task 2: The contracts fork, and ADR-0039 — **REVIEW**

`packages/contracts/test/json-schema.test.ts:128-132` asserts that `emitJsonSchemas()` covers exactly the package's exported `z.ZodType`s — "no more, no fewer" — and the construct allowlist at :271-297 admits only `object`, `string`, `number` and `enum` nodes, with `regex` as the only string format. `.optional()`, `.nullable()`, `.default()`, `.catch()`, `.refine()`, `z.coerce.*`, `z.email()`, arrays, booleans and datetimes are all **rejected outright**, and the file says that is a decision rather than an oversight: `z.toJSONSchema()` drops several of them silently, so a dropped check and an absent check are indistinguishable downstream (`json-schema.ts:50-64` records that a `.refine()` on `Money.amountMinor` leaves the generated pydantic file byte-identical).

That rule is correct for anything Python sees. It is not survivable for `MeResponse`, whose memberships are an **array**. So this task settles the fork before a single Phase 1 response schema is written — and 1A pays for it rather than 1B, because 1A is the slice that first hits the wall.

Note what 1A does **not** need: no new `DomainErrorCode`. `UNAUTHENTICATED` and `INSUFFICIENT_PERMISSIONS` already exist with `DOMAIN_ERROR_RESPONSE` rows at 401 and 403. `MODEL_NOT_FOUND`, `QUOTE_NOT_FOUND` and `ORDER_NOT_FOUND` have shipped since Plan 0A with no thrower, so declaring a code ahead of its endpoint is house style — but nothing in 1A requires one, and adding one speculatively would put an unused member in a closed union and a row in the docs table.

**Files:**

- Create: `packages/contracts/src/organization.ts`, `packages/contracts/src/auth.ts`, `docs/adr/0039-contracts-typescript-only-exports.md`
- Modify: `packages/contracts/src/ids.ts`, `packages/contracts/src/index.ts`, `packages/contracts/src/json-schema.ts`, `packages/contracts/test/json-schema.test.ts`, `docs/adr/README.md`, `docs/CONTRACTS_AND_API.md`
- Test: `packages/contracts/test/json-schema.test.ts` (rewritten assertion), `packages/contracts/test/organization.test.ts`, `packages/contracts/test/auth.test.ts`

**Interfaces:**

- Consumes: nothing
- Produces:
  - `OrganizationKind = z.enum(['PERSONAL','TEAM'])`, `OrganizationRole = z.enum(['OWNER','ADMIN','MEMBER','BILLING'])`, `PlatformRole = z.enum(['PLATFORM_ADMIN','OPERATIONS','MANUFACTURING_OPERATOR','FINANCE','SUPPORT'])`
  - `OrganizationMemberId = brandedUuid('OrganizationMemberId')`
  - `MembershipSummary`, `MeResponse` — declared TypeScript-only
  - `TS_ONLY: Record<string, z.ZodType>` in `json-schema.ts`, and the rewritten equality assertion

- [ ] **Step 1: Decide the fork, and write it down as ADR-0039**

Three answers, and each changes something different:

| Answer                                                                                                                                                          | What it costs                                                                                                                                                                                                         | What it buys                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **(a) Widen the allowlist** with a measured Python-side probe per construct                                                                                     | A `test_generated_contracts.py` case per construct, forever; and every API schema reaches `apps/workers`, which has no database and no use for `MeResponse`                                                           | One list, no second concept                                                        |
| **(b) A declared TypeScript-only set** — `EMITTED ∪ TS_ONLY` is the exported set, `EMITTED ∩ TS_ONLY` is empty, and the allowlist walk stays on `EMITTED` alone | One new concept, and a reviewer must notice which table a new schema is added to                                                                                                                                      | API schemas written naturally; the Python boundary keeps exactly today's guarantee |
| **(c) A second subpath export** (`@metrika/contracts/api`)                                                                                                      | `packages/contracts`'s exports map is `"."` only today, and both `apps/api` and `apps/web` resolve it at `dist/` behind a conditional map (ADR-0026) — a second subpath is a build-output change consumed by two apps | Physical separation rather than a declared one                                     |

**(b) is the recommendation**, and the reason is the direction of the guarantee: the assertion exists so that nothing reaches Python without a human adding it to a hand-written list. `TS_ONLY` preserves that exactly — a new schema still cannot reach Python by accident; it can only fail to reach it. (a) inverts the burden onto a boundary that gains nothing. Whichever is chosen, ADR-0039 records the other two and the trigger that would justify revisiting.

- [ ] **Step 2: Write the failing test first — the rewritten equality assertion**

`packages/contracts/test/json-schema.test.ts`. **Keep the existing vacuity guard at :120-126 exactly as it is** (`toContain('Money')`, `toContain('QuoteId')`, `length > 10`) — it is what stops the whole `describe` from being satisfiable by emptying both tables, and it becomes more load-bearing once there are two tables rather than one. Replace only the `emits exactly the exported schemas` assertion at :128-132, and add the overlap assertion beside it. The allowlist walk stays scoped to `EMITTED` alone:

```ts
it('EMITTED and TS_ONLY together cover exactly the Zod schemas the package exports', () => {
  const declared = [...Object.keys(EMITTED), ...Object.keys(TS_ONLY)].sort();
  expect(
    declared,
    'a Zod schema exported from packages/contracts is in neither table (or a name in one of them no longer exists)',
  ).toEqual(exportedSchemaNames());
});

// The two tables are a partition, not two overlapping opinions. A name in both would
// satisfy the assertion above while leaving it ambiguous whether the schema crosses to
// Python — and `emitJsonSchemas()` would answer "yes" regardless of what TS_ONLY says.
it('no schema is in both tables', () => {
  expect(Object.keys(EMITTED).filter((name) => name in TS_ONLY)).toEqual([]);
});
```

Note that `emitJsonSchemas()` itself is unchanged: it still walks `EMITTED` only, which is what makes a `TS_ONLY` schema physically incapable of reaching the pydantic models. The assertion above is what stops a schema falling out of **both** tables and reaching neither.

- [ ] **Step 3: Run it and watch it fail**

```bash
pnpm --filter @metrika/contracts --fail-if-no-match test:unit; echo "EXIT=$?"
```

Expected: **non-zero**, `TS_ONLY is not defined`.

- [ ] **Step 4: Write the contracts**

`packages/contracts/src/organization.ts` — three `z.enum`s, each of which crosses the allowlist cleanly and therefore goes in `EMITTED`. `packages/contracts/src/ids.ts` gains `OrganizationMemberId` (also `EMITTED`; every other branded ID is there).

`packages/contracts/src/auth.ts` — `MembershipSummary` and `MeResponse`, into `TS_ONLY`. `MeResponse.memberships` is `z.array(MembershipSummary)`; `MeResponse.timezone` may be `.optional()`. Neither is possible in `EMITTED`, which is the whole point of this task.

`AuthContext` does **not** go here, **and that is a deviation from the roadmap that has to be
recorded rather than justified in passing.** `docs/ROADMAP.md:282` lists `AuthContext` and
`PolicyResult` under Phase 1's **Contracts**, i.e. in this package. They are not wire types:
`AuthContext` is what a guard hands a repository and `PolicyResult` is what a policy function
returns, and every export of this package is a candidate for the pydantic codegen — so putting
them here pushes `OrganizationRole` semantics into a shape `apps/workers` inherits for no reason.
`AuthContext` is an interface in `apps/api/src/authorization/auth-context.ts`, created in Task 4
(Task 4's `runInTenant` is typed against it, so it cannot wait for Task 5).

**Decide `PolicyResult`'s home in the same breath**, so 1B inherits an answer rather than a
precedent: it goes beside `AuthContext` in `apps/api/src/authorization/policy-result.ts`, on
identical reasoning. What DOES stay in contracts is the vocabulary both are typed against —
`OrganizationRole`, `PlatformRole`, `OrganizationKind` and the branded IDs.

Both halves go in **ADR-0039's Consequences** section, which is the ADR that already owns where
a Phase 1 type lives relative to the Python boundary, and Task 9 Step 5 corrects ROADMAP.md:282.
CLAUDE.md's rule is that a conflict with the blueprint is followed or superseded by an ADR, never
silently diverged from — and this plan writes four ADRs, so the discipline is available.

- [ ] **Step 5: Decide whether `email` joins `RedactedFieldName` — and write down the answer either way**

MEASURED against `packages/contracts/dist/index.js`: `isRedactedKey('email')` is **false**. `MeResponse` carries an email, `AuditLog` will carry `ipAddress` and `userAgent`, and R17 (Ley 1581) makes all three personal data. Adding a name costs a corpus re-emit — 60 declared spellings per name, into the 956 verdicts in `packages/contracts/redaction-corpus.json` — and makes debugging materially harder, since the value is then censored in all four sinks and in spans.

This plan does not decide it for you. It requires that the decision is recorded in ADR-0039 with its reason, because "nobody thought about it" and "we thought about it and left it out" are indistinguishable from the outside.

- [ ] **Step 6: Run the tests, then re-emit**

```bash
pnpm --filter @metrika/contracts test:unit; echo "EXIT=$?"     # expect 0
pnpm contracts:emit; echo "EXIT=$?"                             # expect 0
git diff --stat -- apps/workers/packages/metrika_core/src/metrika_core/contracts/ packages/contracts/redaction-corpus.json
```

The three enums and `OrganizationMemberId` **should** produce a diff in the generated pydantic module — they are in `EMITTED`. `MeResponse` and `MembershipSummary` **must not**. If they do, `TS_ONLY` is not wired into the emitter and the fork is not real.

`packages/contracts` enforces 100% lines/branches/functions/statements over `src/**`, so every branch of the new files needs a test and an unreachable defensive branch fails the build.

- [ ] **Step 7: Mutations — prove the fork is a fence and not a comment**

1. Move `MeResponse` from `TS_ONLY` to `EMITTED`. Expected: **non-zero** — the allowlist walk rejects the array node. Restore.
2. Export a new `z.string()` from `index.ts` and add it to neither table. Expected: **non-zero** on the equality assertion. Restore.
3. Add the same name to both tables. Expected: **non-zero** on the overlap assertion. Restore.

**If any mutation leaves the suite green, say so plainly rather than adjusting the test.**

- [ ] **Step 8: Commit**

```bash
pnpm verify; echo "EXIT=$?"
git add packages/contracts apps/workers docs
git commit -m "feat(contracts): split the emitted and TypeScript-only schema sets, and add the organization vocabulary"
```

---

### Task 3: The first real migration, RLS, and ADR-0040 — **REVIEW**

`packages/database/prisma/schema.prisma` contains exactly two models today: `HealthCheck` and `RlsProbe`. This task adds the first three that a customer's data lives in, and their policies, **in the same migration** — because `FORCE` plus `WITH CHECK` retrofitted onto a populated table turns a working query into a silent deny-all, and because `packages/database/test/migration-sql.test.ts:35-49` only polices tables that already say `ENABLE ROW LEVEL SECURITY`: a table created without it is invisible to the tripwire.

Two of the three policies do not fit the template the init migration established. `Organization` has no `organizationId` — its predicate is on `id`. `User` has no organization at all, because a person belongs to many. And `/me` has to answer "which organizations am I in", which `USING ("organizationId" = app_current_org_id())` cannot express, since `withOrganizationContext` sets exactly one org per transaction. That is the decision this task makes and records as ADR-0040.

**And one read has neither GUC available, which is the finding that shapes this whole task.** The
`externalAuthId → User` lookup runs on **every single request**: the API holds only the verified
Clerk `sub` and must find `User` by `(authProvider, externalAuthId)` in order to learn
`User.id`. At that moment `app.current_user_id` is unknown by definition and
`app.current_org_id` is unknown too, `metrika_app` is `NOBYPASSRLS`
(`packages/database/sql/00-app-role.sql:29`), an unset GUC yields NULL, and NULL never equals
anything — so a `User` policy keyed only on those two returns **zero rows on every sign-in after
the first**, sends every returning user down the provisioning path, and violates the unique
constraint. The elevated client that would otherwise answer it is deferred to 1D on purpose.
So the pre-identity read needs its **own predicate**, decided here, in the same migration that
creates `User`. Step 1 chooses it; Step 3 writes it; Step 4 proves it with the fixture that would
have caught this — _the second sign-in of the same identity returns 200 with the same `userId`_.

**Files:**

- Create: `packages/database/prisma/migrations/<timestamp>_identity_and_tenancy/migration.sql`, `packages/database/test/rls-coverage.integration.test.ts`, `packages/database/test/identity-rls.integration.test.ts`, `packages/database/test/soft-delete-coverage.test.ts`, `docs/adr/0040-tenant-context-gucs.md`
- Modify: `packages/database/prisma/schema.prisma`, `packages/database/src/extensions/soft-delete.ts`, `docs/adr/README.md`, `docs/DOMAIN_MODEL.md`
- Test: the three files above

**Interfaces:**

- Consumes: Task 2 (the role enums exist as Zod enums; the Prisma enums must carry the same members, and Task 3 asserts it)
- Produces: `User`, `Organization`, `OrganizationMember`; the Prisma enums `OrganizationKind` and `OrganizationRole` (**not** `PlatformRole` — see Step 2); the SQL functions `app_current_user_id()`, `app_current_auth_provider()` and `app_current_external_auth_id()`; **four** RLS policies over three tables; `SOFT_DELETABLE_MODELS = { RlsProbe, User, Organization }`

- [ ] **Step 1: Decide the two reads RLS cannot express yet, and write ADR-0040**

**1a — the cross-organization read.** `/me` and the organization switcher need a user's memberships across every organization. Three answers:

| Answer                                                                                        | What it changes                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A second GUC** — `app.current_user_id` and `app_current_user_id()` beside the existing pair | One new function, a wider `USING` on two tables, and a new tenancy primitive that every later policy must be written against. Cheapest, and it must be decided **now** rather than retrofitted into policies already written |
| **The elevated BYPASSRLS client**                                                             | Pulls 1D's role, its third connection URL and its mandatory-audit wrapper forward into 1A, and makes the most ordinary read in the product go through the escape hatch                                                       |
| **No RLS on `User` and `OrganizationMember`**, with an application-only rule                  | Contradicts ROADMAP 1.6 ("enable on every tenant table") and ADR-0013 ("RLS as backstop... both, always"), and makes the meta-gate in Step 5 need a permanent exemption                                                      |

**The second GUC is the recommendation.**

**1b — the pre-identity read**, which is a different problem with a different answer: the second
GUC does not help, because `app.current_user_id` is precisely what the lookup exists to compute.
Two answers:

| Answer                                                                                                                                                                                                                             | What it changes                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A third pair of GUCs** — `app.current_auth_provider` + `app.current_external_auth_id`, with a second, **read-only** named policy on `User` whose `USING` matches exactly the identity the caller has already proved by signature | One more function pair, one more policy, and a third tenancy primitive named in ADR-0040. It is the same mechanism as the other two and inherits the same deny-by-default property, and its blast radius is exactly one row: the caller can only reach the `User` whose external identifier they supplied, which the token verifier already checked |
| **A `SECURITY DEFINER` function** — `app_user_by_external_id(provider text, external_id text) RETURNS uuid`, owned by `metrika`, `GRANT EXECUTE` to `metrika_app`                                                                  | Introduces an owner-privileged, RLS-bypassing door reachable by the app role — which is exactly the thing 1D's ordering rule exists to delay ("nothing bypasses RLS until bypassing is auditable"), shipped in the slice that has no audit trail. It is also invisible to the Step 5 meta-gate, which enumerates tables and policies, not functions |

**The third GUC pair is the recommendation**, and it is not a workaround: an unset
`app.current_external_auth_id` denies every row, exactly like the other two, so the primitive
fails closed. It is set **only** by the identity-bootstrap entry point (Task 4), in a transaction
that does nothing else and sets neither of the tenancy GUCs — so the widened predicate cannot
leak into any other read.

Record in ADR-0040: **three** tenancy primitives, not two, with each function's definition and
the reason it fails closed; the four predicates below; the consequence in Step 3 that follows
from `WITH CHECK`; and the **two declared exceptions** to ADR-0013 decision 2
("`AuthContext` in every repository signature"), named by symbol, with their reasons —
`findByExternalAuthId(identity)` (Task 5), whose whole purpose is to run before an
`AuthContext` can exist and whose predicate is narrower than any `AuthContext` would make
it, and `provisionIdentity(identity, profile)` (Task 6), which creates the rows an
`AuthContext` would be derived from and therefore mints its context rather than receiving
it. **CORRECTED DURING EXECUTION**: this paragraph said "one declared exception", which
contradicted the File-structure table above, Task 6 Step 2 and the Definition of Done, all
three of which require two. Two is right, and ADR-0040 names both.

- [ ] **Step 2: Write the schema**

`packages/database/prisma/schema.prisma`. Conventions are non-negotiable (`docs/DOMAIN_MODEL.md:486-495`): `@db.Uuid` primary keys, `@db.Timestamptz(3)` for every timestamp, Postgres enums for roles, `deletedAt DateTime?` on Identity entities only.

**Every one of the three carries `createdAt DateTime @default(now())` and
`updatedAt DateTime @updatedAt`, both `@db.Timestamptz(3)`.** Spelled out rather than left to the
conventions sentence above, because the field lists that follow enumerate three other uniques
explicitly and an omission in that company reads as deliberate. `RlsProbe` is the live precedent
in the schema (`createdAt` plus `@@index([organizationId, createdAt(sort: Desc)])`).

Fields, from `docs/DOMAIN_MODEL.md:60-64`, on top of those two:

- `User` — `externalAuthId`, `authProvider`, `email` (unique, lowercased), `displayName`, `locale` (default `es-CO`), `timezone`, `deletedAt`. `@@unique([authProvider, externalAuthId])` → `User_authProvider_externalAuthId_key`. `@@unique([email])` → `User_email_key`.
- `Organization` — `kind`, `name`, `slug` (unique), `countryCode`, `defaultCurrency`, `taxIdentifier?`, `deletedAt`, plus **`personalOwnerUserId String? @unique @db.Uuid`** with a relation to `User` at `onDelete: Restrict`, like the other two edges. That last field is not in the domain model and is added deliberately: nothing else expresses "at most one personal organization per user", and the house rule is that a constraint is a guarantee and a check is a hope. `billingAddressId` is **omitted** — `Address` is not a Phase 1 table, and a nullable UUID with no referent is a fact nobody can check.
- `OrganizationMember` — `organizationId`, `userId`, `role`, `invitedById?`, `joinedAt`. `@@unique([organizationId, userId])`. **No `deletedAt`**: it is not an Identity entity in `docs/DOMAIN_MODEL.md:11-18`, and whether removal is a hard `DELETE` or a `removedAt` timestamp is 1C's decision, not this one.

**`personalOwnerUserId`'s unique is only half the invariant, and the half it is missing is the
one the assertion in Task 6 depends on.** Postgres treats NULLs as distinct in a unique index and
nothing ties the column to `kind`, so a `PERSONAL` organization created with the column left NULL
is accepted, and a user can hold two personal organizations with no constraint violated. Close it
in the same hand-written SQL block as the policies:

```sql
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_personal_owner_required"
  CHECK ("kind" <> 'PERSONAL' OR "personalOwnerUserId" IS NOT NULL);
```

with a fixture in Step 4 inserting a `PERSONAL` organization with a NULL owner and asserting
rejection. Without both halves, "exactly one personal organization" is an application convention
wearing a constraint's name — precisely the state the house rule exists to prevent.

`Organization → OrganizationMember` and `User → OrganizationMember` are `onDelete: Restrict` — "never cascade a tenant away" (`docs/DOMAIN_MODEL.md:500`). `defaultCurrency` is the existing `CurrencyCode` vocabulary, not a free string.

**Two Prisma enums, not three.** `OrganizationKind` and `OrganizationRole` each have a column in
this migration. `PlatformRole` does **not**: its only column is `PlatformRoleAssignment.role`,
and that table lands in 1D with the elevated client it authorises. Creating the Postgres enum
type now would ship a schema object nothing can be wrong about — and, worse, would make Task 5's
`AuthContext.platformRoles` look supportable when there is no table to read it from. Task 2's
**Zod** `PlatformRole` still ships in 1A: it is vocabulary, it costs one `EMITTED` entry, and
opening `packages/contracts` as few times as possible is this slice's stated discipline. So the
"the Prisma enums must carry the same members" assertion in the Consumes line covers two of the
three, and says so.

**Two things to MEASURE rather than assume:**

1. **UUID v7.** `docs/DOMAIN_MODEL.md:486-495` says "UUID v7 where available"; `schema.prisma` uses `@default(uuid())` (v4) today. Prisma spells v7 `@default(uuid(7))`. Verify it is accepted on Prisma 7.9.1 (`pnpm db:generate`, then read the generated migration). Choosing v4 now and v7 later is a data migration across every foreign key. **Be honest about what this measurement buys in 1A: nothing at runtime.** Task 6 mints every id in application code and passes `id` explicitly, because Step 3's `WITH CHECK` predicates force it — so no code path this plan writes exercises the Prisma default. The declaration is for rows created outside provisioning, from 1B onward, and `newUuidV7()` is the authority for everything 1A creates. Record the measurement; do not let a `uuid(7)` round-trip assertion stand in for Task 4's `newUuidV7()` test, which is the one that matters here.
2. **Whether the emitted column has a database `DEFAULT` at all.** The existing migration emits `"id" UUID NOT NULL` with no default, because Prisma generates the value client-side. Step 3 depends on that being true.

- [ ] **Step 3: Generate the migration, then hand-write the RLS block**

```bash
pnpm db:migrate --create-only --name identity_and_tenancy; echo "EXIT=$?"
```

`--create-only` works today by argv passthrough — `scripts/prisma.mjs` forwards `process.argv.slice(2)` — but no npm script and no line in `docs/LOCAL_DEVELOPMENT.md` says so. Task 9 documents it.

Append to the generated `migration.sql`:

```sql
-- The second tenancy GUC. Same shape and the same deny-by-default property as
-- app_current_org_id(): `true` makes a missing setting return NULL rather than
-- raise, and NULL never equals anything, so an unset context denies every row.
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid
$$;

-- The THIRD tenancy primitive, and the one without which nothing else here
-- works. Every request begins by turning a verified Clerk `sub` into a User row,
-- and at that moment neither GUC above has a value — so a User policy keyed only
-- on those two returns zero rows for every returning user, and the sign-in falls
-- into the provisioning path and violates User_authProvider_externalAuthId_key.
-- These two are set ONLY by the identity-bootstrap entry point, in a transaction
-- that sets neither of the GUCs above and does nothing but this one lookup.
-- Same deny-by-default property: unset yields NULL, and the policy below ANDs
-- both halves, so an unset context matches no row at all.
CREATE OR REPLACE FUNCTION app_current_auth_provider() RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_auth_provider', true), '')
$$;

CREATE OR REPLACE FUNCTION app_current_external_auth_id() RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_external_auth_id', true), '')
$$;

-- ASYMMETRIC, and for a reason the switcher makes concrete in 1C. The read half
-- is widened to any organization the caller is a member of, because /me's
-- MembershipSummary renders names and slugs, not ids: a caller scoped to org A
-- who can see their OrganizationMember row for org B but cannot read org B's
-- Organization row has a switcher with a blank entry in it. Deciding it here
-- rather than in 1C is deliberate — by then ADR-0040 is immutable and Step 7
-- forbids drop-and-recreate, so the correction would have to be an ALTER POLICY
-- on a predicate three slices of code already assume.
-- The WRITE half stays narrow: a caller scoped to one organization must not be
-- able to modify another, and membership does not imply write access to the
-- tenant row.
ALTER TABLE "Organization" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Organization" FORCE ROW LEVEL SECURITY;
CREATE POLICY "Organization_tenant_isolation" ON "Organization"
  USING (
    "id" = app_current_org_id()
    OR EXISTS (
      SELECT 1 FROM "OrganizationMember" m
      WHERE m."organizationId" = "Organization"."id" AND m."userId" = app_current_user_id()
    )
  )
  WITH CHECK ("id" = app_current_org_id());

-- ASYMMETRIC ON PURPOSE. The USING half is what lets `/me` list a caller's
-- memberships across every organization without an elevated client. The
-- WITH CHECK half is NOT widened: a caller scoped to one organization must not
-- be able to plant a membership row in another, and `userId = app_current_user_id()`
-- on the write side would let exactly that happen.
ALTER TABLE "OrganizationMember" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrganizationMember" FORCE ROW LEVEL SECURITY;
CREATE POLICY "OrganizationMember_tenant_isolation" ON "OrganizationMember"
  USING ("organizationId" = app_current_org_id() OR "userId" = app_current_user_id())
  WITH CHECK ("organizationId" = app_current_org_id());

-- A person belongs to many organizations, so there is no organizationId to
-- compare. Readable if you ARE them, or if they are a member of the organization
-- currently in context. The subquery is in the hot path of every user read; the
-- alternative is no RLS on User at all, which ROADMAP 1.6 forbids.
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "User" FORCE ROW LEVEL SECURITY;
CREATE POLICY "User_tenant_isolation" ON "User"
  USING (
    "id" = app_current_user_id()
    OR EXISTS (
      SELECT 1 FROM "OrganizationMember" m
      WHERE m."userId" = "User"."id" AND m."organizationId" = app_current_org_id()
    )
  )
  WITH CHECK ("id" = app_current_user_id());

-- The pre-identity read, as a SECOND named policy rather than a fourth branch of
-- the one above. Permissive policies OR together, so this widens the read path
-- and nothing else — and separating them is what makes the widening auditable:
-- it has its own name in pg_policies, its own FOR SELECT, and it can be dropped
-- in one statement the day an elevated client makes it unnecessary.
--
-- FOR SELECT, so it has no WITH CHECK at all: a bootstrap lookup must never be
-- able to write. That is also why the Step 5 meta-gate keys its with_check
-- assertion on pg_policies.cmd rather than asserting non-null everywhere — a
-- read-only policy with a NULL with_check is correct, not a hole.
--
-- Both halves are ANDed, so an unset context matches nothing, and a caller who
-- sets only one of the two matches nothing either. The blast radius is exactly
-- one row: the User whose external identifier the token verifier already proved.
CREATE POLICY "User_identity_bootstrap" ON "User"
  FOR SELECT
  USING (
    "authProvider" = app_current_auth_provider()
    AND "externalAuthId" = app_current_external_auth_id()
  );
```

**Three consequences, all load-bearing, all to be verified rather than trusted:**

- **`WITH CHECK` means the row's identifier must exist before the `INSERT`.** A `User` can only be inserted when `app.current_user_id` already equals its `id`; an `Organization` only when `app.current_org_id` already equals its `id`. So provisioning mints both UUIDs, sets both GUCs, and passes `id` explicitly in `data` rather than letting Prisma's client-side default fill it — all of it **inside the repository**, because `newUuidV7()` and `withTenantContext` are both behind the persistence boundary Task 4 builds. Task 4 provides `newUuidV7()` for exactly this. **This is the single most surprising consequence of the design — write it in ADR-0040, not only in this plan.**
- **A policy expression that reads another RLS-protected table has that table's policies applied to it, and a cycle raises `infinite recursion detected in policy for relation`.** There are now **two** such edges, not one: `User` reads `OrganizationMember`, and `Organization` reads `OrganizationMember` as well. There is still no cycle, because `OrganizationMember`'s own policy names no table — which is exactly why it must stay that way. The moment 1C adds a policy on `OrganizationMember` that reads `User` **or `Organization`**, there is one. **MEASURE the non-recursion here** — do not conclude it from this paragraph — and leave the note in the migration for whoever writes 1C's.
- **A unique violation aborts the whole transaction, so "catch it and re-read" is not free.** Postgres puts an interactive transaction into the aborted state on the violation and answers every subsequent statement with `25P02` until rollback — so a recovery branch written after the failing `INSERT`, inside the same `client.$transaction`, cannot execute at all. Task 6 Step 3 names the retry boundary this forces. It is stated here because it is a property of the constraints this migration creates, not of the code that trips them.

- [ ] **Step 4: Write the behavioural RLS suite, with no tenant predicate anywhere**

`packages/database/test/identity-rls.integration.test.ts`. Copy the standing comment from `packages/database/test/rls.integration.test.ts:40-118` verbatim in spirit: **deliberately no `where: { organizationId }` anywhere in the file** — the whole point of a backstop is that it works when the primary control has failed.

Assert, as `metrika_app` against Testcontainers:

1. With org A in context, an unfiltered `organization.findMany()` returns org A **and** every other organization the current user is a member of — and nothing else. Seed a third organization the user is not in and assert its absence, or the widened `USING` is untested in the only direction that matters.
2. With org A in context, `organizationMember.findMany()` returns org A's members **and** the current user's memberships in other organizations — and nothing else.
3. With org A in context, `user.findUnique({ where: { id: <org B's user> } })` returns `null`.
4. With org A in context, inserting an `OrganizationMember` stamped with org B's id is rejected by `WITH CHECK`.
5. With org A in context, **updating** org B's `Organization` row is rejected — the read half is widened and the write half is not, and nothing else asserts that the two came apart on purpose.
6. With **no** context set, every one of the three tables returns zero rows — deny by default.
7. **The identity-bootstrap policy, in both directions.** With only `app.current_auth_provider` + `app.current_external_auth_id` set and both tenancy GUCs unset: `user.findFirst()` returns exactly the one matching row; the same query with a different `externalAuthId` returns `null`; with only one of the two set, `null`; and an `INSERT` or `UPDATE` on `User` in that context is rejected, because the bootstrap policy is `FOR SELECT` and the tenant policy's `WITH CHECK` cannot be satisfied. **Case (7) is the one whose absence would have shipped a product where nobody can sign in twice.**
8. `INSERT` of an `Organization` with `kind: 'PERSONAL'` and a NULL `personalOwnerUserId` is rejected by `Organization_personal_owner_required`.
9. `pg_roles` for `current_user` still reads `{ rolsuper: false, rolbypassrls: false }`. A superuser bypasses every policy including `FORCE`; `packages/database/sql/00-app-role.sql:9-15` names this as "the single most likely way for the tenant-isolation backstop to be silently absent", and the local docker `metrika` role **is** a bootstrap superuser, so a psql check against the compose stack proves nothing.

**Isolation is this file's own job.** One container serves the whole run, `withOrganizationContext` opens a transaction that COMMITS, and Vitest orders files by size rather than declaration. Scope every row by suite-unique organization and user ids, and never assert `toEqual([])` over a shared table unless the predicate itself is what is being asserted (a random org id is what makes the two such assertions in the existing suite safe).

- [ ] **Step 5: Write the catalog-driven meta-gate — the part that outlives this task**

`packages/database/test/rls-coverage.integration.test.ts`. The existing catalog assertions are scoped to `policyname = 'RlsProbe_tenant_isolation'` and the existing `migration-sql.test.ts` `WITH CHECK` checks are whole-history substring checks already satisfied forever by the init migration. **Neither would notice a Phase 1 table whose policy omits `WITH CHECK`.** Generalise:

```ts
// Every table in schema public is tenant-scoped and must have RLS, unless it is
// named here with a reason. Adding a table therefore means adding a policy OR
// arguing in this list — an omission is a failure, not a silence.
const NOT_TENANT_SCOPED: ReadonlyMap<string, string> = new Map([
  ['HealthCheck', '/health/deep round-trip target; holds no customer data'],
  ['_prisma_migrations', "Prisma's own ledger; metrika_app has no privileges on it at all"],
]);

// The functions a predicate may be built out of. A LIST, not a substring pair,
// because the set grows: this migration adds three at once, 1D's elevated-client
// work may add more, and a policy referencing something that is not on this list
// is a policy nobody reviewed. Each entry says what it scopes to, so adding one
// is a sentence somebody has to write.
const TENANCY_FUNCTIONS: ReadonlyMap<string, string> = new Map([
  ['app_current_org_id', 'the active organization'],
  ['app_current_user_id', 'the authenticated user, across organizations'],
  ['app_current_auth_provider', 'identity bootstrap — half of the pre-identity pair'],
  ['app_current_external_auth_id', 'identity bootstrap — the other half'],
]);
```

Then, over `pg_class` joined to `pg_policies`, assert for every remaining table:

- `relrowsecurity` is true **and** `relforcerowsecurity` is true;
- it has at least one policy;
- every policy whose `cmd` admits a write — `ALL`, `INSERT`, `UPDATE` — has a **non-null
  `with_check`**;
- every non-null `with_check` expression either **references a name in `TENANCY_FUNCTIONS`** or
  **is the literal `false`**;
- every policy's `qual` is non-null and **references a name in `TENANCY_FUNCTIONS`**.

**Three things about that list are decisions, not shortcuts, and each one is a false rejection
avoided:**

- **Keying on `cmd`, not asserting non-null everywhere.** `pg_policies.with_check` is NULL by
  definition for a `FOR SELECT` policy — it has no write half to constrain — so
  `User_identity_bootstrap` would fail a blanket assertion for being correct. `cmd` is the
  property that actually distinguishes "cannot write" from "writes unchecked".
- **Admitting a literal `false`.** `PlatformRoleAssignment` (1D) is keyed on `userId` and must
  **not** be self-writable through the app role at all; its correct write predicate is
  `WITH CHECK (false)`, which is non-null and references no tenancy function. Without this
  clause the gate forces 1D to choose between a wrong policy and an exemption entry, under
  time pressure, on the slice whose whole subject is the audit trail.
- **Adding the `qual` assertion.** It is new, and it is what keeps the gate meaningful now that a
  policy can legitimately carry no `with_check`: otherwise a table could ship one
  `FOR SELECT USING (true)` beside one correct write policy and pass. `migration-sql.test.ts`'s
  `USING` check cannot cover this — it is a whole-history substring check already satisfied
  forever by the init migration.

Note why the existing `with_check = qual` assertion cannot generalise: `OrganizationMember`'s and `Organization`'s policies are deliberately asymmetric, so equality is now the wrong assertion and "non-null where a write is possible, and built only out of declared tenancy functions" is the right one. Guard vacuity with a `toBeGreaterThan(0)` on the table count **and** on the policy count before the loops — an empty result set makes every `for` trivially true, and this gate's whole value is that it polices migrations nobody has written yet.

- [ ] **Step 6: Bind `SOFT_DELETABLE_MODELS` to the schema**

`packages/database/src/extensions/soft-delete.ts:16` is a hand-maintained `Set` holding only `'RlsProbe'`, and its own comment at :13-16 names Phase 1 as the phase that adds `User`, `Organization`, `Project` and `Model`. Add `User` and `Organization` — **not** `OrganizationMember`, which has no `deletedAt`.

Then write `packages/database/test/soft-delete-coverage.test.ts` (a unit test, no Docker): every model whose fields include `deletedAt` is in the set, and every name in the set is a real model with a `deletedAt`. Without this, a later model gains `deletedAt`, nobody edits the string set, and the model is silently unfiltered **and** hard-deletable.

**MEASURE the mechanism before writing against it**, the same way Step 2 measures
`@default(uuid(7))`. Nothing in this repository reads Prisma's datamodel today — a grep for
`dmmf` over `packages/` and `apps/` returns nothing — and whether `Prisma.dmmf` is exported and
**typed** by `prisma-client-js` on 7.9.1 is unverified. One command, output recorded:

```bash
node -e "const {Prisma}=require('@prisma/client'); console.log(typeof Prisma.dmmf, Object.keys(Prisma.dmmf ?? {}))"
```

If it is absent or untyped, the fallback is to parse `prisma/schema.prisma` for
`^\s*deletedAt\s+DateTime\?` per `model` block — different failure modes and a different Turbo
`inputs` declaration (the schema file, with `$TURBO_ROOT$`, per the Global Constraints note about
tests that read outside their own package). **Say which one shipped.**

Two things this leaves open, and the plan does not close them:

- `update`, `updateMany` and `upsert` are **not** filtered (`FILTERED_OPERATIONS` at :18-27 lists eight read operations). With `User` and `Organization` soft-deletable, renaming a deleted organization succeeds and an upsert resurrects a deleted row. That is also how "restore" would be implemented. Decide and record which it is.
- `Organization_slug_key` and `User_email_key` are **total** uniques, so a soft-deleted organization permanently occupies its slug and a soft-deleted user permanently occupies their email. The fix is a partial unique index (`WHERE "deletedAt" IS NULL`), which Prisma's DSL cannot express for PostgreSQL, so it is hand-written SQL that a later `prisma migrate dev` may report as drift. **Nothing in this repository has ever authored a partial index.** If you take it, prove the drift behaviour before eight tables depend on it; if you defer it, **write the consequence down at full strength, because "a re-signup then fails" undersells it.** `FILTERED_OPERATIONS` includes `findUnique`, `findFirst` **and** `count`, so once a `User` is soft-deleted the provisioning path raises `User_email_key` / `User_authProvider_externalAuthId_key` on every attempt while its "another request won; re-read and return" branch reads `null` on every attempt — a retry that never terminates successfully, reporting an error that points at a row the extension has made invisible. Task 6 Step 3 is where that has to be handled rather than discovered.

- [ ] **Step 7: Run everything and watch the shape**

```bash
pnpm db:generate; echo "EXIT=$?"
pnpm verify; echo "EXIT=$?"                    # migration-sql.test.ts + soft-delete-coverage run here, no Docker
pnpm test:integration; echo "EXIT=$?"
```

`migration-sql.test.ts:35-49` should now iterate four tables, not one. Its `DROP POLICY|NO FORCE|DISABLE ROW LEVEL SECURITY` grep (:66-70) covers the whole concatenated history, so **a wrong predicate is corrected by `ALTER POLICY` or a second named policy, never by dropping and recreating.**

- [ ] **Step 8: Mutations — seven, and each one has a named victim**

1. Delete `ALTER TABLE "User" FORCE ROW LEVEL SECURITY`. Expected: **non-zero**, `migration-sql.test.ts` — and it must fail in `pnpm verify`, with no Docker.
2. Change `WITH CHECK` on `OrganizationMember` to `WITH CHECK (true)`. Expected: **non-zero**, the meta-gate's "references a tenancy function" assertion **and** the behavioural cross-org insert test. **MEASURED, and only the first fired**: Prisma's `create` emits `RETURNING`, so the row it refuses is refused by the SELECT policy, and the two Postgres messages are byte-identical — the same row inserted with no `RETURNING` SUCCEEDED under the mutation. The behavioural case now uses `createMany` as well as `create` for exactly this reason.
3. Delete the whole `CREATE POLICY "User_tenant_isolation"` block. Expected: **non-zero**, the meta-gate's `qual` assertion is still satisfied by `User_identity_bootstrap`, so the victim here is the **behavioural** suite — cases 3 and 6. Say which assertion caught it; if only one did, that is the coverage report for this policy. **MEASURED, and the victim is neither**: the `beforeAll` SEED fails, because deleting the policy removes the only INSERT-capable predicate on `User`, so Vitest reports `15 tests | 15 skipped` with zero failures and cases 3 and 6 never execute. Detection by setup rather than by assertion; ADR-0040 consequence 11 records it, and what happens to it if the seed is ever moved onto the owner connection.
4. Delete the whole `CREATE POLICY "User_identity_bootstrap"` block. Expected: **non-zero**, behavioural case 7 — and, once Task 6 lands, the second-sign-in fixture. This is the mutation that proves the pre-identity read has a predicate rather than an assumption.
5. Remove `User` from `SOFT_DELETABLE_MODELS`. Expected: **non-zero**, `soft-delete-coverage.test.ts`.
6. Drop `Organization_personal_owner_required`. Expected: **non-zero**, behavioural case 8.
7. **Add a bare table to the applied surface, with no policy and no exemption** — append
   `CREATE TABLE "MutationProbe" ("id" UUID NOT NULL);` to the new `migration.sql` (no `ENABLE`,
   no policy, no `NOT_TENANT_SCOPED` entry), run `pnpm test:integration`, then restore. Expected:
   **non-zero**, on the meta-gate's `relrowsecurity` and "at least one policy" assertions. This is
   the mutation that proves the gate polices 1B, 1C and 1D rather than only this migration, so it
   has to be run against the surface the gate actually reads. **Editing `schema.prisma` would
   prove nothing**: the meta-gate enumerates `pg_class` in a live Testcontainers database, which
   reflects the migrations under `prisma/migrations/`, and `migrate deploy` applies files rather
   than diffing the schema — so a schema-only edit leaves `pg_class` unchanged and the suite
   green. **MEASURED both ways**: three meta-gate assertions fire (`relrowsecurity`/`FORCE`, "at
   least one policy", and the per-table `PERMISSIVE` existence check), and `pnpm test:unit` with the
   bare table still appended exits **0** — the asymmetry below, confirmed rather than argued. Note
   in the step that `migration-sql.test.ts` **cannot** see this table either: its
   `FORCE`-for-every-`ENABLE` loop starts from tables that say `ENABLE`, so one that says nothing
   is invisible to it. That asymmetry is the entire reason the meta-gate exists.

**If any mutation leaves the suite green, say so plainly rather than adjusting the test.**
**RUN, and six standing mutations the seven above do not cover.** All thirteen exit non-zero from
the committed tree. Six are worth re-running whenever 1B, 1C or 1D touches the tenancy predicates,
because each is the only proof that a specific fix is still in place: reverting
`OrganizationMember`'s `WITH CHECK` to `("organizationId" = app_current_org_id())` alone (case 4
three times over, plus the golden map); reverting `Organization`'s to `("id" =
app_current_org_id())` alone (case 11, plus the golden map); deleting
`OrganizationMember_delete_in_context` (case 10 measures `2` where `1` is correct, plus the golden
map); dropping either format CHECK (case 12); **appending a table DRESSED to pass** — `ENABLE`,
`FORCE`, one `PERMISSIVE` policy `TO public` whose halves are both `(true OR app_current_org_id()
IS NOT NULL)`, which satisfied every shape assertion before the golden map existed while its rows
crossed tenants; and **deleting the behavioural suite outright**, which passed both gates before
the gate asserted that file's existence.

- [ ] **Step 9: Commit**

```bash
git add packages/database docs
git commit -m "feat(database): add User, Organization and OrganizationMember behind RLS, with a catalog-driven coverage gate"
```

---

### Task 4: The tenancy primitive that cannot be forgotten, and ADR-0041 — **REVIEW**

`withOrganizationContext(client, organizationId: string, fn)` (`packages/database/src/client.ts:81-93`) takes a **bare string**. Nothing forces a caller to use it, and nothing connects it to who is asking. ROADMAP 1.6 words the same deliverable as "Prisma extension setting `app.current_org_id` per transaction", and ADR-0013 requires an `AuthContext` on every repository method. This task reconciles the three.

It also settles where a repository may physically live, which is the decision with the longest reach in this plan: `docs/ARCHITECTURE.md:527-539` puts a module's Prisma repositories at `modules/<name>/infrastructure/`, while `prismaImportBoundary`'s exemption is the literal glob `src/infrastructure/persistence/**/*.ts` (`packages/eslint-config/src/boundaries.js:120-122`). **A repository written at the documented location cannot import `@metrika/database` at all.** The two contradict, and every module in every later phase inherits the answer.

**Files:**

- Create: `apps/api/src/infrastructure/persistence/branding.ts`, `apps/api/src/infrastructure/persistence/tenant-context.ts`, **`apps/api/src/authorization/auth-context.ts`**, `docs/adr/0041-repository-location.md`
- Modify: `packages/database/src/client.ts`, `packages/database/src/index.ts`, `packages/eslint-config/src/boundaries.js`, `docs/adr/README.md`, `docs/ARCHITECTURE.md`, **`docs/adr/0005-prisma.md`, `docs/adr/0013-authorization.md`, `docs/adr/0018-branded-types.md` (status lines only — see Step 5)**
- Test: `packages/database/test/tenant-context.integration.test.ts`, `apps/api/test/branding.test.ts`, `packages/eslint-config/test/rules.test.ts` (new rows in the existing `describe('prisma boundary — ignores glob, exercised through an apps/api-shaped probe')` block), new fixture files under `packages/eslint-config/test/fixtures/persistence-probe/src/`

**`auth-context.ts` is created HERE, not in Task 5.** Task 4 produces
`runInTenant(auth: AuthContext, fn)` and the file-structure table calls
`tenant-context.ts` "the `AuthContext` → scope wrapper" — so the interface has to exist before
Step 6 runs `pnpm verify`. A repo-wide grep for `AuthContext` today returns matches only inside
`packages/database`'s `withOrganizationContext` docblock; the type does not exist. Task 5 spells
out its members and now **modifies** this file rather than creating it.

**Interfaces:**

- Consumes: Task 3 (`app_current_user_id()`, `app_current_auth_provider()` and `app_current_external_auth_id()` exist)
- Produces:
  - `withTenantContext<T>(client, scope: TenantScope, fn: (tx) => Promise<T>): Promise<T>` — sets **both** tenancy GUCs in one interactive transaction
  - `withIdentityContext<T>(client, identity: IdentityScope, fn): Promise<T>` — sets **only** the identity pair, and neither tenancy GUC
  - `brandUnsafe<T>(value: string): T` and `newUuidV7(): string`, importable only from inside the persistence zone
  - `interface AuthContext` in `apps/api/src/authorization/auth-context.ts` — Task 5 fills in its members
  - Exactly **three** entry points in `apps/api/src/infrastructure/persistence/tenant-context.ts`, which is the only module in the repository that calls either `with*Context`:
    - `runInTenant<T>(auth: AuthContext, fn): Promise<T>` — the ordinary path, and the only one an `AuthContext` can reach
    - `runInBootstrapTenant<T>(scope: TenantScope, fn): Promise<T>` — takes a **raw** scope, because first-login provisioning mints both ids and has no `AuthContext` to derive them from
    - `runInIdentityScope<T>(identity: IdentityScope, fn): Promise<T>` — the pre-identity lookup, and the only caller of `withIdentityContext`

**The last two are the declared bootstrap exemptions, and naming them is the point.** ADR-0013
decision 2 is "there is no method signature that permits forgetting who is asking"; two calls in
this slice genuinely run before there is anyone to ask about. Giving them their own named entry
points rather than letting them reach `withTenantContext` directly is what keeps the exemption a
**list of two** rather than a habit — 1B writes "`AuthContext` on every repository method" against
this list, and growing it is an ADR change. ADR-0040 records both, with reasons.

- [ ] **Step 1: Decide the repository location, and write ADR-0041**

| Answer                                                                                                         | What it costs                                                                                                                    | What it buys                                                                                        |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **(a) All repositories under `apps/api/src/infrastructure/persistence/<aggregate>/`**                          | Contradicts `ARCHITECTURE.md:527-539`, so that document needs an ADR against it; a module's data access lives outside the module | Zero ESLint change; every raw-Prisma import stays in one directory, which is a small review surface |
| **(b) Widen the glob to `['src/infrastructure/persistence/**/*.ts', 'src/modules/*/infrastructure/**/*.ts']`** | A `packages/eslint-config` change plus fixture rows; the raw-Prisma surface grows one directory per module                       | Matches the blueprint, and the blueprint is the source of truth (CLAUDE.md)                         |

**(b) is the recommendation**, on CLAUDE.md's own rule: a request that conflicts with the blueprint is either followed or superseded by an ADR, never silently diverged from — and the glob was written when there was one module. Note that `*` matches one path segment, so `src/modules/users/infrastructure/**` is exempted and a stray `src/modules/users/application/infrastructure/**` is not.

Either way an ADR is written. Either way the fixture in Step 4 is required: a boundary without a rejection fixture is an intention.

**ADR-0041 is not a greenfield decision — it scopes three Accepted ADRs, and its status line has
to say so.** Under (b), a repository at `apps/api/src/modules/*/infrastructure/**` may import
`@metrika/database` and `brandUnsafe`, which narrows **ADR-0005 decision 1** ("`@prisma/client`
may only be imported from `apps/api/src/infrastructure/persistence/**`") and **ADR-0018** ("a
single `brandUnsafe` helper, importable only from `apps/api/src/infrastructure/persistence/**`,
enforced by an ESLint zone"). Step 3's "do not turn this into a Prisma client extension" narrows
**ADR-0013 decision 3** ("`app.current_org_id` set per transaction by a Prisma client
extension"). Give it the status line this repository already uses for exactly this —
ADR-0037's reads "Accepted, scopes part of ADR-0005", and ADR-0023, ADR-0024, ADR-0026 and
ADR-0027 all carry the same form:

```
**Status:** Accepted · **Date:** <date> · Scopes part of ADR-0005, ADR-0013 and ADR-0018
```

Under (a), only ADR-0013 is scoped and `ARCHITECTURE.md:527-539` is what needs the ADR against
it. Either way, **Step 5 does the bookkeeping** — the forward-pointing status lines, the README
rows and the two lint messages. Writing the new ADR and leaving those is what produces five
places asserting a rule the tree no longer has.

- [ ] **Step 2: Write the failing tests**

`packages/database/test/tenant-context.integration.test.ts` — the shape of `organization-context.integration.test.ts:11-44`, extended:

1. Inside `withTenantContext`, `current_setting('app.current_org_id')` and `current_setting('app.current_user_id')` both read the values passed.
2. After the callback returns, a query on the **same client** sees neither — this is the pooled-connection leak the transaction exists to prevent, and it was reproduced once as a silent cross-tenant read.
3. A row written inside the context is invisible to an unscoped read on the same client afterwards.
4. `set_config(..., true)` is transaction-local: two concurrent `withTenantContext` calls with different scopes do not observe each other's setting.
5. Inside `withIdentityContext`, the identity pair reads the values passed **and both tenancy GUCs read empty** — the isolation that keeps the widened `User` predicate out of every other query is a property of this function, so it is asserted here rather than assumed.

`apps/api/test/branding.test.ts` — `newUuidV7()` produces a value whose version nibble is `7` and whose variant bits are `10`; ids generated in **different** milliseconds sort lexicographically in generation order. Assert the negative too, and say why: **within a single millisecond the tail is random, so ordering is not guaranteed** — which is exactly why 1B's cursor still needs an `id` tie-break.

**This test file is inside the ban Step 4 adds, and that has to be resolved before it is
written.** `apps/api`'s lint script is `eslint .` and ignores only `dist/`, `coverage/` and
`openapi/`, so `test/**/*.ts` is linted by `prismaBoundary`; a test asserting on `brandUnsafe` and
`newUuidV7` must import `../src/infrastructure/persistence/branding.js` from outside the zone,
which trips the very rule the task just added, and `pnpm lint --max-warnings=0` inside
`pnpm verify` fails. Two answers, and the recommendation is the second:

- **Co-locate at `apps/api/src/infrastructure/persistence/branding.test.ts`.** Costs two config
  changes, not one: `apps/api/vitest.config.ts`'s `include` is `['test/**/*.test.ts']` and would
  have to gain `src/**/*.test.ts`, and `tsconfig.build.json`'s `include` is `['src/**/*.ts']` —
  so the test file would be **compiled into `dist/`** and ship with the application. That is a
  real cost paid by every future co-located test, for one file.
- **A second, narrowly-scoped config object in `boundaries.js` that CARRIES WHAT IT DISPLACES.**
  `files: ['test/branding.test.ts']`, repeating the `@prisma/client` and `@metrika/database`
  `paths` and `patterns` entries and omitting **only** the `branding` pattern. This is the
  hazard-aware form the repository already uses twice — `featureBoundary` and
  `serverActionBoundary` each carry `webBoundary`'s displaced entries for exactly this reason
  (`boundaries.js:196-237`), and `apps/api/eslint.config.js`'s `workflows` comment says the same.
  Hoist the shared `paths`/`patterns` into a module-level constant first, the way
  `FORBIDDEN_WEB_PACKAGES` is, so the two objects cannot drift.

Whichever is taken, **Step 4's fixture list gains the row that proves the narrowing did not widen
the package bans**: `@metrika/database` imported from a `test/branding.test.ts`-shaped path is
still rejected. A narrowing with no negative control is the same bug the `slice(1)` comment at
`boundaries.js:111-118` describes.

- [ ] **Step 3: Implement**

`withTenantContext` replaces nothing: keep `withOrganizationContext` exported and mark it superseded in its docblock, because `packages/database/test/organization-context.integration.test.ts` and the `RlsProbe` suite depend on it and `RlsProbe` has no user column.

**Two scope shapes, because there are two moments.** The pre-identity one is not a degenerate
tenant scope with fields left blank — it sets different settings and unlocks a different policy,
and typing them as one shape with optional fields is what would let a caller reach the bootstrap
predicate from an ordinary request.

```ts
export interface TenantScope {
  readonly organizationId: string;
  readonly userId: string;
}

/** The pre-identity shape. Deliberately NOT a partial TenantScope. */
export interface IdentityScope {
  readonly authProvider: string;
  readonly externalAuthId: string;
}

export async function withTenantContext<T>(
  client: PrismaClient,
  scope: TenantScope,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return client.$transaction(
    async (tx) => {
      // Two statements, not one call with two arguments: set_config takes one
      // name. Bind parameters, never interpolation — SET LOCAL cannot take a
      // bind parameter, which is the whole reason set_config is used here, and
      // $executeRawUnsafe is banned in this package too.
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${scope.organizationId}, true)`;
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${scope.userId}, true)`;
      return fn(tx);
    },
    { timeout: 10_000 },
  );
}

/**
 * Sets ONLY the identity pair, so `User_identity_bootstrap` is the only policy
 * that can match and every other table stays deny-by-default inside `fn`. That
 * narrowness is the reason this is a separate function rather than two more
 * optional fields on TenantScope: a caller cannot accidentally carry the
 * bootstrap predicate into an ordinary request.
 */
export async function withIdentityContext<T>(
  client: PrismaClient,
  identity: IdentityScope,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return client.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_auth_provider', ${identity.authProvider}, true)`;
      await tx.$executeRaw`SELECT set_config('app.current_external_auth_id', ${identity.externalAuthId}, true)`;
      return fn(tx);
    },
    { timeout: 10_000 },
  );
}
```

In `apps/api`, `apps/api/src/infrastructure/persistence/tenant-context.ts` is the **only** module
that calls either function, and it exposes the three entry points named in Interfaces above.
`runInTenant(auth, fn)` derives the scope from an `AuthContext`; `runInBootstrapTenant(scope, fn)`
and `runInIdentityScope(identity, fn)` are the two declared exemptions and are reachable only from
identity resolution and first-login provisioning. Note the interactive-transaction limits
documented at `client.ts:61-93`: one pooled connection for the callback's whole duration, `P2028`
past the timeout. Request-scoped repository work only.

`newUuidV7()` is **hand-written, with no new dependency**. Node 24's `crypto.randomUUID()`
produces v4 only and there is no `uuid` package anywhere in the workspace — so it is 48 bits of
`Date.now()`, the version nibble, the variant bits and a random tail, assembled from
`crypto.getRandomValues`. Said explicitly so a reviewer knows a dependency addition was
considered and not silently skipped, and so nobody reaches for `randomUUID()` and ships v4 behind
a v7 name, which no test in Step 2 would catch if it only asserted "it is a UUID".

Do **not** turn this into a Prisma client extension that opens a transaction per operation. ROADMAP 1.6's wording says "extension" and so does **ADR-0013 decision 3**; the measured design is a function, and an extension wrapping every model operation changes connection behaviour and multiplies transactions per request. ADR-0041 records that both the roadmap wording and ADR-0013's mechanism yield to the measurement — which is why its status line scopes ADR-0013 — and Task 9 updates the roadmap so the two documents agree.

- [ ] **Step 4: Add the ESLint change and its fixture rows**

Whichever answer Step 1 took, `brandUnsafe` must not be importable from outside the persistence zone (ADR-0018). Add its restriction to the **same** `no-restricted-imports` options object `prismaImportBoundary` already owns — flat config replaces a rule's options wholesale per key, so a second config object naming the same rule id silently drops one of the two. That hazard is documented at `boundaries.js:196-237` and has already happened once in this repository.

That is also the rule the branding-test exemption from Step 2 has to obey, and the two are not in
conflict: a second config object is legal **only** if it carries every entry it displaces for the
files it matches, which is exactly what `featureBoundary` and `serverActionBoundary` do to
`webBoundary`. Hoist the shared `paths`/`patterns` into one module-level constant first — the
`FORBIDDEN_WEB_PACKAGES` pattern — so the two objects cannot drift apart, and let the last row of
the fixture table be the proof they did not.

**Name the real files — the ones the earlier draft of this task named do not do what the task
needs, and one of them does not exist.**

- **Modify `packages/eslint-config/src/boundaries.js`** — `prismaImportBoundary`'s `ignores` at
  :120-122 and the same options object's `paths`/`patterns`.
- **`packages/eslint-config/test/eslint.boundaries.config.js` is the WRONG file.** It is three
  lines, `export default [...contractsBoundary]`, and exercises the contracts boundary. The
  Prisma boundary is driven by `test/eslint.prisma.config.js` (`[...prismaBoundary]`) and by
  `test/fixtures/persistence-probe/eslint.config.js`, which is the one that matters here: the
  `ignores` glob resolves relative to **the consuming config file's** location, so only the probe
  package can express "inside `src/modules/users/infrastructure/`". `rules.test.ts:118-126`
  documents exactly this, and it is why the flat `fixtures/*.ts` files can never assert anything
  about an `ignores` path.
- **`packages/eslint-config/test/boundaries.test.ts` does not exist.** The prisma-boundary rows
  live in `packages/eslint-config/test/rules.test.ts`, in the
  `describe('prisma boundary — ignores glob, exercised through an apps/api-shaped probe')` block
  at :118-152. Add there.

New fixture files, inside the probe so the glob is meaningful:

| Fixture                                                                          | Expected                                               |
| -------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `test/fixtures/persistence-probe/src/modules/users/infrastructure/repository.ts` | **accepted** — `@metrika/database` at the new path     |
| `test/fixtures/persistence-probe/src/modules/users/application/service.ts`       | **rejected** — one segment outside the exemption       |
| `test/fixtures/persistence-probe/src/domain/order.ts` (exists)                   | **rejected** — the negative control already in place   |
| a `branding.js` import from outside persistence                                  | **rejected**                                           |
| `@metrika/database` from the `test/branding.test.ts`-shaped path                 | **rejected** — proves Step 2's narrowing stayed narrow |

- [ ] **Step 5: The supersession bookkeeping ADR-0041 owes three ADRs**

An ADR that changes a decision without saying so leaves the tree and the documents disagreeing,
and this repository's convention for it is explicit and mechanical. Do all four:

1. **Forward-pointing status lines.** Append to `docs/adr/0005-prisma.md`,
   `docs/adr/0013-authorization.md` and `docs/adr/0018-branded-types.md`'s status lines —
   `· Scoped in part by ADR-0041`. ADRs are immutable **apart from a status line**; that is the
   one edit the rule permits, and ADR-0032/0033 are the worked examples.
2. **`docs/adr/README.md`** — the new 0041 row carries the relationship in its Status column, the
   way every other row does.
3. **The two lint messages.** `packages/eslint-config/src/boundaries.js:132` and `:137` both read
   "Prisma access goes through apps/api/src/infrastructure/persistence — see ADR-0005". Under
   answer (b) that sentence is no longer the rule and the citation is no longer the authority.
   Rewrite both to name the paths the glob actually exempts and to cite ADR-0041. A developer who
   trips this rule reads the message, not the ADR index.
4. **CLAUDE.md's two Boundaries bullets** — "`@prisma/client` may only be imported from
   `apps/api/src/infrastructure/persistence/**`" and "`@metrika/database` is restricted exactly
   like `@prisma/client`". Task 9 Step 5 owns the edit; **this step's job is to put both bullets
   on Task 9's explicit list**, because Task 9's CLAUDE.md line names the current-state paragraph,
   the commands and the frontend block, and would otherwise leave the two sentences that state
   the old rule verbatim.

- [ ] **Step 6: Mutations**

1. Drop the `app.current_user_id` `set_config` line. Expected: **non-zero**, the tenant-context test and (once Task 7 lands) the `/me` memberships assertion.
2. Change `is_local` from `true` to `false` in either statement. Expected: **non-zero**, the leak assertion — this is the mutation that proves the transaction is load-bearing rather than decorative.
3. Remove the new `ignores` entry. Expected: **non-zero**, the "accepted" fixture row. Restore.
4. Make `runInIdentityScope` call `withTenantContext` instead of `withIdentityContext`. Expected: **non-zero**, the "both tenancy GUCs read empty" assertion — and it must be that assertion, not a type error, or the isolation is enforced by the compiler in this file only.

- [ ] **Step 7: Verify and commit**

```bash
pnpm verify; echo "EXIT=$?"
pnpm test:integration; echo "EXIT=$?"
git add packages apps/api docs
git commit -m "feat(database): set the tenancy and identity GUCs from three named scope entry points"
```

---

### Task 5: The auth guard, and `AuthContext` — **REVIEW**

The only bearer handling in this application today is `DeepHealthGuard`'s static shared-secret compare, and `.env.example` says in so many words that the Clerk guard replaces it in Phase 1. This task builds the replacement.

Read `apps/api/src/modules/health/deep-health.guard.ts:35-113` before writing anything. Two of its properties are the ones to copy: it SHA-256-digests both operands before `timingSafeEqual` because that function **throws** on unequal lengths and the length guard would itself be the timing signal; and it throws `DomainError('UNAUTHENTICATED', 'Credenciales requeridas.')` rather than `UnauthorizedException`, because a Nest 4xx's English message is forwarded verbatim into the user-facing `error.message`.

**Files:**

- Create: `apps/api/src/modules/auth/auth.module.ts`, `apps/api/src/modules/auth/application/token-verifier.ts`, `apps/api/src/modules/auth/application/auth-context.factory.ts`, `apps/api/src/modules/auth/api/auth.guard.ts`
- Modify: `apps/api/src/authorization/auth-context.ts` (**created in Task 4**; this task fills in its members), `apps/api/src/shared/request-context/request-context.ts`, `apps/api/src/config/env.ts`, `.env.example`, `apps/api/src/app.module.ts`, `apps/api/package.json`
- Test: `apps/api/test/token-verifier.test.ts` (unit, offline keypair), `apps/api/test/auth-guard.integration.test.ts`, `apps/api/test/request-identity.integration.test.ts`

**Interfaces:**

- Consumes: Task 1 (`<pin>`s and the offline verification recipe), Task 3 (the tables and the identity-bootstrap policy), Task 4 (`runInTenant`, `runInIdentityScope`, `brandUnsafe`)
- Produces:
  - `interface AuthContext { readonly userId: UserId; readonly organizationId: OrganizationId; readonly organizationRole: OrganizationRole; }`
  - `AuthGuard` — a class, injected by value, never `import type`
  - `verifyToken(raw: string): Promise<VerifiedIdentity>` where `VerifiedIdentity = { externalAuthId: string; authProvider: 'clerk' }`

**`platformRoles` is NOT on `AuthContext` in 1A, and the omission is the honest form.**
`PlatformRoleAssignment` is deferred to 1D (see the Deferred table), so a `platformRoles` field
here has exactly one possible implementation — a hardcoded `[]` — and a hardcoded `[]` makes this
plan's own definition-of-done clause _"no role anywhere in the graph is read from a JWT claim, and
the mutation that makes the factory read one turns a test red"_ **unfalsifiable for the platform
half**: there is no database alternative to mutate against, so the mutation cannot be written and
the absence cannot be detected. Declaring the field and leaving it empty is worse than not
declaring it, because it reads as covered. `AuthContext` gains `platformRoles` in **1D**, in the
same slice as the table the factory would read it from and the elevated client it gates.
Everything 1A asserts about "roles come from our database" is asserted about
`organizationRole`, which does have a table, and Step 6's mutation 2 is real for it.

- [ ] **Step 1: Write the failing negative fixtures first, offline**

`apps/api/test/token-verifier.test.ts`. Generate an RS256 keypair in the test. Each of these must reject, and each must reject as `DomainError` with `code === 'UNAUTHENTICATED'`:

| Case                                                   | Why it is here                                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Signature made with a different key                    | STRIDE #12, `docs/SECURITY.md:213-226` — "integration test with a forged token"    |
| `exp` in the past                                      | The ordinary case                                                                  |
| `iss` from another Clerk instance                      | A valid token from someone else's tenant is still a valid token                    |
| `kid` absent from the key set                          | Key rotation, and the shape a JWKS cache bug produces                              |
| `alg: none`                                            | The oldest JWT attack; a library that honours it is a finding, not a configuration |
| HS256 signed with the RSA **public** key as the secret | Algorithm confusion; the verifier must pin the expected algorithm, not trust `alg` |
| A well-formed token whose `sub` matches no `User`      | Not an authentication failure — see Step 4                                         |

**A test that only asserts "it threw" passes for a typo in the verifier's own code.** Assert the `DomainError.code` on every row.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @metrika/api --fail-if-no-match test:unit; echo "EXIT=$?"
```

Expected: **non-zero**, `Cannot find module '../src/modules/auth/application/token-verifier.js'`.

- [ ] **Step 3: Add the environment keys, in the same commit as `.env.example`**

`apps/api/test/env-example.test.ts:41-48` asserts every key in `EnvSchema.shape` is documented in the root `.env.example` **and** that `parseEnv(readEnvExample())` does not throw. So a required key with no example value fails `pnpm verify`.

Which keys depends on ADR-0038 — likely `CLERK_ISSUER` and `CLERK_JWKS_URL` (or one derived from the other) and `CLERK_SECRET_KEY`. Two rules:

- **The values in `.env.example` must be shaped like the real thing and be obviously not real.** They are committed; `HEALTH_DEEP_TOKEN=local-health-deep-token` is the existing precedent.
- **If any key is required, the `openapi` CI job must be able to supply it.** That job builds the module graph with step-scoped `DATABASE_URL` and `HEALTH_DEEP_TOKEN` and deliberately never calls `app.init()`, so nothing connects — but `ConfigModule`'s factory validates the environment while the graph is constructed. A newly required key with no value there turns the `openapi` job red in Task 7, not here. Task 9 owns the workflow edit; decide the scope now and write it in the env docblock.

- [ ] **Step 4: Implement, and keep the two failures distinct**

`verifyToken` answers only "did we issue-verify this token, and who does it say it is". Everything else is the factory's:

- **It resolves `externalAuthId` → `User` through `runInIdentityScope`, not `runInTenant`.** This
  is the order the design forces and the one it is easiest to get backwards: `runInTenant` takes
  the `AuthContext` this call is **constructing**, and on a returning sign-in neither
  `organizationId` nor `userId` is known before the row is read. The repository method is
  `findByExternalAuthId(identity: IdentityScope): Promise<UserRecord | null>` — **the one
  declared exception to "`AuthContext` on every repository method"**, named in ADR-0040 with its
  reason, and the only method in the codebase whose signature does not carry one. Task 3's
  `User_identity_bootstrap` policy is what makes it return a row at all; without both halves the
  second sign-in of every user reads zero rows and falls into provisioning.
- Once the `User` is known, everything after it runs in `runInTenant`: the memberships read, the
  active-organization membership check, the role lookup.
- **Roles come from `OrganizationMember`, never from a claim.** ADR-0012 is explicit and this is the line the whole phase rests on. If the token carries `org_id` or `org_role`, ignore them **deliberately** — with a comment naming ADR-0012, so the next reader knows the omission is a decision. (`PlatformRoleAssignment` is 1D's; see the Interfaces note above. Do not read platform roles from anywhere in 1A, including from a claim, including "temporarily".)
- `X-Metrika-Org-Id` is a **claim**, verified against membership (`docs/CONTRACTS_AND_API.md:204-209`). When absent, 1A resolves the active organization to the caller's personal organization.

**Open decision, and it is 1A's to make because every later route inherits it:** where the active organization comes from — the header, a path segment, or a session claim. The header is what the contract already names, keeps every route's path free of tenancy, and needs one membership check per request. A path segment (`/orgs/:slug/...`) makes the tenancy visible and bookmarkable and changes every route signature and every `apps/web` cache key. A session claim moves it into a cookie and creates `apps/web/src/lib/session/` — the first legitimate Server Action in this repository (ADR-0015). Whichever is chosen, `/me` must return the memberships the switcher will render, so `MeResponse` is unaffected.

A verified token whose `sub` matches no `User` is **not** a 401 in 1A: it is the first-login case, and Task 6 provisions. Keep the two paths separate in code — collapsing them means a provisioning bug reports itself as an authentication failure.

- [ ] **Step 5: Bind the authenticated identity onto the request context — the phase's observability deliverable**

The constant per-phase definition of done requires "observability (span, metric or correlated
log) for anything that can fail" (`docs/ROADMAP.md:696`), and this is the slice that owes it:
`docs/OBSERVABILITY.md:58` carries a chain-table row reading "`userId` / `organizationId` on the
same line | **no** | there is no authentication yet (Phase 1)". 1A is what removes that blocker,
and it adds three failure classes that have no log line, no span attribute and no metric today —
**token verification rejection, first-login provisioning failure or constraint retry, and RLS
deny**.

**This is design work, not a one-liner, and no other task owns it.**
`apps/api/src/shared/request-context/request-context.ts:4-12` declares
`interface RequestContext { readonly requestId: string }` — one field, readonly — and
`RequestContextMiddleware` calls `runWithRequestContext` exactly once, in middleware, **before
any guard runs**. So the identity cannot simply be written into the context that already exists.
Two mechanisms, and the choice must be recorded:

| Mechanism                                                                                                                                            | What it costs                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A mutable identity slot** on the stored object — `RequestContext` gains `identity: { userId, organizationId } \| undefined`, set once by the guard | Gives up `readonly`, which is the property that makes the current shape impossible to corrupt. Mitigate with a setter that throws on a second write, so "set twice" is a loud failure rather than a race |
| **A nested `storage.run`** from the guard, carrying the existing `requestId` forward                                                                 | Keeps everything readonly, but the guard must return through `next()` for the nested scope to cover the handler — measure that a Nest guard's return actually keeps the handler inside the callback      |

Whichever ships: `userId` and `organizationId` reach **every Pino line** (through the existing
`logHook` that already stamps `requestId`) and **the server span**, and
`apps/api/test/request-identity.integration.test.ts` asserts it over a real socket rather than by
inspection — one authenticated request, and both names present on a captured log line and on the
span's attributes.

**One measured caveat, because the corpus is not symmetric here.** `organizationId` is declared
`MUST_SURVIVE` in `packages/contracts/src/redaction.ts`, so it is guaranteed to reach the sink.
`userId` is **not in `redaction-corpus.json` at all** — measured against
`packages/contracts/dist/index.js`, `isRedactedKey('userId')` is `false` today, but nothing
asserts it stays false, so a future widening of the matcher could censor it silently. Either add
`userId` to `MUST_SURVIVE` — which costs a `pnpm contracts:emit` in the same commit and a corpus
diff, the same price Task 2 Step 5 prices for `email` — or record in ADR-0039 that it is
deliberately unguarded. Do not leave it measured-but-undeclared.

- [ ] **Step 6: Write the integration fixture against the real graph**

`apps/api/test/auth-guard.integration.test.ts`, through `bootApiForTest()`. The guard must be reachable from `AppModule` or `apps/api/test/boot.integration.test.ts` does not cover it — and that boot test is **the only guard against `import type` on an injected class**, which `tsc` and ESLint both pass silently.

Assert over a real socket: no `Authorization` header → 401 with `{ code: 'UNAUTHENTICATED' }` and our Spanish message, not an English framework string; a forged token → the same; a valid token → the request reaches the handler. And, once for each: a rejected token and an RLS deny each produce a **correlated** log line carrying `requestId` and `traceId` — the two failure classes that are otherwise silent.

- [ ] **Step 7: Mutations**

1. Replace the algorithm pin with "trust the token's `alg`". Expected: **non-zero**, the HS256-confusion row.
2. Make the factory read a role from the token payload instead of the database. Expected: **non-zero** — and if nothing goes red, **the phase's central control has no test and that is the finding.** Write it down rather than moving on.
3. Change the guard to throw `UnauthorizedException`. Expected: **non-zero**, the Spanish-message assertion.
4. Stop binding `organizationId` onto the request context. Expected: **non-zero**, `request-identity.integration.test.ts`. If that mutation is green, the chain-table row Task 9 is about to flip is still false and the documentation edit would be a claim rather than a fact.

- [ ] **Step 8: Verify and commit**

---

### Task 6: First-login provisioning, idempotent by constraint — **REVIEW**

ROADMAP 1.2's emphasis is on the automatic personal organization, and `docs/ARCHITECTURE.md:766` gives the reason: every user gets one on signup, "for the cost of one row per user", and it is what removes the "resource with no organization" branch from every policy and every query in the rest of the system.

The house rule is that this is idempotent by a database unique constraint, not an application check. Two are available: `User_authProvider_externalAuthId_key` and `OrganizationMember_organizationId_userId_key`, plus `Organization_personalOwnerUserId_key` from Task 3.

**Files:**

- Create: `apps/api/src/modules/users/users.module.ts`, `apps/api/src/modules/users/application/provision-user.ts`, `apps/api/src/modules/users/application/user-repository.ts` (the **interface**, declared in `application/` per `ARCHITECTURE.md`'s layer rule), `apps/api/src/modules/users/domain/slug.ts`, and the implementation at whichever path ADR-0041 chose
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/provisioning.integration.test.ts`, `apps/api/test/slug.test.ts`

**Interfaces:**

- Consumes: Tasks 3, 4, 5
- Produces:
  - `provisionUser(identity: VerifiedIdentity, profile: ClerkProfile): Promise<AuthContext>` — a use case, with **no** persistence import of its own
  - `UserRepository.provisionIdentity(identity, profile): Promise<ProvisionedIdentity>` — one unit-of-work method that owns the id minting, the transaction and the GUCs

**Two signature rules that this task, as the first repository in the codebase, establishes for
every module copied from it:**

1. **Every repository method takes `auth: AuthContext` as its first parameter**, per ADR-0013
   decision 2 — "there is no method signature that permits forgetting who is asking". That
   includes `/me`'s memberships read in Task 7, which is post-authentication and therefore has
   one available. Deliverable 1.5 lands in 1B, but the _shape_ cannot: 1B would be retrofitting
   signatures onto the two repositories every later module was copied from, rather than adding a
   layer on top of them.
2. **The two exceptions are named, and there are exactly two**: `findByExternalAuthId(identity)`
   (Task 5 — runs before an `AuthContext` can exist) and `provisionIdentity(identity, profile)`
   (this task — creates the rows an `AuthContext` would be derived from). Both are recorded in
   ADR-0040 with reasons, both route through Task 4's named bootstrap entry points, and the list
   does not grow without an ADR. The guard 1A can afford is a type-level test asserting the
   `auth`-first shape over the repository interface, plus the review surface of a two-name list —
   not a deferral of the whole rule.

**`provision-user.ts` must not import `@metrika/database` or `branding.ts`.** Task 4 Step 4 adds a
fixture asserting that an `@metrika/database` import from `src/modules/users/application/` is
**rejected**, `withTenantContext` is exported from `@metrika/database`, and `newUuidV7` is behind
the `branding.ts` restriction — so a use case that mints ids and opens the transaction itself
fails this task's own `pnpm verify`, and breaks `ARCHITECTURE.md` §10's layer rule
("`application → infrastructure` through interfaces defined in `application`") besides. The id
minting, the GUC-setting transaction and the retry all live behind `provisionIdentity`.

- [ ] **Step 1: Write the failing concurrency test first**

`apps/api/test/provisioning.integration.test.ts`, against the real container:

```ts
// Not a loop of sequential calls — a sequential second call would be satisfied by
// a read-then-write check, which is exactly the implementation this test exists to
// reject. Concurrency is the assertion.
const results = await Promise.allSettled(
  Array.from({ length: 8 }, () => provisionUser(identity, profile)),
);
expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

// THE ASSERTION THAT MAKES THE ONE ABOVE MEAN SOMETHING. `allSettled` + three
// counts passes even if the seven losers return a different userId, or none —
// provided their transactions merely rolled back cleanly. The property the house
// rule actually claims is that eight concurrent calls converge on ONE identity.
const userIds = new Set(results.map((r) => (r as PromiseFulfilledResult<AuthContext>).value.userId));
expect(userIds.size).toBe(1);

// Exactly one of each. "The filter deliberately absent" means the APPLICATION
// `where`, not the tenancy GUC: read back inside runInBootstrapTenant with the
// winner's scope, because under Task 3's policies an unscoped count as
// metrika_app returns 0 — the same deny-by-default the RLS suite asserts. The
// GUC is the control being proven here, not the thing being bypassed, and an
// executor who "fixes" a 0 by reaching for withDeleted() or an admin URL has
// quietly weakened the fixture.
const [userId] = userIds;
await runInBootstrapTenant({ userId, organizationId }, async () => {
  expect(await countUsers(identity.externalAuthId)).toBe(1);
  expect(await countPersonalOrgsOwnedBy(userId)).toBe(1);
  expect(await countMemberships(userId)).toBe(1);
});
```

Also assert: the single `OrganizationMember` has `role: 'OWNER'`; the organization has `kind: 'PERSONAL'`; and a **second** call after the first has committed returns the same `userId` rather than creating anything.

**And the fixture that no other test in this plan would have caught**: _the second sign-in of the
same identity returns 200 with the same `userId`_ — driven through the real guard, over a socket,
after the first has committed. That is the path Task 3's `User_identity_bootstrap` policy exists
for, and it is the one that silently returns zero rows if the policy is missing, sending every
returning user into provisioning and onto a unique-constraint violation.

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement — inside `provisionIdentity`, one transaction, ids minted first**

All of this is the **repository's**, behind the interface `application/` declares. The order is forced by Task 3's `WITH CHECK` predicates:

1. `newUuidV7()` for the user id and the organization id.
2. `runInBootstrapTenant({ userId, organizationId }, …)` — both GUCs set before any write. Not `withTenantContext` directly: `tenant-context.ts` is the only module that calls it, and this is one of the two declared exemptions Task 4 named.
3. Insert `User` (explicit `id`), `Organization` (explicit `id`, `personalOwnerUserId = userId`), `OrganizationMember` (`role: 'OWNER'`).

On a unique violation: **discriminate on `meta.driverAdapterError.cause.kind === 'UniqueConstraintViolation'`**, read `cause.constraint.fields` to learn which constraint fired, and branch. Do not read `meta.target` — it was removed in Prisma 7 and reads `undefined` with no complaint from `tsc`. Do not key on `code === 'P2002'` — the identical violation surfaces as **P2010** through `$executeRaw`, so the code is not the discriminator (`packages/database/test/error-shape.integration.test.ts:105-186`).

**NAME THE RETRY BOUNDARY BEFORE WRITING EITHER BRANCH — neither can execute where it looks
like it belongs.** The three inserts are inside one interactive transaction
(`client.$transaction`, `packages/database/src/client.ts:86`), and Postgres puts that transaction
into the aborted state on a unique violation: every subsequent statement fails with `25P02` until
rollback, so a `catch` placed after the failing `INSERT` and inside the transaction cannot
re-read anything. Moving the `catch` outside `runInBootstrapTenant` does not fix it either — the
transaction has rolled back, and the re-read would run under the **loser's** minted GUC values,
which satisfy neither half of Task 3's `User_tenant_isolation` predicate, so it reads `null`.
Two workable boundaries; pick one and write which:

- **A `SAVEPOINT` per slug candidate**, inside the interactive transaction. Recovers the slug
  collision without abandoning the transaction, and is the narrower of the two — but it does
  nothing for the `User` constraint, whose loser has no work left to keep.
- **The whole `runInBootstrapTenant` call retried in a fresh transaction, with the scope
  recomputed.** Handles both, and is the only shape that works for the `User` branch.

- `User_authProvider_externalAuthId_key` → another request won. **The re-read is
  `findByExternalAuthId` through `runInIdentityScope`**, not a read under the loser's own minted
  ids: the winner's `User` row is invisible to the loser's tenant scope, and the identity-bootstrap
  policy is the only predicate that can see it. This is the same mechanism Task 5's factory uses,
  and it is the second reason Task 3 ships that policy.
- `Organization_slug_key` → collision; retry with the next suffix, bounded (Step 4).
- **A unique violation whose conflicting row is invisible.** `FILTERED_OPERATIONS`
  (`packages/database/src/extensions/soft-delete.ts:18-27`) includes `findUnique`, `findFirst`
  and `count`, so once a `User` is soft-deleted the constraint fires on every attempt while the
  re-read returns `null` on every attempt — an unbounded retry reporting an error that points at
  a row the extension has hidden. Wrap the recovery read in `withDeleted()` and fail with a named
  `DomainError` rather than looping. **Fixture:** soft-delete a user, then sign in as that
  identity, and assert the named error rather than a timeout.

- [ ] **Step 4: The slug rule, and its own unit test**

`Organization.slug` is globally unique across PERSONAL and TEAM organizations, so "Ana Rodríguez" needs a deterministic collision rule. `apps/api/src/modules/users/domain/slug.ts` is pure (no I/O, no `Date`, no `Math.random`) and produces a candidate sequence; the repository walks it, retrying on the unique violation.

`apps/api/test/slug.test.ts` asserts, at minimum: `Ana Rodríguez` → `ana-rodriguez` (diacritics folded, not stripped to `ana-rodrguez`); an empty or all-punctuation display name still yields a usable slug; the candidate sequence is deterministic and bounded; and a candidate never collides with a reserved path segment (`me`, `admin`, `api`, `new`) — because a slug becomes a URL segment the moment 1C ships the switcher.

Decide and record: is a slug mutable? Making it renameable breaks every URL and cached link that names it. 1A can leave it immutable and 1C can revisit; leaving it undecided is what produces an accidental answer.

- [ ] **Step 5: Observability for the three ways this can fail**

Provisioning is the slice's most failure-prone path and the constant definition of done asks for
a span, a metric or a correlated log on anything that can fail (`docs/ROADMAP.md:696`). Three
outcomes, each of which must be visible without a debugger and each of which is a **different
line**, because collapsing them is how "we retried once" and "we retried forty times" become
indistinguishable:

- the **constraint-driven retry** — one line per retry at `debug`, carrying which constraint
  fired and the attempt number, so a slug fight is legible as a slug fight;
- the **bounded-retry exhaustion** — `error`, with the cause in `err` and never in `msg`
  (redaction is field-granular and cannot reach inside free text);
- the **soft-deleted-conflict** case above — `error`, with its named `DomainError` code.

All three inherit `requestId`, `traceId`, `userId` and `organizationId` from Task 5's binding.
Nothing untrusted goes in `msg`: not the display name, not the email, not the slug candidate.

- [ ] **Step 6: Mutations — four, and the first two are the point of the task**

1. Replace the constraint-driven path with a read-then-write pre-check (`findFirst`, then create if absent). Expected: **non-zero** — the concurrency test must go red. **If it stays green, the test is sequential in disguise and proves nothing about the property the house rule names.**
2. Remove `@@unique([authProvider, externalAuthId])` from the schema and re-migrate against a scratch container. Expected: **non-zero**, the same test.
3. Remove `personalOwnerUserId`'s unique. Expected: **non-zero**, the "exactly one personal organization" assertion. Then remove `Organization_personal_owner_required` **instead** and run again: the unique alone does not close the invariant (Postgres treats NULLs as distinct), so this pair is what proves the two halves are both load-bearing.
4. Make `provisionIdentity`'s recovery branch re-read under the loser's own scope instead of through `runInIdentityScope`. Expected: **non-zero**, the "all eight return the same `userId`" assertion — the one that was added because `allSettled` plus three counts cannot see this.

- [ ] **Step 7: Verify and commit**

---

### Task 7: `/me`, and the HTTP infrastructure it lands — **REVIEW**

**No route in this application currently lives under the global prefix.** `API_PREFIX = 'api/v1'` is set with the three health probes excluded (`bootstrap.ts:13,39`), and `apps/api/test/boot.integration.test.ts:83-89` carries a standing note that the prefix's positive half is asserted against `ApplicationConfig` rather than over HTTP because there is nothing to request — "the task that adds the first non-excluded route; assert it over HTTP then." **This is that task, and discharging that comment is part of it.**

Three other absences become live at the same moment, and each is invisible today only because no controller takes a `@Body()`:

- **There is no request validation anywhere.** `ZodValidationPipe`, `APP_PIPE` and `useGlobalPipes` return zero matches across the repository. `nestjs-zod` exports the pipe; nothing imports it.
- **The error envelope is a hand-written TypeScript interface**, not a schema, so it appears in no OpenAPI response and no generated client type. `/health/deep`'s 401 is documented with **no `type`** for exactly this reason, and says so in situ.
- **The only OpenAPI security scheme is named `bearer` and is documented as "Static shared secret, compared in constant time. Not a JWT"** — a collision `apps/api/src/openapi/build-document.ts:15` flags in advance.

**Files:**

- Create: `apps/api/src/modules/users/api/me.controller.ts`, `me.dto.ts`, `apps/api/src/shared/http/validation.pipe.ts`, `apps/api/src/shared/http/error-response.dto.ts`
- Modify: `apps/api/src/app.module.ts`, `apps/api/src/openapi/build-document.ts`, `apps/api/openapi/openapi.json` (regenerated), `apps/api/test/boot.integration.test.ts`, `docs/CONTRACTS_AND_API.md`
- Test: `apps/api/test/me.integration.test.ts`, `apps/api/test/validation-pipe.integration.test.ts`, `apps/api/test/openapi.integration.test.ts` (new rows)

**Interfaces:**

- Consumes: Tasks 2 (`MeResponse`), 5 (`AuthGuard`), 6 (`provisionUser`)
- Produces: `GET /api/v1/me`; `MetrikaValidationPipe` as `APP_PIPE`; `ApiErrorResponseDto`; a second security scheme
- **The memberships read takes `auth: AuthContext` as its first parameter**, per Task 6's rule and ADR-0013 decision 2. It is post-authentication, so unlike the two named exceptions it has one available — and this is the second of the two repositories every later module is copied from, so the counter-pattern is established here or nowhere.

- [ ] **Step 1: Write the failing route test**

`apps/api/test/me.integration.test.ts`, over a real socket through `bootApiForTest()`:

1. `GET /api/v1/me` with a valid token returns 200 with the caller's `userId`, `email`, `displayName`, and **exactly one** membership — their personal organization, with `role: 'OWNER'`, `kind: 'PERSONAL'`.
2. `GET /me` (unprefixed) returns 404 with `{ code: 'ROUTE_NOT_FOUND' }`. This is the HTTP half of the prefix contract that `boot.integration.test.ts` deferred; delete that comment in the same commit.
3. Without a token: 401, `{ code: 'UNAUTHENTICATED' }`, our Spanish message.
4. **A response-validation canary.** Have the handler return an extra field the schema does not declare and assert it is absent from the body. `apps/api/test/health.integration.test.ts:50` is the existing example (a stripped `latencyMs`). ADR-0019's obligation 1 requires that removing **either** `{ codec: true }` from the DTO **or** the `ZodSerializerInterceptor` `APP_INTERCEPTOR` provider fails a test — each is silently useless alone.
5. **A cross-tenant read that must be empty.** Seed a second user in a second organization; assert their organization does not appear in the first caller's memberships. This is 1A's only tenant assertion at the HTTP layer, and it is the one 1B's generated suite generalises.

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Wire request validation, and decide what a 400 looks like**

`nestjs-zod`'s `ZodValidationException extends BadRequestException` with body `{ message: 'Validation failed', errors: issues }`. `DomainExceptionFilter` forwards only `exception.message` — it never reads `getResponse()` — so out of the box **every validation failure is the English string "Validation failed" with no field information**, contradicting `docs/CONTRACTS_AND_API.md`'s "message: localised, safe to display".

Use `createZodValidationPipe({ createValidationException })` and throw a `DomainError` instead. `DomainError`'s third constructor parameter is already `details?: Readonly<Record<string, unknown>>` and `domainErrorResponse()` already emits it, so nothing new is needed on the envelope:

```ts
// Only `path` and `code`. A Zod issue can carry the RECEIVED value, and the
// received value is the request body — which is how a password, a token or a
// customer's project name ends up in a 400 response and in whatever logs it.
// Redaction is field-granular and cannot reach inside a free-form details bag.
const issues = error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code }));
throw new DomainError('VALIDATION_FAILED', 'La solicitud no es válida.', { issues });
```

`apps/api/test/validation-pipe.integration.test.ts` asserts: a malformed body yields 400 `{ code: 'VALIDATION_FAILED' }` with a Spanish message; `details.issues` names the offending path; and **no received value appears anywhere in the response body**. That last assertion is the one that is easy to leave out and is the reason this step exists.

`/me` takes no body, so the pipe has no live subject in 1A. That is intentional — wire it now, before the first route that does, and give it its own fixture through a test-only controller the way `apps/api/test/error-filter.integration.test.ts:19-115` builds `BoomController`.

- [ ] **Step 4: Promote the error envelope to a schema, and add the second security scheme**

`ApiErrorResponse` in Zod, wrapped with `metrikaDto()`, declared with `@ApiResponse` on every status `/me` can answer. `@ZodResponse` documents and enforces exactly one status; every other status the route really answers must be declared beside it or it is absent from the document and the generated client models it as an unmodelled error (`apps/api/test/openapi.integration.test.ts:170-205` asserts this for the probes).

**The Zod `ApiErrorResponse` lives in `apps/api`, not in `packages/contracts`, so `TS_ONLY` does
not enter into it.** `ErrorEnvelope` is already at
`apps/api/src/shared/errors/error-response.ts:8`, `DomainErrorCode` is importable from contracts,
and the envelope is a transport concern that nothing outside this app parses. Putting it in
contracts instead would drag in four more files and a gate this task's Files block does not
name — `src/index.ts`, `src/json-schema.ts`, a test (that package enforces 100%
lines/branches/functions/statements over `src/**`) and a `pnpm contracts:emit` run under the
byte-diff gate — for a schema `apps/workers` has no use for. Decided here rather than left to the
executor, because it is a decision with a contracts-re-emit ripple.

Register the JWT scheme through `addSecurity()`, not `addBearerAuth()` (which hardcodes `bearerFormat: 'JWT'` and would collide with the existing name). Give it a distinct name; `build-document.ts:15` predicted this collision and the fix is a second name, not a redefinition of `bearer` — `/health/deep` still uses the static secret until it is retired.

- [ ] **Step 5: Regenerate the document and prove the gate**

```bash
pnpm build; echo "EXIT=$?"
pnpm --filter @metrika/api openapi:emit; echo "EXIT=$?"
git diff --stat -- apps/api/openapi/openapi.json
```

`/api/v1/me` must appear **with the prefix**: `SwaggerDocumentOptions.ignoreGlobalPrefix` defaults to false, so the scanner reads `getGlobalPrefix(app)` and honours the same exclude list that keeps the three probes unprefixed.

**Do not format `apps/api/openapi/openapi.json`.** It is written by `JSON.stringify(document, null, 2)` and is listed in `.prettierignore:46`; Prettier's `printWidth` would collapse arrays `JSON.stringify` expands and make `format:check` and the byte-diff gate permanently disagree.

`emit-openapi.ts` deliberately never calls `app.init()`, so no lifecycle hook fires and nothing connects — but `ConfigModule`'s factory validates the environment while the graph is built. **Any provider that connects in a constructor rather than in `onModuleInit` breaks the database-free `openapi` CI job**, and Task 5's `CLERK_*` keys must be satisfiable there.

- [ ] **Step 6: Mutations**

1. Remove `{ codec: true }` from `metrikaDto`. Expected: **non-zero**, the canary.
2. Remove the `APP_INTERCEPTOR` provider from `app.module.ts:40`. Expected: **non-zero**, the same canary.
3. Delete the `@ApiResponse` for 401. Expected: **non-zero**, the `openapi` diff gate.
4. Widen the memberships query to drop the tenancy scope. Expected: **non-zero**, the cross-tenant assertion.

- [ ] **Step 7: Verify and commit**

```bash
pnpm verify; echo "EXIT=$?"
pnpm test:integration; echo "EXIT=$?"
git add apps/api docs
git commit -m "feat(api): serve GET /api/v1/me behind the Clerk guard, with request validation and a typed error body"
```

---

### Task 8: `apps/web` — Clerk, sign-in, and the page that proves it — SELF-VERIFIED

`apps/web` is one static route: `src/app/` contains `globals.css`, `layout.tsx` and `page.tsx` and nothing else. There is no `middleware.ts`, no route group, no `src/features/`, and no data fetching anywhere. This task adds the first of each.

**Files:**

- Create: `apps/web/src/middleware.ts` (if ADR-0038 says one is needed), `apps/web/src/app/(app)/layout.tsx`, `apps/web/src/app/sign-in/[[...rest]]/page.tsx`, `apps/web/src/app/sign-up/[[...rest]]/page.tsx`, `apps/web/src/features/auth/index.ts` and its internals
- **Move: `apps/web/src/app/page.tsx` → `apps/web/src/app/(app)/page.tsx`** (Step 0)
- Modify: `apps/web/src/app/layout.tsx`, `apps/web/src/config/env.ts`, `apps/web/src/config/process-env.d.ts`, `apps/web/test/env-inlining.test.ts`, `apps/web/messages/es-CO.json`, `apps/web/messages/en-US.json`, `.env.example`, `apps/web/turbo.json`, `apps/web/package.json`, `apps/web/e2e/shell.spec.ts`
- Test: `apps/web/test/env.test.ts` (new rows), `apps/web/e2e/auth.spec.ts`

**Interfaces:**

- Consumes: Task 1 (`<pin>`s, the middleware answer, the server-side token accessor), Task 7 (`GET /api/v1/me`)
- Produces: an authenticated RSC page rendering the caller's display name and personal organization name

- [ ] **Step 0: Move the existing page, do not create a second one**

```bash
git mv apps/web/src/app/page.tsx apps/web/src/app/\(app\)/page.tsx
```

`apps/web/src/app/page.tsx` **exists today** — it renders `app.name` and `app.tagline` and carries
`id="main"`, the skip-link target `e2e/shell.spec.ts` asserts. A route group adds no path
segment, so `src/app/page.tsx` and `src/app/(app)/page.tsx` both resolve to `/` and `next build`
fails with _"You cannot have two parallel pages that resolve to the same path"_. Creating the
second file is not a step this task can reach `pnpm verify` from.

Keep `id="main"` on the moved file, or the skip-link contract breaks in a way that reads as a
Playwright flake. And **say what `shell.spec.ts` now asserts about `/`**, because the route it
tests is now behind auth: either it asserts the redirect (and the catalogue-driven copy
assertions move to whichever page an unauthenticated visitor actually sees), or the authenticated
area gets a real segment — `/app`, say — and `/` stays the marketing shell it is today. Both are
defensible; leaving it undecided produces a suite that fails for a reason unrelated to this task.

- [ ] **Step 1: Add the publishable key — four coordinated edits, and a fifth**

A `NEXT_PUBLIC_` key is not a naming convention: Next replaces the **literal text** `process.env.NEXT_PUBLIC_<NAME>` at build time. So it needs, in one commit:

1. `ClientEnvSchema` in `apps/web/src/config/env.ts`;
2. a **full-literal** read in the hand-built `clientEnv` object — the bracket form is what Next does not substitute;
3. the whitelist in `apps/web/test/env-inlining.test.ts`, which fails on any other `process.env` occurrence in that module;
4. a declaration in `apps/web/src/config/process-env.d.ts`, because `noPropertyAccessFromIndexSignature` makes the dotted form TS4111 without one;
5. the root `.env.example` (asserted by `apps/web/test/env-example.test.ts`) and `apps/web/turbo.json`'s declared `env` for the build task, because `next build` inlines it.

The **secret** key, if `@clerk/nextjs` needs one server-side, carries **no** `NEXT_PUBLIC_` prefix and belongs in `ServerEnvSchema`. `.env.example`'s own banner says why, at length; do not put a secret behind that prefix.

- [ ] **Step 2: Mount the provider without breaking the shell's two invariants**

`apps/web/src/app/layout.tsx` has two properties `apps/web/e2e/shell.spec.ts` asserts and this task can silently break:

- **The skip link is the first focusable element.** A provider or nested layout that inserts a focusable node above it fails that test. That is the test working, not a test to relax.
- **The layout must keep _consuming_ a `clientEnv` value**, not merely importing the module. Its header at :8-56 records the measurement: with nothing importing it, `turbo run build` with both `NEXT_PUBLIC_` keys unset exited **0** and inlined nothing. A refactor that drops the consumption silently removes the build-time environment guarantee.

- [ ] **Step 3: Fetch `/me` from a Server Component, and fix the request-ID story while doing it**

`currentRequestId()` is **fresh per call on the server** by design (`apps/web/src/lib/request-id/request-id.ts:86-90`) — module scope on Node would stamp two concurrent visitors with one ID. The module's own header names this as the decision for the task that adds a server-side data path. **This is that task.** Introduce a request-scoped store — React's `cache()` is the smallest thing that works — so one RSC render uses one ID.

Every call goes through `apiFetch`, which sets `X-Request-Id` **after** the `...init` spread so a caller cannot clobber it and defaults `redirect` to `'error'`. It takes a root-relative path only and rejects `//host` and `/\host`. A Clerk bearer token and `X-Metrika-Org-Id` are new responsibilities: in 1A they can be passed per call; in 1B they move into `packages/api-client`'s factory. **Do not scatter a second `fetch` through the feature** — `docs/CONTRACTS_AND_API.md:236` claims a lint rule forbids raw `fetch` under `src/features/**`, and a grep of `packages/eslint-config/src/` finds none. 1B writes it; 1A must not create the violation it will have to clean up.

Every relative import under `src/` must be **extensionless** — Turbopack does not apply TypeScript's `.js` → `.ts` rewrite, and `tsc`, ESLint and Vitest all accept the broken form (`apps/web/test/src-import-specifiers.test.ts`).

- [ ] **Step 4: Strings, in both catalogues**

`apps/web/test/messages.test.ts` imposes three constraints on every new screen: the two catalogues must carry **identical key sets**; every key reachable from a `useTranslations('ns')` / `getTranslations('ns')` binding must resolve to a **string** in `es-CO` (a path landing on a nested object is a failure); and any catalogue value ≥12 characters must not also appear verbatim as a literal under `src/`. When one file uses two namespaces, the translator bindings need **distinct names** or every call resolves against both.

The catalogues hold four keys today. Sign-in, sign-up and the `/me` page roughly quadruple that. `en-US` is not served — there is no locale negotiation and no `[locale]` segment; `getRequestConfig` returns `DEFAULT_LOCALE` unconditionally — but the key-set equality test forces the translations to be written anyway.

- [ ] **Step 5: The e2e assertion, at whichever level the credentials allow**

`apps/web/e2e/auth.spec.ts`. With a real development instance: an unauthenticated visit to `/` redirects to the sign-in route, and a signed-in session renders the display name and the personal organization name from `/me`. Without one, take the Prerequisites fallback and assert the redirect only — then say so in the commit message and in Task 9's documentation pass, so nobody later reads a narrowed test as a complete one.

`playwright.config.ts` runs a **production** build (`pnpm build && pnpm start`) and supplies `NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:3001` through `webServer.env` — **and nothing listens there during the suite**. A test that renders `/me` needs a real API, which is a new CI capability rather than a new test. If the API is not stood up in this task, the signed-in assertion belongs to 1C, which owns the full journey.

- [ ] **Step 6: Run every gate, including the one that only fails on a clean install**

```bash
pnpm verify; echo "EXIT=$?"
pnpm --filter @metrika/web test:e2e; echo "EXIT=$?"
```

If any new dependency has a build script, `pnpm install` from scratch exits **1** with `ERR_PNPM_IGNORED_BUILDS` **for the whole repository** — that happened with `@sentry/cli` in Plan 0C and was fixed by an `allowBuilds` entry in `pnpm-workspace.yaml`. Check before committing.

- [ ] **Step 7: Commit**

---

### Task 9: CI, CODEOWNERS, and documentation that matches what exists — **REVIEW**

**Files:**

- Create: `.github/CODEOWNERS`
- Modify: `.github/workflows/ci.yml` (only if Step 2 measures it necessary), `apps/api/vitest.config.ts` (the coverage gate — Step 6), `CLAUDE.md`, `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`, `docs/DOMAIN_MODEL.md`, `docs/LOCAL_DEVELOPMENT.md`, `docs/CONTRACTS_AND_API.md`, `docs/SECURITY.md`, **`docs/OBSERVABILITY.md`**, **`docs/RISK_REGISTER.md`**, `CONTRIBUTING.md`
- Test: the CI change itself, proven by mutation

**Interfaces:**

- Consumes: Tasks 1–8, and every ADR they wrote (0038–0041)
- Produces: `.github/CODEOWNERS`; the `apps/api` coverage gate; a recorded `turbo run --dry=json` measurement saying whether a sixth CI job is needed; documentation whose every claim was checked against the tree

- [ ] **Step 1: Read the workflow before adding to it**

```bash
sed -n '1,45p' .github/workflows/ci.yml
```

The banner is a hard constraint: **do not add an `actions/cache` step for `.turbo` and do not enable a remote cache.** The workflow-level `env:` block (`DATABASE_ADMIN_URL`, `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_DEFAULT_LOCALE`) is deliberately workflow-level so a job added later inherits it; a job needing a different value overrides with its own block.

- [ ] **Step 2: Decide the Clerk variables' scope, and measure whether a new job is needed at all**

```bash
turbo run test:unit --dry=json | head -60
```

Plan 0C Task 6 Step 3 sets the precedent: measure before adding a job, because 0B-3's planned `workers` job turned out to be pure duplication — `verify` already scheduled everything through Turbo. **Record the measurement either way.** The likely answer here is that no sixth job is needed: `verify` and `integration` cover the API, `openapi` covers the document, `web` covers Playwright.

What **is** new is a variable whose real value is a secret. Every value in this file today is a non-secret literal and the two `NEXT_PUBLIC_` keys carry an inline comment saying they never can be secrets. Decide the scope — workflow-level placeholder (if Task 1 made verification offline, which is the design), repository secret plus a job-level `env:`, or step-level — and **record the reason as a comment beside it**, which is the established form in this file.

- [ ] **Step 3: Prove the failure mode of whatever changed**

A CI job whose failure mode has never been observed is a job nobody knows works. Break something only the changed configuration can see, run its exact commands locally, and record **both** exit codes.

- [ ] **Step 4: Write CODEOWNERS**

`.github/` contains only `workflows/` today. R16 (solo-builder bus factor) and `docs/TYPESCRIPT_AND_TOOLING.md:451` both name CODEOWNERS as the stop-and-think control over migrations and — from 1B — `apps/api/src/authorization`. 1A creates the first migration directory, so it creates the file:

```
/packages/database/prisma/migrations/   @<owner>
/packages/database/sql/                 @<owner>
/.github/workflows/                      @<owner>
```

Add `/apps/api/src/authorization/` in 1B, when it exists. Do not list a path that does not exist — a CODEOWNERS entry for a missing path is a rule nobody can violate.

- [ ] **Step 5: Reconcile the documentation, verifying every claim against the tree**

Do **not** trust the existing wording. This repository has repeatedly shipped documents asserting controls that did not exist, and two plans ended with a task correcting a batch of them.

- `CLAUDE.md` — the current-state paragraph, the command list (`db:migrate --create-only` now has a documented use), and the rules block: `apps/web` is no longer "a shell", `apiFetch` now has a caller, and the frontend block's preamble that says nothing in it has code behind it is now half wrong. **And the two Boundaries bullets Task 4 Step 5 hands over**, which state the old rule verbatim: "`@prisma/client` may only be imported from `apps/api/src/infrastructure/persistence/**`" and "`@metrika/database` is restricted exactly like `@prisma/client`". Under ADR-0041 answer (b) both are now wrong in the tree; rewrite them to the glob the config actually carries and cite ADR-0041.
- `docs/ROADMAP.md` — mark 1.1 and 1.2 done and 1.6 **partly** done, naming which clause is deferred to 1D and why; fix the progress paragraph so it agrees with the table rather than contradicting it. Plus three line-level corrections, each of which is a deviation this plan took and would otherwise leave unrecorded:
  - **1.6's wording**, "Prisma extension setting `app.current_org_id` per transaction" — ADR-0041 chose a scoped function over an extension, and ADR-0013 decision 3 says the same thing the roadmap does, so both are corrected with a pointer to the ADR.
  - **The Contracts line (`:282`)**, twice over. `AuthContext` and `PolicyResult` are **not** `packages/contracts` types — they live in `apps/api/src/authorization/` (Task 2 Step 4, recorded in ADR-0039). And `organizationsContract` / `projectsContract` / `usersContract` name ts-rest router objects that ADR-0019 made illegal in that package (`docs/CONTRACTS_AND_API.md:350`: it "can hold neither `initContract().router()` nor `createZodDto()`"); what Phase 1 builds is one Zod module per subject. Correct both halves with a pointer to the ADRs — a later reader tracing Phase 1 completeness must not find five named contracts that were never built and no record of why.
- `docs/DOMAIN_MODEL.md` — `Organization` gains `personalOwnerUserId` **and its `CHECK`**, and loses `billingAddressId` for now; both are deviations from §2.1 and both need a line.
- `docs/CONTRACTS_AND_API.md` — the `/me` row, the two security schemes, and the §3 error table if a code was added. Its §4 claim that "a lint rule forbids raw `fetch` in `apps/web/src/features/**`" is **false today**; either write the rule or mark the claim as target state. Do not leave it asserting a control that does not exist.
- `docs/ARCHITECTURE.md` — §6's tree says `apps/web` has "7 Playwright cases" and "11 Vitest suites"; the real numbers before this task were **8** and **14**. Correct them to what the tree now holds. §10's module tree keeps its `infrastructure/` line only if ADR-0041 took answer (b); under (a) it is the document the ADR argues against and needs the pointer.
- `docs/OBSERVABILITY.md` — **the chain-table row at `:58`**, which reads "`userId` / `organizationId` on the same line | **no** | there is no authentication yet (Phase 1)". Authentication now exists and Task 5 Step 5 binds both names; flip the row to what the fixture proves and name the fixture. Leaving it would have the gap table asserting the absence of a thing that shipped in the same pull request. Add the three new failure classes to §2's gap list or remove them from it, depending on what Task 5 and Task 6 actually landed.
- `docs/RISK_REGISTER.md` — the constant definition of done requires the register **reviewed and updated** (`docs/ROADMAP.md:696`) and Phase 1 declares **R4 and R16** (`:296`). Both have concrete state to record and neither is mentioned anywhere else in this plan. R4's mitigation text names "RLS plus policy plus `AuthContext` repositories" and "automated cross-tenant IDOR suite on every pull request": say which of those are now **built** (the RLS backstop, `AuthContext` on every repository method with two named exceptions) and which remain **target state** (the policy layer and the IDOR suite, both 1B). R16's names CODEOWNERS, which Step 4 creates. Use the same honest present/target-state form this step demands of every other document.
- `docs/SECURITY.md` / `CONTRIBUTING.md` — STRIDE row #12's verification now has a fixture; say where it lives. CONTRIBUTING's "From Phase 1 that includes the cross-tenant IDOR suite, which does not exist yet" stays true — it lands in 1B.

For anything this plan did not build — the authorization layer, the IDOR suite, `packages/api-client`, `packages/ui`, the elevated client, `AuditLog`, `PlatformRoleAssignment` and `AuthContext.platformRoles`, the four Phase 1 events — describe it as target state in the honest form this repository already uses, not in the present tense.

- [ ] **Step 6: The `apps/api` coverage gate — measure first, then set it**

The constant definition of done requires "package coverage targets met". There are **two**
targets and they are independent: `docs/TESTING.md:17` declares **API modules ≥ 70%**, with the
rationale "Integration-tested against a real database", and a separate row declares 100% branch
on `apps/api/src/authorization/policies`. Only the second is deferred to 1B, because policy
functions do not exist yet. The first is owed **here**, by the slice that ships `auth`, `users`
and `shared/http`.

`apps/api/vitest.config.ts` has **no `coverage` block at all** today — `packages/contracts` is
the only package in the repository with one (`vitest.config.ts:11`) — so what ships now is three
new API modules with no enforced target and no measurement.

Two things to settle, in this order:

1. **Measure before choosing a number.** `apps/api` has two Vitest configs and `vitest.config.ts`
   explicitly `exclude`s `test/**/*.integration.test.ts` — and almost everything this slice
   asserts lives in an integration suite, so a coverage number from `test:unit` alone would
   badly understate the tree and turn a correct 70% target into an obstacle. Run both, record
   both, and record whether a merged report is needed. `docs/TESTING.md:17`'s own rationale is
   about integration tests, so the gate belongs where those run.
2. **Add the block, at 70, and treat a shortfall as a finding about the tests.** If the measured
   number is below the target, that is the coverage report doing its job — do not lower the gate
   to whatever was measured, which converts a standard into a ratchet-free record of the present.

- [ ] **Step 7: The clean-clone run**

State in the working checkout is the most common source of a green run that fails in CI. In both previous plans this surfaced something warm checkouts never showed.

```bash
TMP=$(mktemp -d)
git clone . "$TMP/metrika"
cd "$TMP/metrika"
cp "$OLDPWD/.env" .env
pnpm install --frozen-lockfile; echo "INSTALL=$?"
pnpm verify;                    echo "VERIFY=$?"
pnpm test:integration;          echo "INTEGRATION=$?"
pnpm --filter @metrika/web test:e2e; echo "E2E=$?"
pnpm contracts:emit && git diff --exit-code; echo "CONTRACTS=$?"
pnpm --filter @metrika/api openapi:emit && git diff --exit-code -- apps/api/openapi/openapi.json; echo "OPENAPI=$?"
cd - && rm -rf "$TMP"
```

Every exit code **0**. Anything that only works in the original checkout is a defect.

- [ ] **Step 8: Commit, push, open the pull request**

```bash
git rev-parse --abbrev-ref HEAD    # feat/phase-1a-identity-and-tenancy, created in Task 1 Step 0
git add .github apps/api CLAUDE.md docs CONTRIBUTING.md
git commit -m "docs(phase-1a): reconcile the blueprint with identity, tenancy and the first prefixed route"
git push -u origin feat/phase-1a-identity-and-tenancy
gh pr create --fill
gh run watch
```

---

## Definition of done for Plan 1A

- `pnpm verify` passes on a clean clone (`rm -rf node_modules && pnpm install --frozen-lockfile && pnpm verify`), and CI is green across all five jobs.
- A person completes sign-up in a browser and lands on a page rendering their own `displayName` and their personal organization's name, read from `GET /api/v1/me` — **or**, if no Clerk instance exists on this machine, the narrowed assertion from the Prerequisites fallback shipped and the plan says so in writing.
- Signing in twice yields exactly one `User`, one `Organization` and one `OrganizationMember`, and the second attempt is absorbed by a **database unique-constraint violation** rather than an application pre-check — proven by eight concurrent provisioning calls against a real container that **all return the same `userId`**, and by the mutation that replaces the constraint path with a read-then-write check and turns the test red.
- **The second sign-in of an existing identity returns 200 with the same `userId`** — over a socket, through the real guard, after the first has committed. It is the assertion that proves the pre-identity read has a database predicate rather than an assumption, and deleting `User_identity_bootstrap` turns it red.
- A forged, expired, wrong-issuer or unknown-`kid` token is rejected as `UNAUTHENTICATED` in our own envelope with our own Spanish message, in a fixture that needs **no network and no Clerk account**.
- **No role anywhere in the graph is read from a JWT claim**, and the mutation that makes the factory read one turns a test red. The claim is scoped to `organizationRole`, which has a table — `platformRoles` is not on `AuthContext` in 1A, because a hardcoded `[]` would make this clause unfalsifiable for the platform half.
- **`userId` and `organizationId` are on every Pino line and on the server span**, asserted over a real socket rather than by inspection — which is what lets Task 9 flip `docs/OBSERVABILITY.md:58` from "there is no authentication yet (Phase 1)" to a fact. Token rejection, provisioning retry/exhaustion and RLS deny each produce a correlated line, with the cause in `err` and nothing untrusted in `msg`.
- **`apps/api` has an enforced coverage threshold at `docs/TESTING.md:17`'s ≥70%**, with the measured number recorded and the measurement method (unit run, integration run or merged) stated. The 100%-branch policies target is 1B's, with the policies.
- Every table in `schema.prisma` except `HealthCheck` is `ENABLE`d **and** `FORCE`d and carries at least one policy whose `qual` references a declared tenancy function, and whose `with_check` — where the policy's `cmd` admits a write — is non-null and either references one or is the literal `false`. Asserted as `metrika_app` against Testcontainers by a test that **enumerates tables from `pg_class`**, not one that names them, with an exemption list that must be argued rather than left silent, and proven by appending a bare `CREATE TABLE` to the applied migration and watching it go red.
- With no tenant context set, every one of the three new tables returns zero rows, and a cross-organization `INSERT` is rejected by `WITH CHECK` — asserted by a suite containing no `where: { organizationId }` anywhere. With **only** the identity pair set, `User` yields exactly the one row whose external identifier was supplied and no write is possible.
- **Every repository method takes `auth: AuthContext` as its first parameter**, with exactly two exceptions — `findByExternalAuthId` and `provisionIdentity` — both named in ADR-0040 with their reasons, both reachable only through their own named entry point in `tenant-context.ts`, and neither able to grow into a third without an ADR.
- **`docs/RISK_REGISTER.md` records what R4 and R16 now have**, separated into built and target state, in the same honest form as every other document this plan touches.
- `SOFT_DELETABLE_MODELS` is bound to the schema by a test, so a later model carrying `deletedAt` that nobody adds to the set fails the build rather than shipping hard-deletable.
- `GET /api/v1/me` appears in the committed `apps/api/openapi/openapi.json` with the prefix, with every status it can answer declared and a typed error body, and `openapi:emit` produces no diff.
- `pnpm contracts:emit` produces no diff on either the generated pydantic module or `redaction-corpus.json`, and no schema reaches Python that a human did not put in `EMITTED`.
- No `any`, no `@ts-ignore`, no unjustified suppression, no skipped test, and no commit containing AI attribution.
- Documentation states what exists. Anything this plan did not build is described as target state.

## Self-review notes for the executing agent

Nine things this plan leaves to measurement rather than assertion, each naming the mutation or probe that settles it:

0. **The pre-identity read is the thing most likely to be got wrong, and it is got wrong
   silently.** `externalAuthId → User` runs on every request with neither tenancy GUC known,
   `metrika_app` is `NOBYPASSRLS`, and an unset GUC denies every row — so a `User` policy keyed
   only on `app_current_user_id()` and `app_current_org_id()` returns zero rows for every
   returning user, and the product looks like it works, because the first sign-in of every test
   account succeeds. Task 3 ships `User_identity_bootstrap` and a third GUC pair for exactly
   this; Task 4 gives it a dedicated entry point that sets neither tenancy GUC; Task 5's factory
   calls **`runInIdentityScope`, never `runInTenant`** — `runInTenant` takes the `AuthContext`
   the call is constructing, so writing it the other way is circular and `tsc` will say so.
   The fixture that catches a regression is _the second sign-in returns the same `userId`_
   (Task 6 Step 1), and mutation 4 in Task 3 Step 8 proves it can fail.

1. **No Clerk credentials exist on this machine, and Task 1 is what decides whether that matters.** If the spike cannot verify a token offline, every negative auth fixture and every test that boots the app behind the guard becomes unrunnable in `verify` and `integration`. That is a stop-and-report finding, not something to work around by reaching for the network in a test.
2. **The contracts fork is the first thing that can block everything.** `test/json-schema.test.ts:128-132` and the allowlist at :271-297 are not advisory — they will reject `MeResponse` outright. Take one of ADR-0039's three answers before writing a schema, and prove the fork with the mutation that moves `MeResponse` into `EMITTED` and expects a failure.
3. **Task 3's `WITH CHECK` predicates change how rows are created.** A `User` can only be inserted when `app.current_user_id` already equals its `id`. If provisioning relies on Prisma's client-side UUID default instead of an explicitly-passed `id`, every insert fails — and it fails at the database, in a message that will not obviously point here. `newUuidV7()` exists for this.
4. **The `User` policy reads `OrganizationMember`, and a policy that reads an RLS-protected table has that table's policies applied.** There is no cycle as written. **Measure it anyway** — a cycle raises `infinite recursion detected in policy for relation`, and 1C is one policy away from creating one.
5. **Three assertions in this plan can pass while the thing they guard is broken.** The provisioning concurrency test, if it is sequential in disguise (mutation: replace the constraint path with a pre-check). The RLS coverage gate, if the table enumeration returns empty (guard: `toBeGreaterThan(0)` before the loop). The response-validation canary, which passes with either half of the two-part mechanism removed unless both mutations are run. **Run the mutations; do not reason about them.**
6. **`migration-sql.test.ts`'s `DROP POLICY` grep covers the whole concatenated history.** A wrong predicate discovered after this migration is committed is corrected by `ALTER POLICY` or a second named policy — never by dropping and recreating, which turns a unit test red permanently.
7. **Nothing rolls back in the integration harness.** One container per run, `withTenantContext` commits, and Vitest orders files by size rather than declaration. Every suite added here must be order-safe against every other file in the repository: scope by suite-unique organization and user ids, and never assert emptiness over a shared table unless a random id makes the predicate itself the thing being asserted.
8. **A unique violation aborts the transaction, so the recovery branch cannot live where it reads
   as if it belongs.** Every subsequent statement in that `client.$transaction` fails with
   `25P02`; moving the `catch` outside is not a fix either, because the re-read would then run
   under the loser's own minted GUC values and see nothing. Task 6 Step 3 names the two workable
   boundaries and requires one of them be chosen in writing. **The concurrency test cannot see
   this on its own** — `allSettled` plus three counts passes even when seven callers return
   nothing at all, which is why the "same `userId`" assertion was added beside it.
9. **The three ESLint file paths this plan names are the ones that exist**, and the earlier
   draft's were not. `test/eslint.boundaries.config.js` is the **contracts** boundary
   (`export default [...contractsBoundary]`, three lines); the Prisma boundary is
   `test/eslint.prisma.config.js` and `test/fixtures/persistence-probe/eslint.config.js`. There
   is no `test/boundaries.test.ts` — the rows go in `test/rules.test.ts`. And an `ignores` glob
   resolves relative to the consuming config file, so an "accepted" fixture must live **inside
   the probe package** at the shape the glob describes; a flat `test/fixtures/*.ts` file can
   never be inside `src/modules/users/infrastructure/` and would assert nothing at all.

Two decisions this plan deliberately hands to the executor, because both shape every later slice and neither has a defensible default:

- **Where the active organization comes from** — the `X-Metrika-Org-Id` header (what the contract already names), a path segment (bookmarkable; changes every route signature), or a session cookie (creates `apps/web/src/lib/session/` and the repository's first Server Action). Task 5, Step 4.
- **Whether `email` joins `RedactedFieldName`** — measured `false` today, personal data under Ley 1581, and adding it costs a 60-spelling corpus re-emit and makes invitation debugging in 1C materially harder. Task 2, Step 5. Record the answer either way; "nobody thought about it" and "we thought about it and left it out" are indistinguishable from the outside.
