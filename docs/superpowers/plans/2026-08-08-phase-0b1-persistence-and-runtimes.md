# Phase 0B-1 — Persistence and the API Runtime — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unblock `apps/` by making `@metrika/contracts` a consumable built package and adding the missing `nest`/`next`/`web-library` compiler configs, then stand up the first two runtimes it protects: `packages/database` (Prisma, RLS, soft delete, migration harness) and `apps/api` (NestJS on Fastify, Zod-validated env, request context, exception filter, `/health/{live,ready,deep}`, OpenAPI 3.1) — with `packages/testing` providing a real Postgres via Testcontainers so all of it is integration-tested rather than asserted.

**Architecture:** `packages/contracts` stops exporting raw TypeScript and starts emitting `dist/` behind a conditional `exports` map, because `node dist/main.js` cannot import a `.ts` file. `packages/database` becomes the only package that may import `@prisma/client`; it owns the schema, the migrations, the RLS SQL and `createPrismaClient()`. `packages/testing` owns the Testcontainers harness so no test depends on a developer's machine. `apps/api` is a thin composition root: `config/env.ts` is the only `process.env` reader, `infrastructure/persistence` is the only Prisma consumer, and the health module is the first vertical slice through Zod → validation → OpenAPI. Tenant isolation is enforced twice — a `metrika_app` database role that is `NOSUPERUSER NOBYPASSRLS`, and `FORCE ROW LEVEL SECURITY` policies — and both are asserted by fixtures that fail when the control is removed.

**Tech Stack:** pnpm workspaces, Turborepo, TypeScript 6.0.3, NestJS 11 on Fastify 5, Prisma 6, PostgreSQL 16, `nestjs-zod` + `@nestjs/swagger` (ts-rest is out — see Task 12a), Vitest 4, Testcontainers, Docker Compose, Zod 4.

---

## Prerequisites

**A working Docker daemon is required from Task 4 onward.** Tasks 1–3 touch only TypeScript configuration and ESLint and need nothing but Node 24.19.0 and pnpm 11.20.0. Everything after them needs a container runtime:

| Task                          | What needs Docker                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| Task 4                        | `pnpm infra:up` — the compose stack (postgres, redis, minio, mailpit)              |
| Task 5                        | `pnpm db:migrate` / `pnpm db:reset` run against the compose Postgres               |
| Task 6                        | the Testcontainers harness self-test                                               |
| Task 8                        | the row-level-security suite, and the `docker ps` container count in Step 3        |
| Tasks 7, 9b, 10, 11, 12a, 12b | every `pnpm --filter … test:integration` suite — all of them start a real Postgres |
| Task 13                       | the clean-clone run and the `integration` CI job                                   |

Confirm it **before starting Task 4**, not several steps into Task 6:

```bash
docker info --format '{{.ServerVersion}}'; echo "EXIT=$?"
```

Expected: a server version string and `EXIT=0`. **On the authoring machine this now passes — server `29.6.2`** — which is how the Vitest/Testcontainers lifecycle question below stopped being a prediction and became a measurement. The check stays in the plan because the next reader may be on a different host: if the `docker` binary is missing or the daemon is down, install and start **Docker Desktop, OrbStack or Colima** — [`docs/LOCAL_DEVELOPMENT.md §1`](../../LOCAL_DEVELOPMENT.md) requires Docker 24+ — and re-run the check until it exits 0. Task 6 Step 3 turns this same command into a readable `DockerUnavailableError` at test time, but it cannot install anything: without a daemon, an engineer who starts Task 6 gets Testcontainers' own `Could not find a working container runtime strategy` several steps in, which names no cause and no fix.

`pnpm verify` itself never needs Docker — it is `format:check && build && lint && typecheck && test:unit`, and `test:integration` is deliberately a separate CI job for exactly this reason. A machine with no Docker can complete Tasks 1–3 and can run `pnpm verify` at any point; it cannot complete any task from 4 on, and must not report one as done.

---

## Global Constraints

Everything in Plan 0A's Global Constraints still binds. These are the values this plan adds or restates, copied verbatim from the probe results and from the existing repository — **do not re-resolve them from `latest`**.

**Pinned exactly, no caret, verified by probe:**

| Package                                                      | Version   | Why this exact value                                                                                                                                                          |
| ------------------------------------------------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typescript`                                                 | `6.0.3`   | Already pinned. `typescript-eslint@8.66.0` peers `<6.1.0`; npm `latest` is 7.0.2, outside the range, and silently disables all type-aware lint                                |
| `@nestjs/core`, `@nestjs/common`, `@nestjs/platform-fastify` | `11.1.28` | Probe-verified against TS 6.0.3 with the repo's full strict flag set: `tsc` exit 0, real Fastify boot, real DI resolution                                                     |
| `fastify`                                                    | `5.6.1`   | Declared explicitly: pnpm's strict `node_modules` means `apps/api` cannot import `fastify` types through `@nestjs/platform-fastify`                                           |
| `reflect-metadata`                                           | `0.2.2`   | Probe-verified. `@nestjs/core@11.1.28` peers `^0.1.12 \|\| ^0.2.0`                                                                                                            |
| `rxjs`                                                       | `7.8.2`   | Probe-verified. `@nestjs/core@11.1.28` peers `^7.1.0`                                                                                                                         |
| `nestjs-zod`                                                 | `5.5.0`   | Peers `zod: "^3.25.0 \|\| ^4.0.0"` — first-class zod 4. Published 2026-07-25                                                                                                  |
| `@nestjs/swagger`                                            | `11.4.6`  | Probe-verified alongside `nestjs-zod@5.5.0` on NestJS 11 + Fastify                                                                                                            |
| `prisma`, `@prisma/client`                                   | `6.19.3`  | **Not 7.x**, **not 6.19.2** — see the two notes below                                                                                                                         |
| `testcontainers`, `@testcontainers/postgresql`               | `12.1.0`  | Probe-verified with `vitest@4.1.10`, no peer conflicts. A `^10.13.0` range would silently land on 10.28.0 — a whole major behind                                              |
| `concurrently`                                               | `10.0.4`  | Resolved and verified before this plan was written (`npx concurrently --version` → `10.0.4`; `engines.node` is `>=22`, satisfied by 24.19.0). Used only by `apps/api`'s `dev` |
| `zod`                                                        | `4.4.3`   | Already pinned                                                                                                                                                                |
| `vitest`, `@vitest/coverage-v8`                              | `4.1.10`  | Already pinned                                                                                                                                                                |
| `@types/node`                                                | `24.13.3` | Already pinned. **`@types/node` version numbers do not track Node's runtime patch** — there is no `24.19.0` release and there never will be. Only the major must match        |
| Node                                                         | `24.19.0` | `.nvmrc`, enforced by `scripts/check-node-version.mjs`                                                                                                                        |

**Prisma 7 is rejected, deliberately.** `prisma@7.9.1` (npm `latest`) removes the inline `datasource db { url = ... }` that ADR-0005 is written against and fails with `P1012: The datasource property 'url' is no longer supported in schema files`. It requires a `prisma.config.ts` plus a driver-adapter package passed to the `PrismaClient` constructor — undocumented architecture surface this plan does not budget for while the schema is two tables. `prisma@6.19.2` is also rejected: it carries a high-severity transitive advisory (GHSA-38f7-945m-qr2g via `effect`/`@prisma/config`) fixed in 6.19.3. Revisit 7.x when the driver-adapter pattern has a documented answer for the RLS design.

**No tsconfig flag is weakened for Prisma or for Nest.** Probed against real generated Prisma output and a real booting Nest app: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `isolatedModules`, `verbatimModuleSyntax`, `noPropertyAccessFromIndexSignature` and `module`/`moduleResolution: NodeNext` all compile clean. `nest.json` adds exactly two flags and changes nothing else.

**`verbatimModuleSyntax` stays `true` in `nest.json`.** It is _not_ the cause of the NestJS DI footgun. Probed both ways: a plain `import { Service }` preserves the binding and resolves DI whether the flag is on or off; a hand-written `import type { Service }` erases it and breaks DI whether the flag is on or off. Disabling it buys nothing and diverges from the rest of the monorepo.

**Never write `import type` for a class used in NestJS constructor injection.** This is a 100%-reproducible runtime break (`UnknownDependenciesException`, process exits 1) that is invisible to both `tsc` (exit 0, zero diagnostics) and to the repo's configured `@typescript-eslint/consistent-type-imports` (which self-suppresses for class-typed imports in any file containing a decorator, and never flags an _existing_ `import type` as wrong). The only net is an integration test that boots the module tree — every Nest app in this repo must have one.

**Four library call sites were resolved empirically before this plan was written. Use them verbatim; do not re-derive them.**

1. **`@prisma/client` supports plain named ESM imports.** `import { PrismaClient, Prisma } from '@prisma/client'` works at runtime under Prisma 6.19.3 / Node 24.19.0 / TS 6.0.3, under `moduleResolution` `NodeNext` **and** `Bundler`, compiled or under `--experimental-strip-types`. The package is CommonJS (`exports["."]` resolves `import` and `require` to the same `default.js`, whose body is `module.exports = { ...require('.prisma/client/default') }`), but that spread-re-export shape is exactly what Node's built-in `cjs-module-lexer` is built to recognise, so named exports are detected statically. A negative control (`import { ThisExportDoesNotExist }`) does throw `SyntaxError: Named export … not found`, which proves the detection is selective rather than permissive. **No default-import indirection is needed anywhere in this repository.**
2. **`nestjs-zod@5.5.0` needs BOTH halves: `{ codec: true }` on the DTO and a globally registered `ZodSerializerInterceptor`.** The installed declaration is `declare function createZodDto<TSchema extends UnknownSchema, TCodec extends boolean = false>(schema: TSchema, options?: { codec: TCodec }): ZodDto<TSchema, TCodec>`. Verified to type-check and emit a nameable `.d.ts` under TS 6.0.3 with this repo's full strict flag set. Two things that are easy to assume about it are **false**, both checked against the installed package:
   - **`ZodResponse` does not reject a non-codec DTO.** The `.d.ts` declares **four** overloads, two of which take `ZodDto<TSchema, false>` and `[ZodDto<TSchema, false>]`; `class PlainDto extends createZodDto(S) {}` handed to `@ZodResponse({ status: 200, type: PlainDto })` type-checks clean, `tsc` exit 0. What `codec` actually changes is (a) **which side the handler's return type is checked against** — `output<TSchema>` for `ZodDto<T, true>`, `input<TSchema>` for `ZodDto<T, false>`, and `.brand()` is output-only in Zod, so only the codec overload turns a plain unbranded string in a branded-ID response field into a compile error — and (b) **which schema `@ApiResponse` publishes** (per nestjs-zod's own doc comment: the DTO's output version by default, its input version when the DTO is a codec). The `metrikaDto` funnel is therefore a **convention**, not a compiler-enforced one — nothing in TypeScript stops a future bare `createZodDto(schema)` call site. Task 12a Step 4 adds the lint rule that does stop it, with a mutation.
   - **`@ZodResponse` validates nothing on its own.** It applies `HttpCode` + `ZodSerializerDto` (metadata) + `ApiResponse` + `RequirePassthrough`. The runtime validation is performed by `ZodSerializerInterceptor`, which must be registered as `{ provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor }`. Reproduced on this plan's exact shape (`metrikaDto` funnel, `@ZodResponse`, handler returning an out-of-enum value): **without** the provider the response is `200 {"status":"ok","environment":"staging"}`; **with** it, `500`. Task 12a Step 5 registers it in `AppModule`.
3. **Zod 4 removed `.refine`'s function-params form.** `refine(check, params?: string | $ZodCustomParams)` takes an **object**, and `message` is deprecated in favour of `error`. A per-value message therefore needs `.superRefine((value, ctx) => ctx.addIssue({ code: 'custom', path: [...], message }))`, which was verified to compile and to put `['exponent']` in `issues[0].path`.
4. **NestJS 11 + Fastify middleware wildcards: use `forRoutes('{*splat}')`.** Verified against `@nestjs/platform-fastify@11.1.28` and `path-to-regexp@8.4.2`: bare `'*'` does _not_ throw (an undocumented `LegacyRouteConverter` inside the Fastify adapter silently rewrites it to `{*path}` and suppresses the deprecation warning), but relying on that shim is relying on an internal. Unbraced `'*splat'` starts cleanly and **silently never matches the bare root path `/`**. Only `'{*splat}'` matches `/` and every nested path. Separately: inside a wildcard-mounted middleware, Nest's bundled middie clone rewrites `req.url` to be relative to the match (it reads `/` for every request) and restores it afterwards — **read `req.originalUrl` if a middleware needs the real path.**

**Money is `bigint` minor units + currency + explicit exponent.** Unchanged. Task 11 adds the request-boundary check that `exponent` matches `CURRENCY_REGISTRY`, which `Money` itself deliberately does not do ([ADR-0014](../../adr/0014-money-representation.md)).

**`.env` is the only local environment file.** Not `.env.local`. The Prisma CLI loads `.env` natively and `node --env-file=.env` loads it for the API; two files would be two ways to be wrong. `docs/LOCAL_DEVELOPMENT.md` is corrected in Task 13.

**Two database URLs, two roles.** `DATABASE_ADMIN_URL` (owner `metrika`) is what `prisma migrate` and `prisma generate` use — it is what `schema.prisma`'s `env(...)` names. `DATABASE_URL` (`metrika_app`, `NOSUPERUSER NOBYPASSRLS`) is what the running API uses, passed programmatically to `createPrismaClient()`. A superuser ignores every RLS policy including `FORCE`, which makes RLS look enabled while doing nothing — this split is the whole reason RLS is real here.

**`packages/testing` must never depend on `packages/database`, in either `dependencies` or `devDependencies`.** Turbo's `build.dependsOn: ["^build"]` follows every workspace edge, so `database → testing` plus `testing → database` is `database#build → testing#build → database#build` and Turbo aborts the whole run with `Cyclic dependency detected` — the same failure `packages/typescript-config/eslint.config.js` already documents for `typescript-config → eslint-config`. The dependency runs **one way only: `packages/database` (and `apps/api`) depend on `packages/testing`.** That is why `startDatabase()` takes the location of the migrations and the role SQL as an option instead of resolving `@metrika/database` itself, and why `withDatabase()` takes a caller-supplied client factory instead of importing `createPrismaClient`. The Prisma-flavoured `withDatabase(fn)` that `docs/TESTING.md §3` declares lives in `packages/database/test/support.ts`, which is allowed to know about both.

**One Postgres container per Vitest run, owned by `globalSetup`.** The container lifecycle lives in a Vitest `globalSetup`, which runs exactly once per run regardless of `isolate` or `fileParallelism`, and hands both URLs to the workers through `process.env`. `startDatabase()` reads those variables when they are present and only starts its own container when they are not (so `vitest run <one-file>` still works). Task 8 counts the running containers during a real run and expects exactly `1`.

**VERIFIED by measurement (Docker 29.6.2, Vitest 4.1.10, `@testcontainers/postgresql` 12.1.0, macOS/arm64):** the _reason_ given throughout this plan for why `globalSetup` is needed — that `fileParallelism: false` only serialises files and does not merge their module registries, so a module-level `let container` yields one container _per test file_ — **is true.** Three test files, each importing a module with a module-level `let container`, under `fileParallelism: false` with the default `isolate: true` and no `globalSetup`, started **three** Postgres containers. Confirmed three independent ways: three distinct `containerId`s in the harness's own log, three `create` events in `docker events`, and three distinct forked worker PIDs. The files did run one at a time — but each in a _freshly forked process_, which is exactly why the module-level singleton does not carry across them.

Two refinements the measurement added, both already applied throughout this plan:

- **`fileParallelism: false` does not mean "one fork".** It forces `maxWorkers` to 1, so files are serialised; the default `isolate: true` still respawns a fresh fork per file. The only flag combination that reuses a single process across files without `globalSetup` is `fileParallelism: false` **and** `isolate: false` together (measured: 1 container, 1 PID). `isolate: false` alone is worse than useless — with `fileParallelism` left at its default `true` it measured **three** containers running concurrently. Two knobs whose interaction is easy to get wrong is precisely the argument for `globalSetup`, which is correct without depending on either.
- **`poolOptions` was removed in Vitest 4.** `poolOptions: { forks: { singleFork: true } }` is dead code: `tsc --strict` rejects it with `TS2769 … 'poolOptions' does not exist in type 'InlineConfig'`, and since every `vitest.integration.config.ts` in this plan is inside its package's `tsconfig.json` `include`, that is a red `pnpm typecheck` and therefore a red `pnpm verify`. At runtime the CLI only prints `DEPRECATED  test.poolOptions was removed in Vitest 4` and ignores it. It appears in **none** of the three configs below. Do not add it back.

Measured baselines, for CI timeout tuning: a single `postgres:16-alpine` from `.start()` to a successful `SELECT 1` is **~2.5–2.6 s** steady-state (**~7 s** on the first container of a session, which is Docker Desktop and the Ryuk reaper warming up, not the image). Task 8 Step 3 and Task 13 Step 3 record the suite-level numbers.

**`pnpm verify` now includes `build`.** `verify` is `format:check && build && lint && typecheck && test:unit`. `test:integration` is _not_ in `verify` — it needs Docker, and it runs as its own CI job. **Every task ends by running `pnpm verify` from the repository root and confirming exit 0.** Not a subset. Plan 0A shipped a task that reported success having run only part of it, with the formatter red.

**Every task that adds a gate, a test or a security control includes an explicit mutation step**: break the thing deliberately, confirm something goes red, restore. Plan 0A shipped seven tests that passed for the wrong reason and one real hash collision; all were found by mutation, none by reading.

**Commit conventions:** conventional commits scoped by package; **no `Co-Authored-By` or any other AI attribution**; commit every logical unit as you go, never leave the tree dirty.

### Deferred out of this plan, deliberately

| Deferred                                                                                | Why                                                                                                                                  | Lands in |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| `apps/web`, `packages/ui`, `packages/api-client`, Tailwind Prettier plugin              | Consume 0B-1's OpenAPI document and `next.json`; the `orval` codegen leg is the one probe leg that was never actually run            | 0B-2     |
| `apps/workers`, `ruff`/`mypy`, Temporal SDK, `apps/api/src/workflows`, `contracts:emit` | Needs the contracts build and the API runtime from this plan; nothing here depends on it                                             | 0B-3     |
| `temporal` + `temporal-ui` compose services                                             | First used in 0B-3, where their health checks can be verified rather than guessed. `postgres`, `redis`, `minio`, `mailpit` land here | 0B-3     |
| OpenTelemetry, Pino/structlog redaction, cross-runtime correlation (0.11)               | Propagation cannot be proven until all three runtimes exist. Task 10 lands the correlation **ID**; the exporters land later          | 0C       |
| Terraform `shared` (0.14), gitleaks, Dependabot, image digests                          | Independent of all application code                                                                                                  | 0D       |
| Prisma ID-branding client extension                                                     | Needs domain models with branded IDs; `RlsProbe` has none. ADR-0005's other two extensions (RLS, soft delete) land here              | Phase 1  |
| Seed data (`db:seed`)                                                                   | There is nothing worth seeding until Phase 1's organizations exist. `db:reset` lands here, `db:seed` does not                        | Phase 1  |

---

## File Structure

| File                                                        | Responsibility                                                                                                         |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `turbo.json`, `package.json`, `pnpm-workspace.yaml`         | `build` task graph, `db:*`/`infra:*` scripts, `allowBuilds` consent list                                               |
| `scripts/prisma.mjs`                                        | Loads the root `.env` and forwards to the Prisma CLI with an explicit `--schema`                                       |
| `packages/contracts/package.json`                           | Conditional `exports` map → `dist/`; the fix that lets `node dist/main.js` resolve                                     |
| `packages/contracts/test/package-exports.test.ts`           | Proves resolution in a real `node` subprocess, not through Vitest's resolver                                           |
| `packages/contracts/test/ids.test-d.ts`                     | The full 55-pair brand-distinctness matrix                                                                             |
| `packages/typescript-config/web-library.json`               | Browser-safe `lib` — one definition, previously duplicated in two contracts files                                      |
| `packages/typescript-config/nest.json`                      | `web-library`'s sibling for Node + decorators                                                                          |
| `packages/typescript-config/next.json`                      | `react-library` + `noEmit` — the fix for `composite` scattering `.js` into `app/`                                      |
| `packages/eslint-config/src/nest.js`                        | `nest()` profile + `prismaBoundary` + raw-SQL ban                                                                      |
| `infra/docker/docker-compose.yml`                           | postgres, redis, minio, mailpit — stateful dependencies only                                                           |
| `packages/database/prisma/schema.prisma`                    | `HealthCheck` and `RlsProbe`; the conventions every later model inherits                                               |
| `packages/database/prisma/migrations/*/migration.sql`       | Tables + `app_current_org_id()` + `FORCE ROW LEVEL SECURITY` policies                                                  |
| `packages/database/sql/00-app-role.sql`                     | `metrika_app` role. One file, applied by compose **and** by the test harness                                           |
| `packages/database/src/client.ts`                           | `createPrismaClient`, `withOrganizationContext`                                                                        |
| `packages/database/src/extensions/soft-delete.ts`           | `deletedAt: null` injection, `withDeleted()` escape hatch, hard-delete refusal                                         |
| `packages/database/test/support.ts`                         | The Prisma-flavoured `withDatabase(fn)`; the only place the two packages meet                                          |
| `packages/database/test/global-setup.ts`                    | Vitest `globalSetup` that owns the one container for the whole run                                                     |
| `packages/testing/src/images.ts`                            | `POSTGRES_IMAGE` — the single source of truth for the Postgres tag                                                     |
| `packages/testing/src/database.ts`                          | `startDatabase(options)` / `withDatabase(options, fn)` — Testcontainers Postgres, migrated; knows nothing about Prisma |
| `packages/testing/src/global-setup.ts`                      | `createDatabaseGlobalSetup(options)` — starts the container once per Vitest run                                        |
| `apps/api/src/config/env.ts`                                | The only `process.env` reader in the API                                                                               |
| `apps/api/test/support.ts`                                  | `startTestDatabase()` + the shared boot fixture for every API integration suite                                        |
| `apps/api/src/shared/request-context/`                      | `AsyncLocalStorage` correlation ID, `X-Request-Id` in and out                                                          |
| `apps/api/src/shared/errors/`                               | `DomainError`, the exhaustive code → status map, the exception filter                                                  |
| `apps/api/src/infrastructure/persistence/prisma.service.ts` | The only `@metrika/database` importer in the API                                                                       |
| `apps/api/src/modules/health/`                              | `/health/{live,ready,deep}` — the first Zod-DTO vertical slice                                                         |
| `apps/api/openapi/openapi.json`                             | Committed OpenAPI 3.1.1 document, diffed in CI                                                                         |
| `docs/adr/0019-nestjs-zod-contracts.md`                     | Supersedes ADR-0009 with the spike evidence                                                                            |

---

### Task 1: Make `@metrika/contracts` a consumable package

Closes carryover items **1** (blocking) and **4**.

**Files:**

- Modify: `turbo.json`, `package.json` (root), `packages/contracts/package.json`
- Test: `packages/contracts/test/package-exports.test.ts` (create), `packages/contracts/test/ids.test-d.ts` (rewrite)

**Interfaces:**

- Consumes: nothing
- Produces:
  - `@metrika/contracts` resolvable by bare specifier from compiled JavaScript: `exports["."] = { types: "./dist/index.d.ts", default: "./dist/index.js" }`, plus `exports["./package.json"]`
  - `pnpm --filter @metrika/contracts build` → `dist/index.js`, `dist/index.d.ts`, no `dist/test/`
  - Root scripts `pnpm build`, and `pnpm verify` = `format:check && build && lint && typecheck && test:unit`
  - Turbo task graph: `build` ← `^build` + `db:generate`; `typecheck`/`lint` ← `^build` + `db:generate`; `test:unit`/`test:integration` ← `^build` + own `build`

- [ ] **Step 1: Create the branch**

```bash
git switch -c feat/phase-0b1-persistence-and-runtimes
```

- [ ] **Step 2: Write the failing resolution test**

`packages/contracts/test/package-exports.test.ts`:

```ts
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, '..');

/**
 * Resolution is checked in a REAL `node` subprocess, deliberately not through
 * Vitest's resolver. Vite rewrites bare specifiers with its own algorithm, so a
 * broken `exports` map can still "work" under Vitest while `node dist/main.js` —
 * which is exactly how apps/api runs in production — fails at startup.
 *
 * Node self-references a package by its own name when the package declares
 * `exports`. The parent URL for `node -e` is the process cwd, so running with
 * cwd inside packages/contracts makes `import '@metrika/contracts'` go through
 * this package's own exports map.
 */
async function resolveInNode(source: string): Promise<string> {
  const { stdout } = await run('node', ['--input-type=module', '-e', source], {
    cwd: packageRoot,
  });
  return stdout.trim();
}

describe('@metrika/contracts package exports', () => {
  it('emits a runtime entry point', () => {
    expect(existsSync(path.join(packageRoot, 'dist/index.js'))).toBe(true);
  });

  it('emits declarations beside the runtime entry point', () => {
    expect(existsSync(path.join(packageRoot, 'dist/index.d.ts'))).toBe(true);
  });

  it('does not ship tests in dist', () => {
    expect(existsSync(path.join(packageRoot, 'dist/test'))).toBe(false);
  });

  it('is importable by bare specifier from a real node process', async () => {
    const output = await resolveInNode(
      "import { money } from '@metrika/contracts'; console.log(money(1n, 'COP').amountMinor);",
    );
    expect(output).toBe('1');
  });

  it('produces the same canonical digest from the built artefact as from source', async () => {
    // Identical to the literal asserted in hashing.test.ts against src/. If the
    // build step ever changes serialisation, the cache key changes with it.
    const output = await resolveInNode(
      "import { sha256Canonical } from '@metrika/contracts'; console.log(await sha256Canonical({ a: 1 }));",
    );
    expect(output).toBe('015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862');
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm --filter @metrika/contracts test:unit -- package-exports`
Expected: FAIL — `dist/index.js` does not exist (there is no `build` script yet) and the bare-specifier import throws `ERR_MODULE_NOT_FOUND` or resolves to a `.ts` file.

- [ ] **Step 4: Split `typecheck` from `build` and publish `dist`**

Replace the `exports` block and `scripts` block of `packages/contracts/package.json` so the file reads:

```json
{
  "name": "@metrika/contracts",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./package.json": "./package.json"
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -b tsconfig.build.json",
    "typecheck": "tsc -b",
    "lint": "eslint .",
    "test:unit": "vitest run --coverage"
  },
  "dependencies": {
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@metrika/eslint-config": "workspace:*",
    "@metrika/typescript-config": "workspace:*",
    "@vitest/coverage-v8": "4.1.10",
    "eslint": "10.8.0",
    "fast-check": "4.9.0",
    "typescript": "6.0.3",
    "vitest": "4.1.10"
  }
}
```

`typecheck` was `tsc -b && tsc -b tsconfig.build.json`; the emitting half becomes `build` so Turbo can cache and order it independently. `tsconfig.json` (`noEmit`, includes `test/**`) and `tsconfig.build.json` (`src/**` → `dist/`) keep their shape; Task 2 Step 5 rewrites both to extend `web-library.json` and to name their `.tsbuildinfo` files explicitly.

`"./package.json": "./package.json"` is not decoration. An `exports` map is a **closed** allow-list: once `"."` is declared, Node refuses every unlisted subpath with `ERR_PACKAGE_PATH_NOT_EXPORTED`, including `require.resolve('@metrika/contracts/package.json')`. Locating a workspace package's own directory from another package is the normal way test harnesses find fixtures and SQL, so both `@metrika/contracts` and `@metrika/database` (Task 5) declare it.

- [ ] **Step 5: Wire the task graph**

`turbo.json`:

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "db:generate": { "cache": false },
    "build": {
      "dependsOn": ["^build", "db:generate"],
      "outputs": ["dist/**", "tsconfig.build.tsbuildinfo"]
    },
    "typecheck": {
      "dependsOn": ["^build", "db:generate"],
      "outputs": []
    },
    "lint": {
      "dependsOn": ["^build", "db:generate"],
      "outputs": []
    },
    "test:unit": {
      "dependsOn": ["^build", "build"],
      "outputs": ["coverage/**"]
    },
    "test:integration": {
      "dependsOn": ["^build", "build"],
      "cache": false
    },
    "dev": { "cache": false, "persistent": true }
  }
}
```

`test:unit` depends on its **own** `build`, not only `^build`, because Task 1's test asserts against `dist/`. `db:generate` is declared here so Prisma's code generation can be ordered before typecheck in Task 5; packages without that script are skipped by Turbo, not errored.

`build.outputs` names `tsconfig.build.tsbuildinfo` **exactly**, never the glob `*.tsbuildinfo`. Every package in this repo runs two compilers over two projects: `build` is `tsc -b tsconfig.build.json` (state file `tsconfig.build.tsbuildinfo`) and `typecheck` is `tsc -b` over `tsconfig.json` (state file `tsconfig.tsbuildinfo`). Both files sit in the package root. A `*.tsbuildinfo` glob makes `build` snapshot **both**, so a later `build` cache hit restores a possibly stale `tsconfig.tsbuildinfo`, `tsc -b` decides the typecheck project is up to date, and it **skips checking entirely** — a silent false green on the repo's primary type gate. `typecheck` and `lint` declare no outputs at all for the same reason. To make the name a guarantee rather than a coincidence, every `tsconfig.build.json` in this plan sets `"tsBuildInfoFile": "tsconfig.build.tsbuildinfo"` explicitly.

Root `package.json` scripts — add `build`, `test:integration`, and put `build` inside `verify`:

```json
  "scripts": {
    "preinstall": "node scripts/check-node-version.mjs",
    "build": "turbo run build",
    "dev": "turbo run dev",
    "lint": "turbo run lint",
    "lint:fix": "turbo run lint -- --fix",
    "typecheck": "turbo run typecheck",
    "test:unit": "turbo run test:unit",
    "test:integration": "turbo run test:integration",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "verify": "pnpm format:check && pnpm build && pnpm lint && pnpm typecheck && pnpm test:unit",
    "ci": "pnpm verify"
  },
```

- [ ] **Step 6: Run the test and watch it pass**

```bash
pnpm build
pnpm --filter @metrika/contracts test:unit
```

Expected: PASS. `packages/contracts/dist/` contains `index.js`, `index.d.ts`, `brand.js`, `money.js`, … and **no** `test/` subdirectory. Coverage is still 100%.

- [ ] **Step 7: Mutation — prove the resolution test is load-bearing**

Set `packages/contracts/package.json`'s `exports` back to the old value:

```json
  "exports": { ".": "./src/index.ts" },
```

Run: `pnpm --filter @metrika/contracts test:unit -- package-exports`
Expected: **RED.** `is importable by bare specifier from a real node process` fails — Node reports `ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".ts"`. That is precisely the runtime failure carryover item 1 predicts for `node dist/main.js`.

Restore the conditional `exports` map, re-run, confirm green.

- [ ] **Step 8: Replace the ID distinctness ring with the full matrix**

The existing `packages/contracts/test/ids.test-d.ts` asserts a declaration-order ring, so `UserId = brandedUuid('QuoteId')` — a non-adjacent collision — leaves every assertion true. Replace the whole file:

```ts
import { describe, expectTypeOf, it } from 'vitest';
import type {
  MaterialId,
  ModelId,
  ModelVersionId,
  OrderId,
  OrganizationId,
  PrintJobId,
  PrinterProfileVersionId,
  ProjectId,
  QuoteId,
  SliceJobId,
  UserId,
} from '../src/index.js';

/**
 * The complete 55-pair distinctness matrix, in 11 assertions.
 *
 * The previous version of this file asserted a declaration-order ring
 * (UserId≠OrganizationId, OrganizationId≠ProjectId, …). A ring catches an
 * ADJACENT collision only: `export const UserId = brandedUuid('QuoteId')`
 * left every ring assertion true and all 172 tests green at 100% coverage.
 *
 * `AssignableMember<U, T>` distributes over the union `U` and yields `true`
 * if ANY single member is assignable to `T`, `never` otherwise. Asserting the
 * result is `never` therefore fails on one collision anywhere in the matrix,
 * not just on a neighbouring one.
 *
 * These are raw type-level assertions rather than `expectTypeOf`, because a
 * `type X = Expect<...>` is checked by BOTH `pnpm typecheck` (tsconfig.json
 * includes test/**) and `vitest --typecheck`. An `expectTypeOf` call is only
 * checked by the latter.
 */
interface IdMap {
  UserId: UserId;
  OrganizationId: OrganizationId;
  ProjectId: ProjectId;
  ModelId: ModelId;
  ModelVersionId: ModelVersionId;
  QuoteId: QuoteId;
  OrderId: OrderId;
  SliceJobId: SliceJobId;
  PrintJobId: PrintJobId;
  MaterialId: MaterialId;
  PrinterProfileVersionId: PrinterProfileVersionId;
}

type OtherIds<K extends keyof IdMap> = IdMap[Exclude<keyof IdMap, K>];

type AssignableMember<U, T> = U extends unknown ? (U extends T ? true : never) : never;

type Expect<T extends true> = T;

type NoCollision<K extends keyof IdMap> = [AssignableMember<OtherIds<K>, IdMap[K]>] extends [never]
  ? true
  : false;

type _UserIdIsUnique = Expect<NoCollision<'UserId'>>;
type _OrganizationIdIsUnique = Expect<NoCollision<'OrganizationId'>>;
type _ProjectIdIsUnique = Expect<NoCollision<'ProjectId'>>;
type _ModelIdIsUnique = Expect<NoCollision<'ModelId'>>;
type _ModelVersionIdIsUnique = Expect<NoCollision<'ModelVersionId'>>;
type _QuoteIdIsUnique = Expect<NoCollision<'QuoteId'>>;
type _OrderIdIsUnique = Expect<NoCollision<'OrderId'>>;
type _SliceJobIdIsUnique = Expect<NoCollision<'SliceJobId'>>;
type _PrintJobIdIsUnique = Expect<NoCollision<'PrintJobId'>>;
type _MaterialIdIsUnique = Expect<NoCollision<'MaterialId'>>;
type _PrinterProfileVersionIdIsUnique = Expect<NoCollision<'PrinterProfileVersionId'>>;

describe('branded IDs', () => {
  it('lets a ModelId be used wherever a string is expected', () => {
    expectTypeOf<ModelId>().toExtend<string>();
  });

  it('does not let a bare string satisfy ModelId', () => {
    expectTypeOf<string>().not.toExtend<ModelId>();
  });
});
```

- [ ] **Step 9: Mutation — prove the matrix catches a non-adjacent collision**

In `packages/contracts/src/ids.ts` change the first line to a deliberately wrong brand:

```ts
export const UserId = brandedUuid('QuoteId');
```

Run: `pnpm --filter @metrika/contracts typecheck && pnpm --filter @metrika/contracts test:unit`
Expected: **RED, twice.** `tsc` reports `Type 'false' does not satisfy the constraint 'true'` on `_UserIdIsUnique` and on `_QuoteIdIsUnique`. Confirm the _old_ ring would not have caught this by noting that `UserId` and `QuoteId` are not adjacent in declaration order.

Restore `brandedUuid('UserId')`, re-run, confirm green.

- [ ] **Step 10: Verify and commit**

```bash
pnpm verify
```

Expected: exit 0.

Two commits, because they are two logical units:

```bash
git add turbo.json package.json packages/contracts/package.json packages/contracts/test/package-exports.test.ts
git commit -m "feat(contracts): emit dist and expose it through a conditional exports map"
git add packages/contracts/test/ids.test-d.ts
git commit -m "test(contracts): assert the full 55-pair branded-id distinctness matrix"
```

---

### Task 2: `web-library.json`, `nest.json`, `next.json`

Closes carryover items **2** and **3** (both blocking) and **7**.

**Files:**

- Create: `packages/typescript-config/web-library.json`, `nest.json`, `next.json`
- Modify: `packages/typescript-config/package.json`, `packages/typescript-config/tsconfig.json`, `packages/contracts/tsconfig.json`, `packages/contracts/tsconfig.build.json`
- Test: `packages/typescript-config/test/configs.test.ts`, `test/tsconfig.web-fixtures.json`, `test/tsconfig.nest-fixtures.json`, `test/tsconfig.next-fixtures.json`, `test/web-fixtures/*.ts`, `test/nest-fixtures/*.ts`, `test/next-fixtures/*.ts`

**Interfaces:**

- Consumes: Task 1
- Produces:
  - `@metrika/typescript-config/web-library.json` — `base` + `lib: ["ES2023", "WebWorker"]`
  - `@metrika/typescript-config/nest.json` — `node` + `experimentalDecorators` + `emitDecoratorMetadata`
  - `@metrika/typescript-config/next.json` — `react-library` + `noEmit: true` + the `next` language-service plugin

- [ ] **Step 1: Write the failing config tests**

Fixtures first. `packages/typescript-config/test/web-fixtures/dom-global.ts` — must NOT compile:

```ts
export function pageTitle(): string {
  return document.title;
}
```

`packages/typescript-config/test/web-fixtures/worker-global.ts` — must compile:

```ts
export async function digest(input: string): Promise<ArrayBuffer> {
  return globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
}
```

`packages/typescript-config/test/nest-fixtures/injectable.ts` — a decorator of our own, so these fixtures need no NestJS dependency at all. `emitDecoratorMetadata` emits `design:paramtypes` for _any_ decorated class; `reflect-metadata` is only needed to read it at runtime, and nothing here runs:

```ts
export function Injectable(): ClassDecorator {
  return () => undefined;
}
```

`packages/typescript-config/test/nest-fixtures/service.ts`:

```ts
export class WidgetService {
  getWidget(): string {
    return 'probe-widget';
  }
}
```

`packages/typescript-config/test/nest-fixtures/value-import.controller.ts`:

```ts
import { Injectable } from './injectable.js';
import { WidgetService } from './service.js';

@Injectable()
export class ValueImportController {
  constructor(private readonly widgets: WidgetService) {}

  read(): string {
    return this.widgets.getWidget();
  }
}
```

`packages/typescript-config/test/nest-fixtures/type-import.controller.ts` — the footgun, captured as a fixture so it can never be forgotten:

```ts
import { Injectable } from './injectable.js';
import type { WidgetService } from './service.js';

@Injectable()
export class TypeImportController {
  constructor(private readonly widgets: WidgetService) {}

  read(): string {
    return this.widgets.getWidget();
  }
}
```

`packages/typescript-config/test/next-fixtures/page.ts`:

```ts
export function pageTitle(): string {
  return document.title;
}
```

The three fixture tsconfigs. `packages/typescript-config/test/tsconfig.web-fixtures.json`:

```json
{
  "extends": "../web-library.json",
  "compilerOptions": {
    "composite": false,
    "declaration": false,
    "declarationMap": false,
    "incremental": false,
    "noEmit": true
  },
  "include": ["web-fixtures/**/*.ts"]
}
```

`packages/typescript-config/test/tsconfig.nest-fixtures.json` — this one **emits**, because the whole point is to read the emitted metadata:

```json
{
  "extends": "../nest.json",
  "compilerOptions": {
    "composite": false,
    "declaration": false,
    "declarationMap": false,
    "sourceMap": false,
    "incremental": false,
    "outDir": ".tmp-nest-out",
    "rootDir": "nest-fixtures"
  },
  "include": ["nest-fixtures/**/*.ts"]
}
```

`packages/typescript-config/test/tsconfig.next-fixtures.json`:

```json
{
  "extends": "../next.json",
  "compilerOptions": {
    "tsBuildInfoFile": ".tmp-next-fixtures.tsbuildinfo"
  },
  "include": ["next-fixtures/**/*.ts"]
}
```

`packages/typescript-config/test/configs.test.ts`:

```ts
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, '..');
const testDir = import.meta.dirname;

/**
 * `compile()` swallows a non-zero exit and returns whatever tsc printed, which
 * is what lets a single call serve both the "must fail" and the "must succeed"
 * fixtures. The cost is that a NEGATIVE assertion on its output is vacuous: an
 * output of `error TS5058: The specified path does not exist`, or a `pnpm exec`
 * that never found `tsc`, or an `extends` that failed to resolve, all satisfy
 * `expect(output).not.toContain(...)`. Every assertion below therefore pins
 * something POSITIVE about the output first — the diagnostic count, or the
 * exact filename, or emptiness of the whole string.
 */
async function compile(project: string, useBuildMode: boolean): Promise<string> {
  const args = useBuildMode ? ['exec', 'tsc', '-b', project] : ['exec', 'tsc', '-p', project];
  try {
    const { stdout, stderr } = await run('pnpm', args, { cwd: packageRoot });
    return `${stdout}${stderr}`;
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
}

describe('web-library.json', () => {
  it('rejects a DOM global — the package must stay browser-bundle-safe without DOM', async () => {
    const output = await compile('test/tsconfig.web-fixtures.json', false);
    expect(output).toContain('dom-global.ts');
    expect(output).toContain('TS2584');
  });

  it('accepts the WebWorker globals hashing.ts actually uses', async () => {
    const output = await compile('test/tsconfig.web-fixtures.json', false);
    const diagnostics = output.match(/error TS\d+/g) ?? [];

    // Exactly one diagnostic, and it must be the DOM one. A harness failure
    // (TS5058, a missing tsc, an unresolved `extends`) also yields one
    // diagnostic — which is why the filename is asserted too.
    expect(diagnostics).toHaveLength(1);
    expect(output).toContain('dom-global.ts');
    expect(output).toContain('TS2584');
    expect(output).not.toContain('worker-global.ts');
  });
});

describe('nest.json', () => {
  const outDir = path.join(testDir, '.tmp-nest-out');

  beforeAll(async () => {
    rmSync(outDir, { recursive: true, force: true });
    await compile('test/tsconfig.nest-fixtures.json', false);
  });

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it('compiles decorated classes with constructor injection under the full strict flag set', async () => {
    const output = await compile('test/tsconfig.nest-fixtures.json', false);
    expect(output.trim()).toBe('');
  });

  it('emits the constructor parameter type as design:paramtypes for a value import', () => {
    const emitted = readFileSync(path.join(outDir, 'value-import.controller.js'), 'utf8');
    expect(emitted).toContain('design:paramtypes');
    expect(emitted).toContain('WidgetService');
  });

  it('erases the constructor parameter type for an `import type` — the DI footgun, captured', () => {
    const emitted = readFileSync(path.join(outDir, 'type-import.controller.js'), 'utf8');
    expect(emitted).toContain('design:paramtypes');
    // The binding is gone: Nest sees the global `Function` and throws
    // UnknownDependenciesException at boot. tsc reports nothing.
    expect(emitted).not.toContain('WidgetService');
    expect(emitted).toMatch(/design:paramtypes",\s*\[Function\]/);
  });
});

describe('next.json', () => {
  const fixtureDir = path.join(testDir, 'next-fixtures');

  afterAll(() => {
    rmSync(path.join(testDir, '.tmp-next-fixtures.tsbuildinfo'), { force: true });
  });

  it('type-checks a DOM-using module', async () => {
    const output = await compile('test/tsconfig.next-fixtures.json', true);
    // The whole output, not a substring search. An empty string is the only
    // clean result AND the only result that proves tsc actually ran the
    // project; `not.toContain('TS2584')` would pass on TS5058 too.
    expect(output.trim()).toBe('');
  });

  it('emits nothing next to the sources, so `tsc -b` cannot scatter .js into app/', async () => {
    await compile('test/tsconfig.next-fixtures.json', true);
    const emitted = readdirSync(fixtureDir).filter(
      (name) => name.endsWith('.js') || name.endsWith('.d.ts'),
    );
    expect(emitted).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm --filter @metrika/typescript-config test:unit`
Expected: FAIL — `web-library.json`, `nest.json` and `next.json` do not exist, so every `extends` fails to resolve.

- [ ] **Step 3: Write the three configs**

`packages/typescript-config/web-library.json` — the durable home for the browser-safe `lib`, currently duplicated verbatim in `packages/contracts/tsconfig.json` and `tsconfig.build.json`, where a one-sided edit would silently undo the guarantee:

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "./base.json",
  "compilerOptions": {
    "lib": ["ES2023", "WebWorker"]
  }
}
```

`packages/typescript-config/nest.json` — extends `node.json`, not `base.json`, so it inherits `types: ["node"]` (TS 6 defaults `types` to `[]`). Exactly two flags are added and nothing else changes, `verbatimModuleSyntax` included:

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "./node.json",
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

`packages/typescript-config/next.json`:

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "./react-library.json",
  "compilerOptions": {
    "noEmit": true,
    "plugins": [{ "name": "next" }]
  }
}
```

`noEmit: true` is the fix for carryover item 3, and it is a _different_ fix from what that item predicts. Next.js does **not** rewrite a `tsconfig.json` that has an `extends` key — its `writeConfigurationDefaults` returns early on `'extends' in userTsConfig || 'references' in userTsConfig`, verified by diffing the file byte-for-byte across `next build` and `next dev`. The real damage is the reverse: `composite: true` forces declaration emit, `base.json` sets no `outDir`, and so a plain `tsc -b` — which is exactly what `pnpm typecheck` runs — scatters `.js`/`.d.ts` next to every `.tsx` source _and_ produces a `next.config.js` that Next then silently prefers over the edited `next.config.ts`. `noEmit: true` eliminates it; `.tsbuildinfo` is still written, so Turbo's cache keying is unaffected. `composite` stays `true`, matching every other package.

`packages/typescript-config/package.json` — the `files` array is what a consumer can resolve, so a config that is not listed is not shipped:

```json
  "files": [
    "base.json",
    "node.json",
    "web-library.json",
    "react-library.json",
    "next.json",
    "nest.json"
  ],
```

- [ ] **Step 4: Add the new tests to the package's own program**

`packages/typescript-config/tsconfig.json` includes only `test/flags.test.ts`, so a new test file would never be type-checked. Update it:

```json
{
  "extends": "./node.json",
  "compilerOptions": { "noEmit": true },
  // The fixture files under test/{web,nest,next}-fixtures/ are deliberately
  // invalid or deliberately emit-sensitive, and are compiled on demand by the
  // tests through their own tsconfigs. They must stay out of this package-wide
  // program, or a normal typecheck run would fail on input that is supposed to
  // fail.
  "include": ["test/flags.test.ts", "test/configs.test.ts"]
}
```

`packages/typescript-config/eslint.config.js` — extend the ignore list so the fixtures are not linted:

```js
  { ignores: ['test/fixtures/**', 'test/web-fixtures/**', 'test/nest-fixtures/**', 'test/next-fixtures/**', 'test/.tmp-nest-out/**'] },
```

- [ ] **Step 5: De-duplicate the browser-safe `lib`**

`packages/contracts/tsconfig.json` — extend `web-library.json` and delete the local `lib`:

```json
{
  "extends": "@metrika/typescript-config/web-library.json",
  "compilerOptions": {
    // Editor/lint/full-program type-checking only — this is the project
    // ESLint's typeChecked() points `parserOptions.project` at, so it has to
    // include test/** too. It must never emit: the package build comes from
    // tsconfig.build.json (src only).
    "noEmit": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"]
}
```

`packages/contracts/tsconfig.build.json`:

```json
{
  "extends": "@metrika/typescript-config/web-library.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    // Named explicitly so turbo.json's `build.outputs` entry
    // ("tsconfig.build.tsbuildinfo") is a contract rather than a coincidence.
    // The default name is derived from the config filename, which is the same
    // string today — but a rename would silently drop the cached output and,
    // worse, let a `*.tsbuildinfo` glob creep back in.
    "tsBuildInfoFile": "tsconfig.build.tsbuildinfo"
  },
  // src only, deliberately: compiling test/** here would put dist/test/* into
  // the package's build output, and a rootDir wide enough to cover both pushes
  // the entry point to dist/src/index.js instead of dist/index.js.
  "include": ["src/**/*.ts"]
}
```

`WebWorker` now has exactly one definition, and the existing fixtures are unaffected — the resolved `lib` is identical.

**Say plainly what this does not fix.** `lib` is not `types`. `packages/contracts/tsconfig.json` includes `test/**` and `vitest.config.ts`, and vitest/vite's own `.d.ts` files carry `/// <reference types="node" />`, so `@types/node`'s ambient declarations **are** in the editor and lint program today — confirmed by `tsc --listFiles`, which names `@types/node/globals.d.ts` and `buffer.buffer.d.ts`. TS 6 defaulting `types` to `[]` does not close that, because a transitive `reference types` directive is not a `types` entry. Only `tsc -b tsconfig.build.json` (which includes `src/**` alone) rejects a Node global in `src/`, and it does so in CI rather than at the keystroke. **Task 3's `no-restricted-globals` rule is the whole fix for that asymmetry**; the compiler asymmetry itself remains and is accepted.

- [ ] **Step 6: Run the tests and watch them pass**

```bash
pnpm --filter @metrika/typescript-config test:unit
pnpm --filter @metrika/contracts test:unit
```

Expected: PASS for both. The `nest.json` suite proves `design:paramtypes` carries `WidgetService` for a value import and `Function` for a type import; the `next.json` suite proves `readdirSync` finds no emitted files.

- [ ] **Step 7: Mutation — prove the `noEmit` test is load-bearing**

In `packages/typescript-config/test/tsconfig.next-fixtures.json`, add the override that undoes the fix:

```json
  "compilerOptions": {
    "noEmit": false,
    "tsBuildInfoFile": ".tmp-next-fixtures.tsbuildinfo"
  },
```

Run: `pnpm --filter @metrika/typescript-config test:unit -- configs`
Expected: **RED.** `emits nothing next to the sources` fails with `expected [ 'page.d.ts', 'page.js' ] to deeply equal []`. That is the exact pollution that makes an edited `next.config.ts` appear to do nothing.

Remove the override, delete `test/next-fixtures/page.js` and `page.d.ts`, re-run, confirm green.

- [ ] **Step 8: Mutation — prove the decorator-metadata test is load-bearing**

In `packages/typescript-config/nest.json`, set:

```json
    "emitDecoratorMetadata": false
```

Run: `pnpm --filter @metrika/typescript-config test:unit -- configs`
Expected: **RED.** `emits the constructor parameter type as design:paramtypes for a value import` fails — the emitted file contains no `design:paramtypes` at all, which is exactly the state that makes every NestJS provider unresolvable.

Restore `true`, re-run, confirm green.

- [ ] **Step 9: Mutation — prove the `web-library` assertions are not vacuous**

In `packages/typescript-config/web-library.json`, drop the WebWorker lib:

```json
    "lib": ["ES2023"]
```

Run: `pnpm --filter @metrika/typescript-config test:unit -- configs`
Expected: **RED.** `accepts the WebWorker globals hashing.ts actually uses` fails on `expect(diagnostics).toHaveLength(1)` — `worker-global.ts` now produces its own `TS2584: Cannot find name 'crypto'`, so the count is 2 and the output names the file the test says it must not name. Under the old, purely negative assertion this mutation would have gone **green**.

Restore `["ES2023", "WebWorker"]`, re-run, confirm green.

- [ ] **Step 10: Mutation — prove the `next.json` type-check assertion is not vacuous**

In `packages/typescript-config/next.json`, point it at the DOM-free config:

```json
  "extends": "./web-library.json",
```

Run: `pnpm --filter @metrika/typescript-config test:unit -- configs`
Expected: **RED.** `type-checks a DOM-using module` fails with `expected '…error TS2584…' to be ''` — `next-fixtures/page.ts` uses `document`, which `web-library.json` deliberately does not declare. This is the assertion that proves `next.json` really inherits `react-library.json`'s DOM lib rather than merely resolving.

Restore `"./react-library.json"`, re-run, confirm green.

- [ ] **Step 11: Verify and commit**

```bash
pnpm verify
```

Expected: exit 0.

```bash
git add packages/typescript-config packages/contracts/tsconfig.json packages/contracts/tsconfig.build.json
git commit -m "feat(typescript-config): add web-library, nest and next configs with emit fixtures"
```

---

### Task 3: ESLint profiles for Nest, the Prisma boundary, and three gate gaps

Closes carryover items **5**, **6** and **8**.

**Files:**

- Create: `packages/eslint-config/src/nest.js`
- Modify: `packages/eslint-config/src/index.js`, `packages/eslint-config/src/boundaries.js`, `packages/typescript-config/eslint.config.js`
- Test: `packages/eslint-config/test/fixtures/contracts-template-import.ts`, `contracts-node-global.ts`, `prisma-outside-persistence.ts`, `raw-unsafe-query.ts`, `nest-app.module.ts`, `extraneous-class.ts`; `packages/eslint-config/test/eslint.prisma.config.js`, `eslint.nest.config.js`; `packages/eslint-config/test/rules.test.ts` (append); `packages/typescript-config/test/lint-parity.test.ts`

**Interfaces:**

- Consumes: Task 2
- Produces:
  - `nest(options: { tsconfigRootDir: string, project?: string | string[] })` → flat-config array: `typeChecked(options)` plus the one Nest-shaped relaxation
  - `prismaImportBoundary` → flat-config array: `@prisma/client` and `@metrika/database` importable only under `src/infrastructure/persistence/**`
  - `rawSqlBan` → flat-config array: `$queryRawUnsafe`/`$executeRawUnsafe` banned everywhere, persistence included
  - `prismaBoundary = [...prismaImportBoundary, ...rawSqlBan]` — the composition `apps/api` uses; `packages/database` composes `rawSqlBan` alone **by name**, never by array index
  - `contractsBoundary` extended to catch template-literal dynamic imports and Node ambient globals

- [ ] **Step 1: Write the failing fixtures and assertions**

`packages/eslint-config/test/fixtures/contracts-template-import.ts` — carryover 5. The existing selector is narrowed to `[source.type='Literal']`, so backticks slip through:

```ts
export async function load(): Promise<unknown> {
  return import(`node:crypto`);
}
```

`packages/eslint-config/test/fixtures/contracts-node-global.ts` — carryover 6. `packages/contracts/tsconfig.json` includes `test/**` and `vitest.config.ts`, whose vite/vitest `.d.ts` files carry `/// <reference types="node" />` and so pull `@types/node`'s ambients into the same program as `src/**` (confirmed on the live repo with `tsc --listFiles`). Only `tsc -b tsconfig.build.json` rejects them, so a Node global in `src/` looks clean in the editor and in `eslint`, and fails only in CI. **This ESLint rule is the entire fix; the compiler asymmetry is accepted and stays.**

```ts
export function scratchPath(): string {
  return `${__dirname}/${String(Buffer.byteLength('x'))}`;
}
```

`packages/eslint-config/test/fixtures/prisma-outside-persistence.ts`:

```ts
import { PrismaClient } from '@prisma/client';

export function make(): PrismaClient {
  return new PrismaClient();
}
```

`packages/eslint-config/test/fixtures/raw-unsafe-query.ts` — config injection into raw SQL is a real attack surface, and the tagged-template form is the only one that parameterises:

```ts
interface RawClient {
  $queryRawUnsafe(query: string): Promise<unknown>;
}

export async function lookup(client: RawClient, name: string): Promise<unknown> {
  return client.$queryRawUnsafe(`SELECT * FROM "RlsProbe" WHERE label = '${name}'`);
}
```

`packages/eslint-config/test/fixtures/nest-app.module.ts` — must produce **no** findings under `nest()`, because `strictTypeChecked`'s `no-extraneous-class` fires on every NestJS module. The filename ends in `.module.ts` deliberately: `nest()`'s relaxation is scoped to `**/*.module.ts`, and a fixture called `nest-module.ts` would not match that glob, so the test would fail for a reason that has nothing to do with the profile:

```ts
export function Module(_metadata: Record<string, unknown>): ClassDecorator {
  return () => undefined;
}

@Module({ imports: [], providers: [] })
export class AppModule {}
```

Two nested configs. `packages/eslint-config/test/eslint.prisma.config.js`:

```js
import { prismaBoundary } from '../src/index.js';

export default [...prismaBoundary];
```

`packages/eslint-config/test/eslint.nest.config.js`:

```js
import { nest } from '../src/index.js';

export default [
  ...nest({ tsconfigRootDir: import.meta.dirname, project: './tsconfig.json' }),
  { ignores: ['../src/**'] },
];
```

Append to `packages/eslint-config/test/rules.test.ts`:

```ts
describe('contracts boundary — dynamic imports and Node ambients', () => {
  async function lintWithBoundary(file: string): Promise<readonly string[]> {
    const eslint = new ESLint({
      cwd: import.meta.dirname,
      overrideConfigFile: 'eslint.boundaries.config.js',
    });
    const [result] = await eslint.lintFiles([`fixtures/${file}`]);
    return (result?.messages ?? []).map((m) => m.ruleId ?? 'unknown');
  }

  it('forbids a template-literal dynamic import', async () => {
    expect(await lintWithBoundary('contracts-template-import.ts')).toContain('no-restricted-syntax');
  });

  it('forbids Node ambient globals', async () => {
    const rules = await lintWithBoundary('contracts-node-global.ts');
    expect(rules.filter((r) => r === 'no-restricted-globals')).toHaveLength(2);
  });
});

describe('prisma boundary', () => {
  async function lintWithPrismaBoundary(file: string): Promise<readonly string[]> {
    const eslint = new ESLint({
      cwd: import.meta.dirname,
      overrideConfigFile: 'eslint.prisma.config.js',
    });
    const [result] = await eslint.lintFiles([`fixtures/${file}`]);
    return (result?.messages ?? []).map((m) => m.ruleId ?? 'unknown');
  }

  it('forbids importing @prisma/client outside infrastructure/persistence', async () => {
    expect(await lintWithPrismaBoundary('prisma-outside-persistence.ts')).toContain(
      'no-restricted-imports',
    );
  });

  it('forbids $queryRawUnsafe anywhere, persistence included', async () => {
    expect(await lintWithPrismaBoundary('raw-unsafe-query.ts')).toContain('no-restricted-syntax');
  });
});

describe('nest profile', () => {
  async function lintWithNest(file: string): Promise<readonly string[]> {
    const eslint = new ESLint({
      cwd: import.meta.dirname,
      overrideConfigFile: 'eslint.nest.config.js',
    });
    const [result] = await eslint.lintFiles([`fixtures/${file}`]);
    return (result?.messages ?? []).map((m) => m.ruleId ?? 'unknown');
  }

  it('accepts a decorator-only module class', async () => {
    expect(await lintWithNest('nest-app.module.ts')).toEqual([]);
  });

  it('still reports a genuinely pointless class outside a module file', async () => {
    // The companion assertion. Without it, a `nest()` that returned `[]` — or
    // one whose typeChecked() half never resolved a program — would satisfy
    // the test above by finding nothing at all.
    expect(await lintWithNest('extraneous-class.ts')).toContain(
      '@typescript-eslint/no-extraneous-class',
    );
  });
});
```

`packages/eslint-config/test/fixtures/extraneous-class.ts` — the negative control for the profile:

```ts
export class OnlyStatics {
  static readonly VALUE = 1;
}
```

`packages/eslint-config/test/tsconfig.json` must include the new fixtures so the type-aware program covers them — it already globs `fixtures/**/*.ts`; confirm that and do not narrow it.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm --filter @metrika/eslint-config test:unit`
Expected: FAIL — `prismaBoundary` and `nest` are not exported; the two contracts fixtures lint clean.

- [ ] **Step 3: Extend `contractsBoundary`**

In `packages/eslint-config/src/boundaries.js`, replace the single-entry `no-restricted-syntax` array with two entries, and add `no-restricted-globals`:

```js
      // `no-restricted-imports` only inspects static import declarations. A
      // dynamic `import()` needs a syntax rule, and it needs TWO selectors:
      // the literal case, and everything else. The previous single selector
      // was narrowed to `[source.type='Literal']`, so `import(`node:crypto`)`
      // with backticks — a TemplateLiteral, not a Literal — lint clean.
      // `tsc` backstops Node built-ins with TS2307, but not an
      // already-installed, typed package reached through a template literal.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "ImportExpression[source.type='Literal']:not([source.value='zod']):not([source.value=/^\\.{1,2}\\//])",
          message:
            'packages/contracts may import only "zod" and relative modules — see docs/ARCHITECTURE.md §7 (dynamic import())',
        },
        {
          selector: "ImportExpression:not([source.type='Literal'])",
          message:
            'packages/contracts may import only "zod" and relative modules, and a dynamic import() here must use a plain string literal so the boundary can be checked statically — see docs/ARCHITECTURE.md §7',
        },
      ],
      // packages/contracts/tsconfig.json includes test/** and vitest.config.ts,
      // which pull @types/node's ambient declarations into the same program as
      // src/**. Only `tsc -b tsconfig.build.json` rejects a Node global in
      // src/, so the editor and the type-aware lint program both see it as
      // valid and CI is the first thing to complain. Catch it here, where it is
      // reported at the keystroke. Companion to the import rule above: that one
      // blocks `node:*` specifiers, this one blocks the ambients that need no
      // import at all.
      'no-restricted-globals': [
        'error',
        { name: '__dirname', message: 'packages/contracts must not use Node globals — see docs/ARCHITECTURE.md §7' },
        { name: '__filename', message: 'packages/contracts must not use Node globals — see docs/ARCHITECTURE.md §7' },
        { name: 'Buffer', message: 'packages/contracts must not use Node globals — use Uint8Array' },
        { name: 'process', message: 'packages/contracts must not use Node globals — see docs/ARCHITECTURE.md §7' },
        { name: 'require', message: 'packages/contracts is ESM-only — see docs/ARCHITECTURE.md §7' },
        { name: 'module', message: 'packages/contracts is ESM-only — see docs/ARCHITECTURE.md §7' },
        { name: 'global', message: 'packages/contracts must not use Node globals — use globalThis' },
      ],
```

- [ ] **Step 4: Write `prismaBoundary` and `nest()`**

Append to `packages/eslint-config/src/boundaries.js`:

```js
/**
 * ADR-0005: `@prisma/client` may only be imported from
 * apps/api/src/infrastructure/persistence/**. Nothing else in the codebase
 * knows Prisma exists — that is the boundary that keeps the domain from being
 * shaped by the ORM. `@metrika/database` is restricted the same way: it
 * re-exports Prisma types, so letting it through would be the same leak
 * wearing a different name.
 *
 * `ignores` is relative to the consuming package's eslint.config.js, which is
 * why this is scoped for apps/api's layout. A second consumer with a different
 * layout composes its own `ignores` rather than widening this one.
 *
 * Exported as its own named config, NOT as element [0] of a combined array.
 * `packages/database` needs the raw-SQL half without the import half, and a
 * consumer that reached for it with `prismaBoundary.slice(1)` would silently
 * swap the two halves the day these objects are reordered — either forbidding
 * the persistence package from importing Prisma, or dropping the
 * `$queryRawUnsafe` ban from the one package most exposed to it. Neither
 * failure produces an error; both produce a green build with a missing control.
 */
export const prismaImportBoundary = [
  {
    files: ['**/*.ts'],
    ignores: ['src/infrastructure/persistence/**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@prisma/client',
              message:
                'Prisma access goes through apps/api/src/infrastructure/persistence — see ADR-0005',
            },
            {
              name: '@metrika/database',
              message:
                'Prisma access goes through apps/api/src/infrastructure/persistence — see ADR-0005',
            },
          ],
          patterns: [
            {
              group: ['@prisma/client/*', '@metrika/database/*'],
              message:
                'Prisma access goes through apps/api/src/infrastructure/persistence — see ADR-0005',
            },
          ],
        },
      ],
    },
  },
];

/**
 * Not scoped by `ignores`: the raw-unsafe methods are banned inside persistence
 * too. They interpolate their argument straight into SQL, and config injection
 * into a query is a real attack surface here. The tagged template forms
 * ($queryRaw / $executeRaw) parameterise; these do not.
 */
export const rawSqlBan = [
  {
    files: ['**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='$queryRawUnsafe']",
          message: 'Use the tagged-template $queryRaw — $queryRawUnsafe does not parameterise',
        },
        {
          selector: "CallExpression[callee.property.name='$executeRawUnsafe']",
          message: 'Use the tagged-template $executeRaw — $executeRawUnsafe does not parameterise',
        },
      ],
    },
  },
];

/** Both halves, the composition `apps/api` uses. */
export const prismaBoundary = [...prismaImportBoundary, ...rawSqlBan];
```

`packages/eslint-config/src/nest.js`:

```js
import { typeChecked } from './type-checked.js';

/**
 * The type-checked profile plus the one relaxation NestJS structurally
 * requires, and nothing else. In particular `consistent-type-imports` stays
 * ON: it was verified against this exact toolchain to self-suppress for
 * class-typed imports in any file containing a decorator, so `lint:fix` will
 * not introduce the `import type` DI break. It also never flags an EXISTING
 * `import type` on an injected class as wrong — no compiler and no lint rule
 * does. The only net for that defect is an integration test that boots the
 * module tree, which every Nest app in this repo has.
 *
 * @param {{ tsconfigRootDir: string, project?: string | string[] }} options
 * @returns {import('eslint').Linter.Config[]}
 */
export function nest(options) {
  return [
    ...typeChecked(options),
    {
      // A NestJS module is a class whose entire purpose is to carry decorator
      // metadata. `no-extraneous-class` (from strictTypeChecked) fires on every
      // one of them. Scoped to *.module.ts so a genuinely pointless class
      // anywhere else is still an error.
      files: ['**/*.module.ts'],
      rules: { '@typescript-eslint/no-extraneous-class': 'off' },
    },
  ];
}
```

There is exactly **one** relaxation. An earlier draft carried a second block scoped to `*.controller.ts`/`*.service.ts`/`*.filter.ts`/`*.guard.ts` whose comment explained why _unused expressions_ must be allowed for decorator factories — but the rule it actually turned off was `no-extraneous-class` again, so it was a no-op with a misleading justification. Nest's decorators are applied in decorator position, which `@typescript-eslint/no-unused-expressions` does not visit at all, so no such relaxation is needed. Controllers, services, filters and guards all have real members, so `no-extraneous-class` never fires on them either. If a future Nest construct genuinely needs a second relaxation, it gets its own fixture and its own mutation.

`packages/eslint-config/src/index.js`:

```js
export { base } from './base.js';
export { typeChecked } from './type-checked.js';
export { nest } from './nest.js';
export { test } from './test.js';
export {
  contractsBoundary,
  prismaBoundary,
  prismaImportBoundary,
  rawSqlBan,
} from './boundaries.js';
```

- [ ] **Step 5: Close the typescript-config lint parity gap (carryover 8)**

`packages/typescript-config/eslint.config.js` composes ESLint's libraries directly rather than using `typeChecked()`, because depending on `@metrika/eslint-config` would make the two packages a Turbo cycle. That is still right, but it silently dropped `base`'s `no-restricted-properties` on `process.env`, which is a repo-wide invariant. Add it back explicitly, with the reason:

```js
    rules: {
      'no-console': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // Re-declared rather than inherited: this config cannot import
      // @metrika/eslint-config's `base` without creating a package cycle (see
      // the comment above), and `process.env` is a repo-wide invariant, not an
      // eslint-config-package concern. The four type-aware rules `base`
      // carries genuinely cannot come along — they need a type-aware program
      // this config deliberately does not build — and that gap is accepted.
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Read configuration from config/env.ts only',
        },
      ],
    },
```

`packages/typescript-config/test/lint-parity.test.ts` — lints a synthetic path through the package's _real_ config, so the assertion cannot drift from what actually runs:

```ts
import { ESLint } from 'eslint';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve(import.meta.dirname, '..');

describe('typescript-config local eslint config', () => {
  it('forbids process.env, matching the repo-wide invariant in @metrika/eslint-config base', async () => {
    const eslint = new ESLint({ cwd: packageRoot });
    const results = await eslint.lintText('export const level = process.env.LOG_LEVEL;\n', {
      // A path inside the package but not on disk: lintText applies the
      // resolved config regardless, and this path is outside every `ignores`
      // entry, so the rule set under test is the one that really runs.
      filePath: path.join(packageRoot, 'test/parity-probe.ts'),
    });
    const rules = (results[0]?.messages ?? []).map((m) => m.ruleId);
    expect(rules).toContain('no-restricted-properties');
  });
});
```

Add `"test/lint-parity.test.ts"` to `packages/typescript-config/tsconfig.json`'s `include`.

- [ ] **Step 6: Run the tests and watch them pass**

```bash
pnpm --filter @metrika/eslint-config test:unit
pnpm --filter @metrika/typescript-config test:unit
pnpm --filter @metrika/contracts lint
```

Expected: PASS. `contracts` still lints clean — it imports only `zod` and uses no Node globals.

- [ ] **Step 7: Mutation — prove each new gate fires for the right reason**

Six separate mutations, each restored before the next. Every gate this task adds has one; none is skipped because it "obviously works".

1. In `packages/eslint-config/src/boundaries.js`, delete the second `no-restricted-syntax` selector (`ImportExpression:not([source.type='Literal'])`).
   Run: `pnpm --filter @metrika/eslint-config test:unit -- boundary`
   Expected: **RED** — `forbids a template-literal dynamic import`. Restore.

2. In the same file, delete the `Buffer` entry from `no-restricted-globals`.
   Run: same command.
   Expected: **RED** — `forbids Node ambient globals` reports 1 finding, not 2. (Asserting the _count_ is what makes this catch a single missing entry; asserting only `toContain` would still pass with `__dirname` alone.) Restore.

3. In `rawSqlBan`, delete the `$queryRawUnsafe` selector.
   Run: `pnpm --filter @metrika/eslint-config test:unit -- prisma`
   Expected: **RED** — `forbids $queryRawUnsafe anywhere, persistence included`. Restore.

4. In `prismaImportBoundary`, delete the `{ name: '@prisma/client', … }` entry from `paths` (leave `@metrika/database` and the `patterns` group).
   Run: `pnpm --filter @metrika/eslint-config test:unit -- prisma`
   Expected: **RED** — `forbids importing @prisma/client outside infrastructure/persistence` reports no `no-restricted-imports` finding. Note that the `patterns` group does **not** cover the bare specifier `@prisma/client` (it matches `@prisma/client/*` only), which is precisely why the `paths` entry has to exist.
   Restore.

5. In `packages/eslint-config/src/nest.js`, delete the whole `*.module.ts` relaxation block so `nest()` is `[...typeChecked(options)]`.
   Run: `pnpm --filter @metrika/eslint-config test:unit -- nest`
   Expected: **RED** — `accepts a decorator-only module class` reports `@typescript-eslint/no-extraneous-class`. This is the honest mutation for a _relaxation_: it proves both that the profile is applied at all (a `nest()` returning `[]` would find nothing and the test would pass) and that the relaxation is load-bearing. `still reports a genuinely pointless class outside a module file` must stay **green** throughout — if it goes red too, the fixture program is not resolving and neither assertion means anything.
   Restore.

6. In `packages/typescript-config/eslint.config.js`, delete the re-declared `no-restricted-properties` rule.
   Run: `pnpm --filter @metrika/typescript-config test:unit -- lint-parity`
   Expected: **RED** — `forbids process.env, matching the repo-wide invariant` finds no `no-restricted-properties`. Restore.

Finally, confirm the fixture harness itself is honest: introduce a syntax error into `fixtures/prisma-outside-persistence.ts` (delete the closing brace) and re-run. Expected: the test fails on a **parse error** message rather than passing — Plan 0A shipped a lint fixture that would have "passed" on a parse error. Restore the brace.

- [ ] **Step 8: Verify and commit**

```bash
pnpm verify
```

Expected: exit 0.

```bash
git add packages/eslint-config packages/typescript-config
git commit -m "feat(eslint-config): add nest profile, prisma boundary and dynamic-import hardening"
```

---

### Task 4: Local infrastructure — `docker compose`, `.env.example`, the `metrika_app` role

ROADMAP 0.10, partially: `postgres`, `redis`, `minio`, `mailpit`. `temporal` and `temporal-ui` land in 0B-3 where they are first used and their health checks can be verified rather than guessed.

**Files:**

- Create: `infra/docker/docker-compose.yml`, `infra/docker/IMAGE_PINS.md`, `packages/database/sql/00-app-role.sql`, `.env.example`
- Modify: `package.json` (root), `.gitignore`, `.prettierignore`

**Interfaces:**

- Consumes: nothing
- Produces:
  - `pnpm infra:up` → all four services healthy, exit 0 (`--wait` fails the command if any health check does not pass)
  - `pnpm infra:down`, `pnpm infra:reset` (drops volumes)
  - A `metrika_app` login role that is `NOSUPERUSER NOBYPASSRLS`, with default privileges pre-granted so tables created later by `metrika` are reachable
  - `.env.example` — every key the API's Zod schema requires, with working local values

- [ ] **Step 1: Write the database bootstrap SQL**

`packages/database/sql/00-app-role.sql`. It lives in `packages/database` rather than `infra/docker` because it is applied from two places and must never drift:

```sql
-- Local and TEST bootstrap only. Production roles are created by Terraform
-- (Plan 0D) with a password from Secrets Manager; this file is never applied
-- there, which is why a fixed development password here is acceptable.
--
-- Executed from two places, deliberately, so local and CI cannot diverge:
--   * docker-entrypoint-initdb.d, mounted by infra/docker/docker-compose.yml
--   * packages/testing's withDatabase(), against the Testcontainers instance
--
-- The application role MUST NOT be a superuser and MUST NOT have BYPASSRLS.
-- A superuser ignores every row-level security policy, FORCE included, which
-- makes RLS look enabled while doing nothing at all. This is the single most
-- likely way for the tenant-isolation backstop to be silently absent, so
-- packages/database/test/rls.integration.test.ts asserts both attributes are
-- false rather than trusting this file.
--
-- ALTER DEFAULT PRIVILEGES with no FOR ROLE clause applies to objects created
-- by the CURRENT role. `prisma migrate` connects as the owner (metrika), which
-- is the same role that runs this file, so every table a future migration
-- creates is granted automatically. That is what removes the ordering problem:
-- this file runs at container init, long before any table exists.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metrika_app') THEN
    CREATE ROLE metrika_app
      LOGIN PASSWORD 'metrika_app'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO metrika_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO metrika_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO metrika_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO metrika_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO metrika_app;
```

- [ ] **Step 2: Write the compose file**

`infra/docker/docker-compose.yml`. Application code runs on the host; compose provides stateful dependencies only.

The `postgres` image tag appears in exactly two files — here and `packages/testing/src/images.ts` (Task 6) — because YAML cannot import TypeScript. That is the same "executed from two places" hazard `00-app-role.sql` was written to avoid, so it gets the same treatment: Task 6 adds `packages/database/test/postgres-image.test.ts`, a unit test that parses this file and asserts its `postgres` image equals the `POSTGRES_IMAGE` constant. A local stack and a Testcontainers run on different Postgres majors is the kind of divergence that produces a green CI and a broken laptop.

```yaml
name: metrika

services:
  postgres:
    # KEEP IN SYNC with POSTGRES_IMAGE in packages/testing/src/images.ts.
    # packages/database/test/postgres-image.test.ts fails if these diverge.
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: metrika
      POSTGRES_PASSWORD: metrika
      POSTGRES_DB: metrika_dev
    ports:
      - '5432:5432'
    volumes:
      - postgres-data:/var/lib/postgresql/data
      # One source of truth for the metrika_app role: the same file
      # packages/testing applies to the Testcontainers instance. Files in this
      # directory run once, at first initialisation of an empty data volume —
      # `pnpm infra:reset` is what re-runs them.
      - ../../packages/database/sql:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U metrika -d metrika_dev']
      interval: 2s
      timeout: 3s
      retries: 30

  redis:
    image: redis:7-alpine
    command: ['redis-server', '--save', '', '--appendonly', 'no']
    ports:
      - '6379:6379'
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 2s
      timeout: 3s
      retries: 30

  minio:
    image: minio/minio:latest
    command: ['server', '/data', '--console-address', ':9001']
    environment:
      MINIO_ROOT_USER: metrika
      MINIO_ROOT_PASSWORD: metrika-local
    ports:
      - '9000:9000'
      - '9001:9001'
    volumes:
      - minio-data:/data
    healthcheck:
      test: ['CMD', 'mc', 'ready', 'local']
      interval: 3s
      timeout: 5s
      retries: 30

  mailpit:
    image: axllent/mailpit:latest
    ports:
      - '1025:1025'
      - '8025:8025'
    healthcheck:
      test: ['CMD', '/mailpit', 'readyz']
      interval: 3s
      timeout: 5s
      retries: 30

volumes:
  postgres-data:
  minio-data:
```

- [ ] **Step 3: Add the root scripts**

Root `package.json`, alongside the existing scripts:

```json
    "infra:up": "docker compose -f infra/docker/docker-compose.yml up -d --wait",
    "infra:down": "docker compose -f infra/docker/docker-compose.yml down",
    "infra:reset": "docker compose -f infra/docker/docker-compose.yml down -v",
```

`--wait` is load-bearing: without it `up -d` exits 0 the moment containers are _created_, and the next command races an unready Postgres. With it, a failed health check fails the script.

`docs/LOCAL_DEVELOPMENT.md` says `docker compose up -d`; the file lives under `infra/docker/` per ROADMAP 0.10, so the scripts are the interface. The document is corrected in Task 13.

- [ ] **Step 4: Start it and convert the two `:latest` tags into exact pins**

```bash
pnpm infra:up
```

Expected: exit 0, four services reported healthy. If Docker is not running the command fails immediately with `Cannot connect to the Docker daemon` — install Docker Desktop, OrbStack or Colima and retry. Nothing else in this plan works without it.

Then read the versions Docker actually resolved and write them back into the compose file so nobody's `pnpm infra:up` differs from CI's:

```bash
docker compose -f infra/docker/docker-compose.yml images
```

Replace `minio/minio:latest` with the exact `RELEASE.*` tag printed for the `minio` row, and `axllent/mailpit:latest` with the exact `vX.Y.Z` tag printed for the `mailpit` row. Record all four resolved image IDs in `infra/docker/IMAGE_PINS.md`:

```markdown
# Local image pins

`pnpm infra:up` must resolve the same bytes on every machine. These are the
images resolved when `infra/docker/docker-compose.yml` was last updated, captured
with `docker compose -f infra/docker/docker-compose.yml images`.

Digest pinning (`image: repo:tag@sha256:…`) applies to the **production** images
built in Plan 0D. Local dependencies are pinned by exact tag: a digest here would
have to be re-resolved per architecture, and these containers hold no production
data.

Two of these tags are **floating**, and this file does not change that.
`postgres:16-alpine` and `redis:7-alpine` track the newest patch of their
respective majors, so a fresh `docker pull` on a new machine can resolve
different bytes from the Image IDs recorded below. What tag pinning does buy is
that the *major* cannot move under us, and the Image ID column below records
what a given machine actually resolved so a "works on mine" report can be
compared rather than argued about. Byte-identical local stacks would require
digests and a per-architecture refresh policy; that is deliberately out of scope
until Plan 0D, which does exactly that for the images that carry production
data.

`postgres`'s tag additionally has a second consumer — `POSTGRES_IMAGE` in
`packages/testing/src/images.ts` — and a test that fails when the two diverge.

| Service  | Image | Tag | Image ID |
| -------- | ----- | --- | -------- |
| postgres | postgres | 16-alpine | |
| redis    | redis    | 7-alpine  | |
| minio    | minio/minio | | |
| mailpit  | axllent/mailpit | | |
```

Copy the `TAG` and `IMAGE ID` columns of the `docker compose … images` output above into the empty cells, one row per service. Four rows, no blanks left.

Re-run `pnpm infra:up` after editing the tags and confirm it still exits 0.

- [ ] **Step 5: Prove the role bootstrap actually ran, and that it is not a superuser**

```bash
docker compose -f infra/docker/docker-compose.yml exec -T postgres \
  psql -U metrika -d metrika_dev -c \
  "SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'metrika_app';"
```

Expected, exactly one row:

```
  rolname   | rolsuper | rolbypassrls | rolcanlogin
------------+----------+--------------+-------------
 metrika_app| f        | f            | t
```

If the row is missing, the volume predates the SQL file: `pnpm infra:reset && pnpm infra:up`.

- [ ] **Step 6: Write `.env.example`**

`.env.example` (committed; `.env` stays gitignored):

```bash
# Local development. Copy this file to `.env`:  cp .env.example .env
#
# `.env` is the ONLY local environment file. The Prisma CLI loads it natively
# and `node --env-file=.env` loads it for the API; a second `.env.local` would
# be a second way to be wrong. CI asserts this file is a superset of what
# apps/api's Zod schema requires (apps/api/test/env-example.test.ts), so a
# fresh clone can never fail with an unexplained missing-variable error.

NODE_ENV=development

# --- API ---
API_PORT=3001
LOG_LEVEL=debug
# Guards /health/deep, which reports per-dependency latency. Replaced by the
# Clerk guard in Phase 1; until then a shared secret is the control, and
# apps/api/test/health.integration.test.ts asserts the 401.
HEALTH_DEEP_TOKEN=local-health-deep-token

# --- Database ---
# Two URLs, two roles, deliberately. The API connects as metrika_app, which is
# NOSUPERUSER NOBYPASSRLS so row-level security actually applies to it.
# Migrations connect as the owner; schema.prisma names DATABASE_ADMIN_URL.
DATABASE_URL=postgresql://metrika_app:metrika_app@localhost:5432/metrika_dev?schema=public
DATABASE_ADMIN_URL=postgresql://metrika:metrika@localhost:5432/metrika_dev?schema=public

# --- Dependencies present in docker compose, wired up in later plans ---
REDIS_URL=redis://localhost:6379
S3_ENDPOINT=http://localhost:9000
S3_BUCKET=metrika-local
S3_ACCESS_KEY_ID=metrika
S3_SECRET_ACCESS_KEY=metrika-local
S3_FORCE_PATH_STYLE=true
SMTP_URL=smtp://localhost:1025
```

Confirm `.gitignore` already contains `.env` (it does) and add `.env.example` to `.prettierignore` — Prettier does not format `.env` files, but the extension-less-ish name has tripped globs before:

```
.env.example
```

- [ ] **Step 7: Mutation — prove `--wait` is doing something**

Break the Postgres health check in `infra/docker/docker-compose.yml`:

```yaml
      test: ['CMD-SHELL', 'exit 1']
```

Run: `pnpm infra:reset && pnpm infra:up`
Expected: **the command hangs for the retry budget and then exits non-zero** with `container metrika-postgres-1 is unhealthy`. Without `--wait` it would have exited 0 immediately. Restore `pg_isready`, `pnpm infra:reset && pnpm infra:up`, confirm exit 0.

- [ ] **Step 8: Verify and commit**

```bash
pnpm verify
```

Expected: exit 0.

```bash
git add infra .env.example .prettierignore package.json packages/database/sql
git commit -m "feat(infra): add local docker compose stack and the non-superuser app role"
```

---

### Task 5: `packages/database` — schema, migrations, RLS SQL

ROADMAP 0.6, first half.

**Files:**

- Create: `scripts/prisma.mjs`, `packages/database/package.json`, `tsconfig.json`, `tsconfig.build.json`, `eslint.config.js`, `vitest.config.ts`, `prisma/schema.prisma`, `prisma/migrations/<timestamp>_init/migration.sql`, `src/index.ts`
- Modify: `pnpm-workspace.yaml`, `package.json` (root)
- Test: `packages/database/test/migration-sql.test.ts`

**Interfaces:**

- Consumes: Tasks 1, 2, 3, 4
- Produces:
  - `@metrika/database` workspace package, ESM, `exports["."] = { types: "./dist/index.d.ts", default: "./dist/index.js" }` plus `exports["./package.json"]`
  - Prisma models `HealthCheck` and `RlsProbe`
  - SQL function `app_current_org_id() RETURNS uuid`
  - `RlsProbe` with `ENABLE` + **`FORCE`** row-level security and a `USING`/`WITH CHECK` tenant policy
  - `scripts/prisma.mjs` — the single entry point to the Prisma CLI, which loads the root `.env` and passes `--schema` explicitly
  - **Root** scripts `db:generate`, `db:migrate`, `db:deploy`, `db:reset`, `db:studio`, all routed through it

`vitest.integration.config.ts` is deliberately **not** created here: it needs the `globalSetup` file from Task 6, and there are no integration tests until Task 7. `vitest.config.ts` is created here because this task lands a real unit test.

- [ ] **Step 1: Give pnpm consent to run Prisma's install scripts**

pnpm 11 refuses to run a dependency's postinstall unless it is on the consent list, and reports `ERR_PNPM_IGNORED_BUILDS` with **exit code 1** — which fails CI on the very first install after Prisma is added. Create the list now, before installing.

`pnpm-workspace.yaml`:

```yaml
packages:
  - 'apps/*'
  - 'packages/*'

# pnpm 11 gates dependency build scripts behind explicit consent. Without these
# entries a from-scratch `pnpm install` exits 1 with ERR_PNPM_IGNORED_BUILDS,
# which fails `pnpm verify` and CI. (On pnpm 10 the key is
# `onlyBuiltDependencies`; 11.20.0 reads `allowBuilds`.)
allowBuilds:
  prisma: true
  '@prisma/client': true
  '@prisma/engines': true
```

**Do not try to verify this here.** A `rm -rf node_modules && pnpm install` at this point installs a workspace that contains no Prisma dependency at all, so `ERR_PNPM_IGNORED_BUILDS` cannot occur and `EXIT=0` would prove nothing about the list. The list is verified in **Step 4**, immediately after `prisma` and `@prisma/client` are actually on disk — and again in Task 6 Step 6 and Task 9a Step 5, each time a package with install scripts is added.

- [ ] **Step 2: Give the Prisma CLI a way to find `DATABASE_ADMIN_URL`**

**Do this before writing any script that calls Prisma.** The Prisma CLI's own dotenv search covers `<schemaDir>/.env`, `<schemaDir>/../.env` and `<cwd>/.env`. With the schema at `packages/database/prisma/schema.prisma`, that is `packages/database/prisma/.env`, `packages/database/.env` and whatever directory the command was launched from — **never the repository root**, which is where this project's single `.env` lives. Run `prisma migrate dev` from `packages/database` and it fails with `error: Environment variable not found: DATABASE_ADMIN_URL`, every time, on a correctly configured machine.

A second `.env` inside `packages/database` would fix it and would also be exactly the "two files, two ways to be wrong" the Global Constraints forbid. Instead, one launcher loads the root file and forwards everything:

`scripts/prisma.mjs`:

```js
#!/usr/bin/env node
// The ONLY entry point to the Prisma CLI in this repository.
//
// Two problems it solves, both of which produce confusing failures otherwise:
//
// 1. Prisma's dotenv search never reaches the repository root (it looks beside
//    the schema and in the cwd), and the root `.env` is the only environment
//    file this project has. Node's `--env-file-if-exists` in the shebang line
//    of the npm script loads it into process.env before this file runs, and
//    real environment variables always win over dotenv — so CI, which sets
//    DATABASE_ADMIN_URL directly and has no `.env` at all, behaves identically.
// 2. `--schema` is passed explicitly, so the command works from any cwd and
//    `pnpm db:migrate` at the root means the same thing as it does anywhere
//    else.
// 3. The child runs with cwd = packages/database, NOT the repo root. `prisma`
//    is a devDependency of @metrika/database only, and pnpm does not link a
//    workspace package's bins into the root `node_modules/.bin` — running
//    `pnpm exec prisma` from the root fails with
//    `[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command "prisma" not found`.
//    Verified on pnpm 11.20.0. The root `.env` is already loaded into
//    process.env by `--env-file-if-exists` before this file runs, and the
//    child inherits it, so moving the cwd costs nothing.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const databasePackage = path.join(repoRoot, 'packages/database');
const schema = path.join(databasePackage, 'prisma/schema.prisma');

const result = spawnSync(
  'pnpm',
  ['exec', 'prisma', ...process.argv.slice(2), '--schema', schema],
  { cwd: databasePackage, stdio: 'inherit' },
);

process.exit(result.status ?? 1);
```

Root `package.json`, alongside the existing scripts:

```json
    "db:generate": "node --env-file-if-exists=.env scripts/prisma.mjs generate",
    "db:migrate": "node --env-file-if-exists=.env scripts/prisma.mjs migrate dev",
    "db:deploy": "node --env-file-if-exists=.env scripts/prisma.mjs migrate deploy",
    "db:reset": "node --env-file-if-exists=.env scripts/prisma.mjs migrate reset --force",
    "db:studio": "node --env-file-if-exists=.env scripts/prisma.mjs studio",
```

`--env-file-if-exists`, not `--env-file`: `node --env-file=.env` **exits non-zero when the file is missing**, and CI has no `.env`. With `-if-exists` the same script works on a laptop (values from `.env`) and in CI (values from the job's `env:` block).

Every Prisma CLI invocation in this plan goes through these five scripts, from the repository root. There is no `cd packages/database && pnpm exec prisma …` anywhere. The one exception is `packages/testing`'s harness, which passes `DATABASE_ADMIN_URL` explicitly in the child process environment because the URL it needs is a container port that does not exist until runtime.

Confirm the root `.env` is reaching the script before continuing. This checks only the environment plumbing — the schema does not exist yet, and does not need to:

```bash
cp .env.example .env   # if not already done in Task 4
node -e "console.log(process.env.DATABASE_ADMIN_URL ?? 'UNSET')" --env-file-if-exists=.env
```

Expected: the `postgresql://metrika:metrika@localhost:5432/metrika_dev?schema=public` URL, not `UNSET`.

- [ ] **Step 3: Scaffold the package**

`packages/database/package.json`:

```json
{
  "name": "@metrika/database",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./package.json": "./package.json"
  },
  "files": ["dist", "prisma", "sql"],
  "scripts": {
    "db:generate": "node --env-file-if-exists=../../.env ../../scripts/prisma.mjs generate",
    "build": "pnpm db:generate && tsc -b tsconfig.build.json",
    "typecheck": "tsc -b",
    "lint": "eslint .",
    "test:unit": "vitest run --config vitest.config.ts"
  },
  "dependencies": {
    "@metrika/contracts": "workspace:*",
    "@prisma/client": "6.19.3"
  },
  "devDependencies": {
    "@metrika/eslint-config": "workspace:*",
    "@metrika/typescript-config": "workspace:*",
    "eslint": "10.8.0",
    "prisma": "6.19.3",
    "typescript": "6.0.3",
    "vitest": "4.1.10"
  }
}
```

`@prisma/client` is a **dependency**, not a devDependency: `dist/index.d.ts` re-exports Prisma types, and TypeScript resolves those from `packages/database/node_modules`. Under pnpm's strict layout a devDependency would not be there for a consumer's `tsc`.

Only `db:generate` is kept as a package script, because Turbo's `build.dependsOn` names it and it has to be runnable per package. The other four (`db:migrate`, `db:deploy`, `db:reset`, `db:studio`) live **only** at the root: they are developer commands, not build steps, and duplicating them here would reintroduce the "which cwd am I in and does Prisma find `.env` from it" question Step 2 just removed. `test:integration` is added in Task 7, together with the first integration test and the `globalSetup` file it needs — a `test:integration` script with no matching files makes `vitest run` exit 1 (`passWithNoTests` defaults to `false` in Vitest 4), and `pnpm verify` would be red from this task onward. `test:unit` is declared here because this task lands `test/migration-sql.test.ts`, which is a real unit test with real assertions.

`packages/database/tsconfig.json`:

```json
{
  "extends": "@metrika/typescript-config/node.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"]
}
```

Task 7 adds `"vitest.integration.config.ts"` to this `include` when it creates that file.

`packages/database/tsconfig.build.json`:

```json
{
  "extends": "@metrika/typescript-config/node.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "tsBuildInfoFile": "tsconfig.build.tsbuildinfo"
  },
  "include": ["src/**/*.ts"]
}
```

`packages/database/eslint.config.js`:

```js
import { rawSqlBan, typeChecked } from '@metrika/eslint-config';

export default [
  ...typeChecked({ tsconfigRootDir: import.meta.dirname, project: './tsconfig.json' }),
  // Only the raw-SQL half of the Prisma boundary applies here: this package IS
  // the persistence layer, so prismaImportBoundary would forbid it from doing
  // its job. $queryRawUnsafe / $executeRawUnsafe stay banned, here most of all.
  // Imported BY NAME, never as `prismaBoundary.slice(1)` — an index couples
  // this file to the declaration order of two objects in another package.
  ...rawSqlBan,
  { ignores: ['dist/**', 'coverage/**'] },
];
```

`packages/database/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.integration.test.ts'],
  },
});
```

There is no `generated/` anywhere in this package. `schema.prisma`'s `generator client` block declares no `output`, so Prisma 6 emits into `node_modules/.prisma/client` — already ignored by the root `node_modules/` rule — and a `generated/` entry in `.gitignore` or in the ESLint `ignores` would be a reference to a directory that never exists. If a later phase does set `output = "../generated/prisma"`, that same change must add the `.gitignore` entry, the ESLint ignore **and** a `tsconfig.json` exclude in one commit.

- [ ] **Step 4: Install, and verify the consent list binds**

**This step comes before anything that runs a tool.** Writing `package.json` in Step 3 does not put a single byte on disk: `pnpm` only fetches on `install`/`add`. Step 6 invokes the Prisma CLI (`pnpm db:migrate`) and Step 9 invokes Vitest (`test:unit`), and both exit with `command not found` if this step has not run.

```bash
pnpm --filter @metrika/database add --save-exact @prisma/client@6.19.3
pnpm --filter @metrika/database add --save-exact @metrika/contracts@workspace:*
pnpm --filter @metrika/database add --save-dev --save-exact prisma@6.19.3 typescript@6.0.3 vitest@4.1.10 eslint@10.8.0
pnpm --filter @metrika/database add --save-dev --save-exact @metrika/eslint-config@workspace:* @metrika/typescript-config@workspace:*
```

Then confirm every version landed **bare, without a caret** — pnpm 11.20.0 drops `--save-exact` when flags are bundled short (`-DE`) and when a specifier for that dependency already exists:

```bash
grep -nE '"(prisma|@prisma/client|typescript|vitest|eslint)"' packages/database/package.json
```

Expected: `"prisma": "6.19.3"`, `"@prisma/client": "6.19.3"`, `"typescript": "6.0.3"`, `"vitest": "4.1.10"`, `"eslint": "10.8.0"` — no `^`, no `~`. Edit by hand and re-run `pnpm install` if any carries a range.

Only **now** is Step 1's consent list testable: `prisma` and `@prisma/client` are in the workspace and both carry install scripts, so a from-scratch install is a real exercise of `allowBuilds` rather than a no-op.

```bash
rm -rf node_modules && pnpm install
echo "EXIT=$?"
```

Expected: `EXIT=0`, no `ERR_PNPM_IGNORED_BUILDS`. If it names a package, add it to `allowBuilds` in `pnpm-workspace.yaml` and repeat until clean.

Then the mutation, because a consent list that has never been seen to fail is a guess: delete the three entries under `allowBuilds:` in `pnpm-workspace.yaml` (leaving the key with an empty body is invalid YAML — delete the `allowBuilds:` key as well) and re-run the two commands above.

Expected: **`EXIT=1`**, with `ERR_PNPM_IGNORED_BUILDS` naming the Prisma packages whose build scripts were skipped — the exact failure that breaks CI on the first clean install, and the one Step 1 exists to prevent. Restore the `allowBuilds` block exactly as Step 1 writes it, re-run, confirm `EXIT=0`. Record which package names pnpm actually listed: if it names one the list does not cover, add it in the same commit.

- [ ] **Step 5: Write the schema**

`packages/database/prisma/schema.prisma`. Two models, chosen for what they let the next twelve phases assume rather than for what they store:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  // The OWNER url, deliberately. This is the only url the Prisma CLI uses:
  // migrate, generate and studio all need DDL rights. The running API never
  // reads this — it passes DATABASE_URL (the metrika_app role) to
  // createPrismaClient() programmatically. See ADR-0005 and the Global
  // Constraints of this plan.
  url      = env("DATABASE_ADMIN_URL")
}

/// Round-trip target for GET /health/deep. It exists so the deep probe can
/// prove a real query reached Postgres and came back, rather than proving a
/// TCP connection opened. Not tenant-scoped, so no RLS policy.
model HealthCheck {
  id        String   @id @default(uuid()) @db.Uuid
  checkedAt DateTime @default(now()) @db.Timestamptz(3)
}

/// The permanent regression fixture for the two client extensions and for RLS.
///
/// It is retained on purpose rather than deleted once Phase 1 introduces real
/// tenant tables. Cost: one empty table. Benefit: the RLS and soft-delete
/// suites keep working between phases without depending on whichever domain
/// model happens to exist, and a migration that silently drops FORCE ROW LEVEL
/// SECURITY fails a test instead of shipping.
model RlsProbe {
  id             String    @id @default(uuid()) @db.Uuid
  organizationId String    @db.Uuid
  label          String
  deletedAt      DateTime? @db.Timestamptz(3)
  createdAt      DateTime  @default(now()) @db.Timestamptz(3)

  @@index([organizationId, createdAt(sort: Desc)])
}
```

Conventions inherited by every later model, per [DOMAIN_MODEL.md §6](../../DOMAIN_MODEL.md#6-prisma-schema-design): `@db.Uuid` primary keys, `@db.Timestamptz(3)` timestamps, `deletedAt DateTime?` for soft delete, PascalCase table names with camelCase columns (Prisma's default — no `@@map`).

- [ ] **Step 6: Generate the migration and hand-write the RLS half**

From the repository root, always:

```bash
pnpm db:migrate -- --create-only --name init
```

This writes `prisma/migrations/<timestamp>_init/migration.sql` with the two `CREATE TABLE` statements and the index. Append the security half by hand — Prisma does not model RLS:

```sql
-- Tenant context, read by every policy. STABLE (not IMMUTABLE) because it
-- reads a session setting. The `true` second argument to current_setting makes
-- a missing setting return NULL instead of raising, so an unset context denies
-- every row rather than erroring — deny-by-default.
CREATE OR REPLACE FUNCTION app_current_org_id() RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid
$$;

ALTER TABLE "RlsProbe" ENABLE ROW LEVEL SECURITY;

-- FORCE is not optional. ENABLE alone exempts the table OWNER, and the owner
-- is the role `prisma migrate` and any psql session connect as locally. Without
-- FORCE the policy below is invisible to exactly the connection a developer
-- uses to convince themselves RLS works.
ALTER TABLE "RlsProbe" FORCE ROW LEVEL SECURITY;

-- WITH CHECK as well as USING: USING filters what a statement can SEE, WITH
-- CHECK constrains what it can WRITE. Without it, a caller in org A can INSERT
-- a row stamped with org B's id and then never see it again.
CREATE POLICY "RlsProbe_tenant_isolation" ON "RlsProbe"
  USING ("organizationId" = app_current_org_id())
  WITH CHECK ("organizationId" = app_current_org_id());
```

Apply it, again from the repository root:

```bash
pnpm db:migrate
```

Expected: `Your database is now in sync with your schema.` and a generated client.

- [ ] **Step 7: Write the package barrel**

`packages/database/src/index.ts` — the client itself lands in Task 7; this is what makes the package compile and be importable now:

```ts
export type { Prisma, PrismaClient as MetrikaPrismaClient } from '@prisma/client';
```

- [ ] **Step 8: Confirm the package builds**

```bash
pnpm build
```

Expected: exit 0. `packages/database/dist/index.js` and `index.d.ts` exist. `build` is `pnpm db:generate && tsc -b tsconfig.build.json`, so this is also the first proof that the generator block in `schema.prisma` and the root `db:generate` script agree.

- [ ] **Step 9: Assert the security half of the migration in a unit test**

The RLS clauses in the migration are hand-written, they are the whole tenant backstop, and Task 8's integration suite only catches their removal when Docker is available. A file-level assertion costs nothing and turns "somebody regenerated the migration" into a red `pnpm verify` within seconds.

`packages/database/test/migration-sql.test.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationsDir = path.resolve(import.meta.dirname, '../prisma/migrations');

function migrationFiles(): readonly string[] {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(migrationsDir, entry.name, 'migration.sql'));
}

const allSql = migrationFiles()
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');

describe('the committed migrations', () => {
  it('finds at least one migration, so a broken reader cannot make this file vacuous', () => {
    expect(migrationFiles().length).toBeGreaterThan(0);
    expect(allSql.length).toBeGreaterThan(100);
  });

  it('creates the tenant-context function every policy reads', () => {
    expect(allSql).toContain('CREATE OR REPLACE FUNCTION app_current_org_id()');
  });

  it('enables row-level security on RlsProbe', () => {
    expect(allSql).toContain('ALTER TABLE "RlsProbe" ENABLE ROW LEVEL SECURITY');
  });

  it('FORCES row-level security, so the table owner is not exempt', () => {
    expect(allSql).toContain('ALTER TABLE "RlsProbe" FORCE ROW LEVEL SECURITY');
  });

  it('constrains writes as well as reads — a USING-only policy lets a caller plant a foreign row', () => {
    expect(allSql).toContain('WITH CHECK ("organizationId" = app_current_org_id())');
  });
});
```

Run: `pnpm --filter @metrika/database test:unit`
Expected: PASS, 5 tests.

- [ ] **Step 10: Mutation — prove the migration assertions fire**

Delete the line `ALTER TABLE "RlsProbe" FORCE ROW LEVEL SECURITY;` from `prisma/migrations/<timestamp>_init/migration.sql`.

Run: `pnpm --filter @metrika/database test:unit`
Expected: **RED.** `FORCES row-level security, so the table owner is not exempt` fails. Restore the line, re-run, confirm green.

Then, to prove the _vacuity guard_ is itself real, temporarily point `migrationsDir` at `../prisma/no-such-dir`.
Run: same command.
Expected: **RED** — the suite fails at module load with `ENOENT`, not silently green on an empty string. Restore the path.

- [ ] **Step 11: Mutation — prove the schema's admin URL is the one the CLI uses**

Temporarily point `schema.prisma` at the application role:

```prisma
  url = env("DATABASE_URL")
```

Run: `pnpm db:reset`
Expected: **failure** — `permission denied to create database` or `must be owner of table`, because `metrika_app` has no DDL rights. That is the proof that migrations genuinely run as the owner and the application genuinely does not.

Restore `env("DATABASE_ADMIN_URL")`, re-run `pnpm db:reset`, confirm success.

- [ ] **Step 12: Mutation — prove the root scripts are what makes Prisma find its environment**

Run the invocation this plan deliberately does not use:

```bash
cd packages/database && pnpm exec prisma migrate deploy; echo "EXIT=$?"; cd ../..
```

Expected: **EXIT=1** with `error: Environment variable not found: DATABASE_ADMIN_URL`, on a machine where `.env` exists and `pnpm db:deploy` works. This is the failure Step 2 exists to prevent; running it once is what keeps somebody from "simplifying" the root scripts away.

Then confirm the sanctioned form still works: `pnpm db:deploy` → exit 0.

- [ ] **Step 13: Verify and commit**

```bash
pnpm verify
```

Expected: exit 0.

```bash
git add packages/database scripts/prisma.mjs package.json pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat(database): add prisma schema, init migration and forced row-level security"
```

---

### Task 6: `packages/testing` — the Testcontainers Postgres harness

ROADMAP 0.13, the Postgres half. Redis, MinIO and the Temporal test environment land with the modules that use them.

**Files:**

- Create: `packages/testing/package.json`, `tsconfig.json`, `tsconfig.build.json`, `eslint.config.js`, `vitest.integration.config.ts`, `src/index.ts`, `src/docker.ts`, `src/images.ts`, `src/database.ts`, `src/global-setup.ts`, `test/global-setup.ts`
- Modify: `packages/database/package.json` (add the `@metrika/testing` devDependency)
- Test: `packages/testing/test/database.integration.test.ts`, `packages/database/test/postgres-image.test.ts`

**Interfaces:**

- Consumes: Task 5
- Produces:
  - `assertDockerAvailable(): Promise<void>` — throws a readable error naming the fix
  - `POSTGRES_IMAGE: string` — exported from `@metrika/testing/images`, the single definition of the Postgres tag
  - `interface DatabaseHandle { readonly applicationUrl: string; readonly adminUrl: string }`
  - `interface StartDatabaseOptions { readonly databasePackageRoot: string }`
  - `interface DisposableClient { $disconnect(): Promise<void> }`
  - `startDatabase(options: StartDatabaseOptions): Promise<DatabaseHandle>` — returns the URLs published by the `globalSetup` if there are any, otherwise applies `sql/00-app-role.sql`, runs `prisma migrate deploy` and starts one container for this process
  - `stopDatabase(): Promise<void>` — stops the container **only if this module registry started it**
  - `withDatabase<TClient extends DisposableClient, T>(options: WithDatabaseOptions<TClient>, fn: (db: TClient) => Promise<T>): Promise<T>`
  - `createDatabaseGlobalSetup(options: StartDatabaseOptions)` — a Vitest `globalSetup` default export

**This package must not depend on `packages/database`, in `dependencies` or in `devDependencies`.** `packages/database` and `apps/api` depend on _it_; adding the reverse edge makes Turbo's `^build` graph cyclic and aborts every `pnpm build`. Two consequences shape the whole API:

- `startDatabase` cannot call `require.resolve('@metrika/database/package.json')` to find the SQL and the migrations, so it takes `databasePackageRoot` as an **option**.
- `withDatabase` cannot import `createPrismaClient`, so it takes a **caller-supplied client factory** and only requires that what the factory returns has `$disconnect()`.

The Prisma-shaped `withDatabase(fn)` that [TESTING.md §3](../../TESTING.md#3-integration-tests) declares is built on top of these two in `packages/database/test/support.ts` (Task 7), which is allowed to know about both packages.

- [ ] **Step 1: Write the failing harness self-test**

This suite tests what `packages/testing` actually owns: that a container comes up with two distinct roles, that the container is shared rather than re-created, that `withDatabase` hands the factory the **application** URL, and that it disposes of what the factory returned. Everything that needs a Prisma client — "the migrations really ran", "the role really cannot bypass RLS" — is asserted in `packages/database`'s suites (Tasks 7 and 8), where a Prisma client legitimately exists.

`packages/testing/test/database.integration.test.ts`:

```ts
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  APPLICATION_URL_VAR,
  DockerUnavailableError,
  startDatabase,
  stopDatabase,
  withDatabase,
  type DisposableClient,
} from '../src/index.js';

/**
 * A filesystem path, deliberately NOT `require.resolve('@metrika/database')`.
 * packages/testing must not declare a dependency on packages/database —
 * packages/database depends on this package, and Turbo refuses the resulting
 * cycle with "Cyclic dependency detected". A sibling directory on disk is not
 * a package edge, and this path is only ever used by this package's own tests.
 */
const databasePackageRoot = path.resolve(import.meta.dirname, '../../database');

/** A recording stand-in. This package must not know what a Prisma client is. */
class StubClient implements DisposableClient {
  disconnected = false;

  constructor(readonly url: string) {}

  async $disconnect(): Promise<void> {
    this.disconnected = true;
    await Promise.resolve();
  }
}

afterAll(async () => {
  await stopDatabase();
});

describe('the Testcontainers Postgres harness', () => {
  it('exposes two URLs that use different roles', async () => {
    const handle = await startDatabase({ databasePackageRoot });
    expect(handle.applicationUrl).toContain('metrika_app:');
    expect(handle.adminUrl).toContain('metrika:');
    expect(handle.applicationUrl).not.toBe(handle.adminUrl);
  });

  it('reuses the container the globalSetup started rather than starting a second', async () => {
    const first = await startDatabase({ databasePackageRoot });
    const second = await startDatabase({ databasePackageRoot });
    expect(second.applicationUrl).toBe(first.applicationUrl);
    // The URL came from the globalSetup, not from a container this file
    // started. Without this line the test would also pass on a per-file
    // container, which is the exact regression it exists to catch.
    expect(first.applicationUrl).toBe(process.env[APPLICATION_URL_VAR]);
  });

  it('hands the caller-supplied factory the APPLICATION url, never the owner url', async () => {
    const handle = await startDatabase({ databasePackageRoot });

    const url = await withDatabase(
      { databasePackageRoot, createClient: (databaseUrl) => new StubClient(databaseUrl) },
      async (db) => Promise.resolve(db.url),
    );

    expect(url).toBe(handle.applicationUrl);
    expect(url).not.toBe(handle.adminUrl);
  });

  it('disposes of the client it created, even when the callback throws', async () => {
    const created: StubClient[] = [];

    await expect(
      withDatabase(
        {
          databasePackageRoot,
          createClient: (databaseUrl) => {
            const stub = new StubClient(databaseUrl);
            created.push(stub);
            return stub;
          },
        },
        async () => {
          await Promise.resolve();
          throw new Error('callback exploded');
        },
      ),
    ).rejects.toThrow('callback exploded');

    expect(created).toHaveLength(1);
    expect(created[0]?.disconnected).toBe(true);
  });

  it('names the fix in the Docker preflight error rather than the library default', () => {
    const error = new DockerUnavailableError('Cannot connect to the Docker daemon');
    expect(error.message).toContain('Docker Desktop');
    expect(error.message).toContain('pnpm test:unit');
    expect(error.message).toContain('Cannot connect to the Docker daemon');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @metrika/testing test:integration`
Expected: FAIL — the package does not exist.

- [ ] **Step 3: Write the Docker preflight**

`packages/testing/src/docker.ts`. Testcontainers' own failure is `Could not find a working container runtime strategy`, which does not tell a newcomer what to install:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export class DockerUnavailableError extends Error {
  constructor(cause: string) {
    super(
      [
        'Docker is not reachable, so integration tests cannot run.',
        '',
        `  ${cause}`,
        '',
        'Fix: start Docker Desktop, OrbStack or Colima, then re-run.',
        'Unit tests (`pnpm test:unit`) do not need Docker and are unaffected.',
      ].join('\n'),
    );
    this.name = 'DockerUnavailableError';
  }
}

export async function assertDockerAvailable(): Promise<void> {
  try {
    await run('docker', ['info', '--format', '{{.ServerVersion}}']);
  } catch (error: unknown) {
    throw new DockerUnavailableError(error instanceof Error ? error.message : String(error));
  }
}
```

- [ ] **Step 4: Write the image pin, the harness and the global setup**

`packages/testing/src/images.ts`:

```ts
/**
 * The single definition of the Postgres image, used by the Testcontainers
 * harness. `infra/docker/docker-compose.yml` carries the same string with a
 * KEEP IN SYNC comment, because YAML cannot import TypeScript, and
 * packages/database/test/postgres-image.test.ts fails when the two diverge. A
 * local stack on one Postgres major and a test run on another is a green CI
 * with a broken laptop.
 */
export const POSTGRES_IMAGE = 'postgres:16-alpine';
```

`packages/testing/src/database.ts`:

```ts
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { assertDockerAvailable } from './docker.js';
import { POSTGRES_IMAGE } from './images.js';

const run = promisify(execFile);

export interface DatabaseHandle {
  /** metrika_app — NOSUPERUSER NOBYPASSRLS. What the API uses. */
  readonly applicationUrl: string;
  /** The owner. What `prisma migrate deploy` uses. */
  readonly adminUrl: string;
}

export interface StartDatabaseOptions {
  /**
   * Absolute path to the directory holding `sql/00-app-role.sql` and
   * `prisma/`. A PARAMETER, not `require.resolve('@metrika/database')`: this
   * package must not depend on packages/database, because packages/database
   * depends on it and Turbo's `^build` graph would be cyclic. Callers pass
   * their own root.
   */
  readonly databasePackageRoot: string;
}

/** The narrowest shape this harness needs from whatever the caller builds. */
export interface DisposableClient {
  $disconnect(): Promise<void>;
}

export interface WithDatabaseOptions<TClient extends DisposableClient>
  extends StartDatabaseOptions {
  readonly createClient: (databaseUrl: string) => TClient;
}

const OWNER = 'metrika';
const OWNER_PASSWORD = 'metrika';
const DATABASE = 'metrika_test';
const APPLICATION_ROLE = 'metrika_app';
const APPLICATION_PASSWORD = 'metrika_app';

/** Written by the globalSetup, read by every worker it forks. */
export const APPLICATION_URL_VAR = 'METRIKA_TEST_DATABASE_URL';
export const ADMIN_URL_VAR = 'METRIKA_TEST_DATABASE_ADMIN_URL';

let container: StartedPostgreSqlContainer | undefined;
let handle: DatabaseHandle | undefined;

function urlFor(started: StartedPostgreSqlContainer, user: string, password: string): string {
  const host = started.getHost();
  const port = started.getMappedPort(5432);
  return `postgresql://${user}:${password}@${host}:${port}/${DATABASE}?schema=public`;
}

function publishedHandle(): DatabaseHandle | undefined {
  const applicationUrl = process.env[APPLICATION_URL_VAR];
  const adminUrl = process.env[ADMIN_URL_VAR];
  if (applicationUrl === undefined || adminUrl === undefined) return undefined;
  return { applicationUrl, adminUrl };
}

/**
 * Returns the container the Vitest `globalSetup` already started, if there is
 * one; otherwise starts its own.
 *
 * The fallback is not redundant. `globalSetup` is what gives a whole run ONE
 * container — `fileParallelism: false` only serialises files, it does not merge
 * their module registries, so a module-level `let container` alone yields one
 * container per FILE. (MEASURED, not assumed: three files without `globalSetup`
 * started three containers, one per freshly forked worker process. See Task 8
 * Step 3 of Plan 0B-1.) But a
 * developer running `vitest run test/one.test.ts`
 * through an editor plugin may bypass the project config entirely, and failing
 * with "no database" there would be hostile. The env-var check keeps both paths
 * working and keeps them honest: the harness never starts a second container
 * when a published one exists.
 */
export async function startDatabase(options: StartDatabaseOptions): Promise<DatabaseHandle> {
  if (handle !== undefined) return handle;

  const published = publishedHandle();
  if (published !== undefined) {
    handle = published;
    return handle;
  }

  await assertDockerAvailable();

  container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withUsername(OWNER)
    .withPassword(OWNER_PASSWORD)
    .withDatabase(DATABASE)
    // The SAME file docker compose mounts into docker-entrypoint-initdb.d.
    // Copying it here rather than re-declaring the role in TypeScript is what
    // keeps local and CI from drifting on the one thing that decides whether
    // RLS applies at all.
    //
    // Signature verified against the installed testcontainers@12.1.0 types —
    // `withCopyFilesToContainer(filesToCopy: FileToCopy[]): this`, where
    // `FileToCopy = { source, target, mode? }`. It takes an ARRAY of objects
    // with NAMED keys, not positional (source, target) arguments. Verified end
    // to end, not just read: a role created by a file copied to
    // /docker-entrypoint-initdb.d/ was found by a live `SELECT rolname FROM
    // pg_roles` after `.start()`, so the image really does execute what lands
    // there.
    .withCopyFilesToContainer([
      {
        source: path.join(options.databasePackageRoot, 'sql/00-app-role.sql'),
        target: '/docker-entrypoint-initdb.d/00-app-role.sql',
      },
    ])
    .start();

  const adminUrl = urlFor(container, OWNER, OWNER_PASSWORD);
  const applicationUrl = urlFor(container, APPLICATION_ROLE, APPLICATION_PASSWORD);

  // The one sanctioned exception to "all Prisma CLI calls go through
  // scripts/prisma.mjs": the URL is a container port that does not exist until
  // now, so it is passed explicitly in the child environment rather than read
  // from a file.
  await run('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: options.databasePackageRoot,
    env: { ...process.env, DATABASE_ADMIN_URL: adminUrl },
  });

  handle = { adminUrl, applicationUrl };
  return handle;
}

/**
 * Stops the container **only if this module registry started it**. When the
 * URLs came from the globalSetup's environment variables `container` is
 * undefined here, so a per-file `afterAll(stopDatabase)` is a no-op on the
 * shared container instead of pulling it out from under the next file.
 */
export async function stopDatabase(): Promise<void> {
  if (container !== undefined) {
    await container.stop();
    container = undefined;
  }
  handle = undefined;
}

/**
 * Runs `fn` against a client the CALLER knows how to build, connected as
 * metrika_app — so anything the callback does is subject to row-level security
 * exactly as production is. The client is disposed of in a `finally`, including
 * when the callback throws: a leaked connection here exhausts a small
 * container's pool a dozen tests later, where the cause is invisible.
 */
export async function withDatabase<TClient extends DisposableClient, T>(
  options: WithDatabaseOptions<TClient>,
  fn: (db: TClient) => Promise<T>,
): Promise<T> {
  const started = await startDatabase(options);
  const db = options.createClient(started.applicationUrl);
  try {
    return await fn(db);
  } finally {
    await db.$disconnect();
  }
}
```

`packages/testing/src/global-setup.ts`:

```ts
import {
  ADMIN_URL_VAR,
  APPLICATION_URL_VAR,
  startDatabase,
  stopDatabase,
  type StartDatabaseOptions,
} from './database.js';

/**
 * Builds the default export of a Vitest `globalSetup` file.
 *
 * Vitest runs globalSetup exactly ONCE per run, in its own module registry,
 * before it forks any worker — which makes it the only place a container can
 * live if every test file in the run is to share it. `fileParallelism: false`
 * does not achieve this on its own: it serialises files, it does not merge
 * their module graphs, so a module-level `let container` gives one container
 * per file, plus one `prisma migrate deploy` per file. (MEASURED on Docker
 * 29.6.2 / Vitest 4.1.10: three files, three containers, three worker PIDs.
 * `fileParallelism: false` forces maxWorkers to 1 but the default
 * `isolate: true` still respawns a fresh fork per file, so nothing at module
 * level survives the file boundary. See Task 8 Step 3 of Plan 0B-1.)
 *
 * The two URLs travel to the workers through `process.env` because the workers
 * are forked after this function returns and inherit it. `startDatabase()`
 * reads them and starts nothing.
 */
export function createDatabaseGlobalSetup(
  options: StartDatabaseOptions,
): () => Promise<() => Promise<void>> {
  return async function setup(): Promise<() => Promise<void>> {
    const started = await startDatabase(options);
    process.env[APPLICATION_URL_VAR] = started.applicationUrl;
    process.env[ADMIN_URL_VAR] = started.adminUrl;

    return async function teardown(): Promise<void> {
      delete process.env[APPLICATION_URL_VAR];
      delete process.env[ADMIN_URL_VAR];
      await stopDatabase();
    };
  };
}
```

`packages/testing/test/global-setup.ts` — this package's own run:

```ts
import path from 'node:path';
import { createDatabaseGlobalSetup } from '../src/index.js';

// A filesystem path, deliberately not a package specifier. See the comment in
// test/database.integration.test.ts.
export default createDatabaseGlobalSetup({
  databasePackageRoot: path.resolve(import.meta.dirname, '../../database'),
});
```

`packages/testing/src/index.ts`:

```ts
export { assertDockerAvailable, DockerUnavailableError } from './docker.js';
export { POSTGRES_IMAGE } from './images.js';
export { createDatabaseGlobalSetup } from './global-setup.js';
export {
  ADMIN_URL_VAR,
  APPLICATION_URL_VAR,
  startDatabase,
  stopDatabase,
  withDatabase,
  type DatabaseHandle,
  type DisposableClient,
  type StartDatabaseOptions,
  type WithDatabaseOptions,
} from './database.js';
```

- [ ] **Step 5: Package files**

`packages/testing/package.json`:

```json
{
  "name": "@metrika/testing",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./images": {
      "types": "./dist/images.d.ts",
      "default": "./dist/images.js"
    },
    "./package.json": "./package.json"
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -b tsconfig.build.json",
    "typecheck": "tsc -b",
    "lint": "eslint .",
    "test:integration": "vitest run --config vitest.integration.config.ts"
  },
  "dependencies": {
    "@testcontainers/postgresql": "12.1.0",
    "testcontainers": "12.1.0"
  },
  "devDependencies": {
    "@metrika/eslint-config": "workspace:*",
    "@metrika/typescript-config": "workspace:*",
    "eslint": "10.8.0",
    "typescript": "6.0.3",
    "vitest": "4.1.10"
  }
}
```

There is no `test:unit` script: this package is a harness, and it is self-tested by the integration suite that consumes it. (A declared `test:unit` with no matching files makes `vitest run` exit 1 in Vitest 4 — `passWithNoTests` defaults to `false` — which would make `pnpm verify` red from here onward.)

There is deliberately **no** `@metrika/database` entry, in either dependency block. See the note under **Interfaces** above; `pnpm why` in Step 6 asserts it.

`@metrika/testing/images` is a second export so the compose-parity unit test in `packages/database` can read one constant without loading `testcontainers`, `dockerode` and their transitive graph into a unit-test process.

`packages/testing/tsconfig.json`:

```json
{
  "extends": "@metrika/typescript-config/node.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src/**/*.ts", "test/**/*.ts", "vitest.integration.config.ts"]
}
```

`packages/testing/tsconfig.build.json`:

```json
{
  "extends": "@metrika/typescript-config/node.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "tsBuildInfoFile": "tsconfig.build.tsbuildinfo"
  },
  "include": ["src/**/*.ts"]
}
```

`packages/testing/eslint.config.js`:

```js
import { typeChecked } from '@metrika/eslint-config';

export default [
  ...typeChecked({ tsconfigRootDir: import.meta.dirname, project: './tsconfig.json' }),
  {
    // The harness must read and write the ambient environment: to hand the
    // container's URL to `prisma migrate deploy`, and to publish the two URLs
    // from globalSetup to the workers Vitest forks afterwards. This is test
    // infrastructure, not application configuration, and these are the only
    // readers in the package.
    files: ['src/database.ts', 'src/global-setup.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  {
    // The self-test asserts on the variables globalSetup published.
    files: ['test/**/*.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  { ignores: ['dist/**'] },
];
```

`packages/testing/vitest.integration.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    // The container's lifecycle lives in globalSetup, which Vitest runs once
    // per RUN, before it forks any worker — regardless of `pool`, `isolate`
    // or `fileParallelism`. This is VERIFIED, not a prediction: see Task 8
    // Step 3's measurement in this plan.
    globalSetup: ['./test/global-setup.ts'],
    // Files still run one at a time (fileParallelism:false forces
    // maxWorkers to 1), so the small container's connection budget never
    // sees concurrent load. NOTE: this does NOT reuse a single forked
    // process across files — Vitest still spawns a fresh fork per file
    // under the default `isolate:true`. That's fine: the container itself
    // lives in globalSetup, not in module state those forks would share.
    //
    // Do NOT add `poolOptions: { forks: { singleFork: true } }` here.
    // `poolOptions` was removed in Vitest 4 (options moved to top-level)
    // and fails `defineConfig`'s type check: TS2769 "'poolOptions' does
    // not exist in type 'InlineConfig'". At runtime the CLI merely warns
    // and ignores it, but `pnpm typecheck` (part of `pnpm verify`) will
    // not build clean with this line present. Verified by removing it:
    // container count and pass/fail are unaffected either way.
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
```

- [ ] **Step 6: Install, re-check the build-script consent list, and run the suite**

```bash
pnpm --filter @metrika/testing add --save-exact testcontainers@12.1.0 @testcontainers/postgresql@12.1.0
pnpm --filter @metrika/testing add --save-dev --save-exact typescript@6.0.3 vitest@4.1.10 eslint@10.8.0 @metrika/eslint-config@workspace:* @metrika/typescript-config@workspace:*
grep -nE '"(testcontainers|@testcontainers/postgresql)"' packages/testing/package.json
```

Expected: bare `12.1.0` for both — no caret. A `^10.13.0`-style range would silently resolve 10.28.0, a whole major behind what was verified.

Then confirm the one-way dependency really is one-way:

```bash
grep -n 'metrika/database' packages/testing/package.json; echo "EXIT=$?"
pnpm --filter @metrika/database why @metrika/testing 2>&1 | head -5
```

Expected: the `grep` prints nothing and reports `EXIT=1`; `pnpm why` shows the edge only in the `database → testing` direction. If `@metrika/database` appears in `packages/testing/package.json`, `pnpm build` will fail with `Cyclic dependency detected` before any test runs.

Testcontainers pulls `ssh2` and `cpu-features`, both of which carry install scripts, so the consent list has to be re-checked here — `ERR_PNPM_IGNORED_BUILDS` exits 1 and fails CI on the first from-scratch install, not on this one:

```bash
rm -rf node_modules && pnpm install
echo "EXIT=$?"
```

Expected: `EXIT=0`, no `ERR_PNPM_IGNORED_BUILDS`. If it names a package, add it to `allowBuilds` in `pnpm-workspace.yaml` and repeat until clean.

```bash
pnpm build
pnpm --filter @metrika/testing test:integration
```

Expected: PASS, 5 tests. First run pulls `postgres:16-alpine`, so allow a minute. Once the image is cached, expect roughly **2.5–2.6 s** for the container alone (`.start()` through the first successful `SELECT 1`) on a comparable machine — macOS/arm64, Docker 29.6.2, 4 GB allotted to the Docker VM — and a whole-run wall clock in the low single-digit seconds on top of `prisma migrate deploy`. The very first container of a session runs slower, ~7 s, which is Docker Desktop and the Ryuk reaper warming up rather than anything this package does; do not tune a timeout against that number.

- [ ] **Step 7: Give `packages/database` the compose-parity test**

Add the devDependency and the test that makes the image tag single-source:

```bash
pnpm --filter @metrika/database add --save-dev --save-exact @metrika/testing@workspace:*
```

`packages/database/test/postgres-image.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { POSTGRES_IMAGE } from '@metrika/testing/images';

const composePath = path.resolve(
  import.meta.dirname,
  '../../../infra/docker/docker-compose.yml',
);

const imageTags = readFileSync(composePath, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.startsWith('image:'))
  .map((line) => line.slice('image:'.length).trim());

describe('the Postgres image has exactly one definition', () => {
  it('finds all four service images, so a moved file cannot make this vacuous', () => {
    expect(imageTags).toHaveLength(4);
  });

  it('brings up locally the same image the Testcontainers harness starts', () => {
    expect(imageTags.filter((tag) => tag.startsWith('postgres:'))).toEqual([POSTGRES_IMAGE]);
  });
});
```

Run: `pnpm build && pnpm --filter @metrika/database test:unit`
Expected: PASS, 7 tests (5 migration-SQL + 2 image-parity).

- [ ] **Step 8: Mutation — prove `withDatabase` hands out the application role**

In `packages/testing/src/database.ts`, change `withDatabase` to build the client from the owner URL:

```ts
  const db = options.createClient(started.adminUrl);
```

Run: `pnpm --filter @metrika/testing test:integration`
Expected: **RED.** `hands the caller-supplied factory the APPLICATION url, never the owner url` fails — the stub records the `metrika:` URL. The owner is a superuser inside its own container, so every RLS assertion in Task 8 would silently have been testing nothing. Restore `applicationUrl`, re-run, confirm green.

- [ ] **Step 9: Mutation — prove the client is disposed of on the failure path**

Delete the `finally` block from `withDatabase`, leaving `return await fn(db);`.

Run: `pnpm --filter @metrika/testing test:integration`
Expected: **RED.** `disposes of the client it created, even when the callback throws` fails with `expected false to be true`. That leak is what exhausts a small container's connection pool a dozen tests later, in a test that has nothing to do with the cause. Restore, re-run, confirm green.

- [ ] **Step 10: Mutation — prove the compose-parity test is load-bearing**

In `infra/docker/docker-compose.yml`, change the Postgres image to `postgres:15-alpine`.

Run: `pnpm --filter @metrika/database test:unit -- postgres-image`
Expected: **RED.** `brings up locally the same image the Testcontainers harness starts` fails with `expected [ 'postgres:15-alpine' ] to deeply equal [ 'postgres:16-alpine' ]`. Restore `16-alpine`, re-run, confirm green.

- [ ] **Step 11: Verify and commit**

```bash
pnpm verify
```

Expected: exit 0 (`verify` does not run `test:integration`).

```bash
git add packages/testing packages/database pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "feat(testing): add testcontainers postgres harness with a docker preflight"
```

---

### Task 7: `createPrismaClient()` — soft delete and organization context

ROADMAP 0.6, second half. Implements two of ADR-0005's three client extensions; ID branding waits for Phase 1's branded domain models.

**Files:**

- Create: `packages/database/src/client.ts`, `src/extensions/soft-delete.ts`, `src/errors.ts`, `packages/database/vitest.integration.config.ts`, `packages/database/test/support.ts`, `packages/database/test/global-setup.ts`
- Modify: `packages/database/src/index.ts`, `packages/database/package.json` (add `test:integration`), `packages/database/tsconfig.json` (add `vitest.integration.config.ts` to `include`)
- Test: `packages/database/test/harness.integration.test.ts`, `packages/database/test/soft-delete.integration.test.ts`

**Interfaces:**

- Consumes: Tasks 5, 6
- Produces:
  - `createPrismaClient(config: DatabaseConfig): PrismaClient` — `DatabaseConfig` is `{ readonly databaseUrl: string }`. Written as `PrismaClient` because that is the name `client.ts` imports; consumers see the same type through `index.ts`'s `export type { PrismaClient as MetrikaPrismaClient }`, which is the spelling `apps/api` uses
  - `withOrganizationContext<T>(client: PrismaClient, organizationId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>`
  - `withDeleted<T>(fn: () => Promise<T>): Promise<T>` — the explicit escape hatch [DOMAIN_MODEL.md §6](../../DOMAIN_MODEL.md#6-prisma-schema-design) specifies for admin queries
  - `class HardDeleteForbiddenError extends Error`
  - `SOFT_DELETABLE_MODELS: ReadonlySet<string>`
  - `packages/database/test/support.ts` — `startTestDatabase()`, `withDatabase(fn)` bound to `createPrismaClient`, and `stopDatabase` re-exported. **The only module in the repository that knows about both `@metrika/database` and `@metrika/testing`.**

- [ ] **Step 1: Write the test-support module and the Vitest wiring**

This is the bridge the one-way dependency needs. `@metrika/testing` supplies a container and a client-factory-shaped `withDatabase`; this file binds it to Prisma once, so no test file repeats the wiring and no test file has a reason to reach for the harness's generic form.

`packages/database/test/support.ts`:

```ts
import path from 'node:path';
import {
  startDatabase,
  withDatabase as withHarnessDatabase,
  type DatabaseHandle,
} from '@metrika/testing';
import { createPrismaClient, type MetrikaPrismaClient } from '../src/index.js';

/**
 * This package's own root, which is where `sql/00-app-role.sql` and `prisma/`
 * live. @metrika/testing takes it as an option instead of resolving
 * `@metrika/database` itself, because a dependency in that direction would
 * make Turbo's build graph cyclic.
 */
const databasePackageRoot = path.resolve(import.meta.dirname, '..');

export async function startTestDatabase(): Promise<DatabaseHandle> {
  return startDatabase({ databasePackageRoot });
}

/**
 * The signature docs/TESTING.md §3 declares. The client connects as
 * metrika_app, so anything the callback does is subject to row-level security
 * exactly as production is.
 */
export async function withDatabase<T>(fn: (db: MetrikaPrismaClient) => Promise<T>): Promise<T> {
  return withHarnessDatabase(
    { databasePackageRoot, createClient: (databaseUrl) => createPrismaClient({ databaseUrl }) },
    fn,
  );
}

export { stopDatabase } from '@metrika/testing';
```

`packages/database/test/global-setup.ts`:

```ts
import path from 'node:path';
import { createDatabaseGlobalSetup } from '@metrika/testing';

export default createDatabaseGlobalSetup({
  databasePackageRoot: path.resolve(import.meta.dirname, '..'),
});
```

`packages/database/vitest.integration.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    // One container for the whole run, owned by globalSetup — see the comment
    // in packages/testing/vitest.integration.config.ts, including why
    // `poolOptions` must not be added back. Without globalSetup, this
    // package's three integration files each start their own Postgres and run
    // their own `prisma migrate deploy` — measured, three containers; Task 8
    // Step 3 reproduces it.
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
```

Add the script to `packages/database/package.json`:

```json
    "test:integration": "vitest run --config vitest.integration.config.ts",
```

and add `"vitest.integration.config.ts"` to `packages/database/tsconfig.json`'s `include`.

- [ ] **Step 2: Write the failing tests**

`packages/database/test/harness.integration.test.ts` — the assertions Task 6 could not make without a Prisma client:

```ts
import { afterAll, describe, expect, it } from 'vitest';
import { startTestDatabase, stopDatabase, withDatabase } from './support.js';

afterAll(async () => {
  await stopDatabase();
});

describe('the shared test database', () => {
  it('exposes two URLs on two different roles', async () => {
    const handle = await startTestDatabase();
    expect(handle.applicationUrl).toContain('metrika_app:');
    expect(handle.adminUrl).toContain('metrika:');
  });

  it('has applied the migrations, so the schema is queryable', async () => {
    const rows = await withDatabase(async (db) => db.healthCheck.findMany());
    expect(rows).toEqual([]);
  });

  it('round-trips a write through the real database', async () => {
    const created = await withDatabase(async (db) => db.healthCheck.create({ data: {} }));
    const found = await withDatabase(async (db) =>
      db.healthCheck.findUnique({ where: { id: created.id } }),
    );
    expect(found?.id).toBe(created.id);
  });

  it('connects as a role that cannot bypass row-level security', async () => {
    const [role] = await withDatabase(async (db) =>
      db.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
        SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
      `,
    );
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});
```

`packages/database/test/soft-delete.integration.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { stopDatabase, withDatabase } from './support.js';
import { HardDeleteForbiddenError, withDeleted, withOrganizationContext } from '../src/index.js';

const ORG = randomUUID();

afterAll(async () => {
  await stopDatabase();
});

async function seed(label: string, deletedAt: Date | null): Promise<string> {
  return withDatabase(async (db) =>
    withOrganizationContext(db, ORG, async (tx) => {
      const row = await tx.rlsProbe.create({
        data: { organizationId: ORG, label, ...(deletedAt !== null && { deletedAt }) },
      });
      return row.id;
    }),
  );
}

describe('soft-delete extension', () => {
  it('hides soft-deleted rows from findMany', async () => {
    await seed('live-row', null);
    await seed('dead-row', new Date());

    const labels = await withDatabase(async (db) =>
      withOrganizationContext(db, ORG, async (tx) =>
        (await tx.rlsProbe.findMany()).map((r) => r.label),
      ),
    );

    expect(labels).toContain('live-row');
    expect(labels).not.toContain('dead-row');
  });

  it('hides soft-deleted rows from findUnique', async () => {
    const id = await seed('dead-unique', new Date());

    const found = await withDatabase(async (db) =>
      withOrganizationContext(db, ORG, async (tx) => tx.rlsProbe.findUnique({ where: { id } })),
    );

    expect(found).toBeNull();
  });

  it('hides soft-deleted rows from count', async () => {
    const before = await withDatabase(async (db) =>
      withOrganizationContext(db, ORG, async (tx) => tx.rlsProbe.count()),
    );
    await seed('dead-count', new Date());
    const after = await withDatabase(async (db) =>
      withOrganizationContext(db, ORG, async (tx) => tx.rlsProbe.count()),
    );

    expect(after).toBe(before);
  });

  it('filters a findMany called with no arguments at all — the guard is fail-closed', async () => {
    await seed('dead-noargs', new Date());

    const labels = await withDatabase(async (db) =>
      withOrganizationContext(db, ORG, async (tx) =>
        // No argument object whatsoever. If the extension treats an absent
        // `args` as "nothing to filter" and passes it through, this is the
        // call that leaks — and it is the most common call in the codebase.
        (await tx.rlsProbe.findMany()).map((r) => r.label),
      ),
    );

    expect(labels).not.toContain('dead-noargs');
  });

  it('lets an explicit deletedAt filter through as the narrow inline escape hatch', async () => {
    const id = await seed('dead-explicit', new Date());

    const found = await withDatabase(async (db) =>
      withOrganizationContext(db, ORG, async (tx) =>
        tx.rlsProbe.findFirst({ where: { id, deletedAt: { not: null } } }),
      ),
    );

    expect(found?.id).toBe(id);
  });

  it('shows soft-deleted rows inside withDeleted() — the explicit admin escape hatch', async () => {
    const id = await seed('dead-admin', new Date());

    const found = await withDeleted(async () =>
      withDatabase(async (db) =>
        withOrganizationContext(db, ORG, async (tx) => tx.rlsProbe.findUnique({ where: { id } })),
      ),
    );

    expect(found?.id).toBe(id);
  });

  it('re-enables filtering as soon as withDeleted() returns', async () => {
    const id = await seed('dead-admin-scope', new Date());

    await withDeleted(async () => Promise.resolve());

    const found = await withDatabase(async (db) =>
      withOrganizationContext(db, ORG, async (tx) => tx.rlsProbe.findUnique({ where: { id } })),
    );

    expect(found).toBeNull();
  });

  it('refuses a hard delete on a soft-deletable model', async () => {
    const id = await seed('to-delete', null);

    await expect(
      withDatabase(async (db) =>
        withOrganizationContext(db, ORG, async (tx) => tx.rlsProbe.delete({ where: { id } })),
      ),
    ).rejects.toThrow(HardDeleteForbiddenError);
  });

  it('names the correct call in the refusal, so the fix is obvious', async () => {
    const id = await seed('to-delete-message', null);

    await expect(
      withDatabase(async (db) =>
        withOrganizationContext(db, ORG, async (tx) => tx.rlsProbe.delete({ where: { id } })),
      ),
    ).rejects.toThrow(/deletedAt/);
  });

  it('does not filter models that are not soft-deletable', async () => {
    const created = await withDatabase(async (db) => db.healthCheck.create({ data: {} }));
    const found = await withDatabase(async (db) =>
      db.healthCheck.findUnique({ where: { id: created.id } }),
    );
    expect(found?.id).toBe(created.id);
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `pnpm --filter @metrika/database test:integration`
Expected: FAIL — `../src/index.js` exports none of `createPrismaClient`, `withOrganizationContext`, `withDeleted` or `HardDeleteForbiddenError`, so `test/support.ts` does not compile.

- [ ] **Step 4: Write the errors and the extension**

`packages/database/src/errors.ts`:

```ts
export class HardDeleteForbiddenError extends Error {
  constructor(readonly model: string) {
    super(
      `${model} is soft-deletable: use update({ data: { deletedAt: new Date() } }) instead of delete(). ` +
        'Hard-deleting it would orphan history that other records still point at — see docs/DOMAIN_MODEL.md §6.',
    );
    this.name = 'HardDeleteForbiddenError';
  }
}
```

`packages/database/src/extensions/soft-delete.ts`:

```ts
import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma } from '@prisma/client';
import { HardDeleteForbiddenError } from '../errors.js';

/**
 * Soft delete applies to entities a customer can "delete" and might need
 * recovered, and whose disappearance would orphan history. It explicitly does
 * NOT apply to Quote, Order, SliceResult, GeometryAnalysis, AuditLog,
 * StatusTransition or Payment: those are immutable or ledger records, archived
 * by state and never deleted. A soft-delete flag on an immutable record invites
 * someone to hide commercial evidence. See docs/DOMAIN_MODEL.md §6.
 *
 * Phase 1 adds User, Organization, Project and Model. RlsProbe is here now so
 * the behaviour has a regression fixture from the first migration onward.
 */
export const SOFT_DELETABLE_MODELS: ReadonlySet<string> = new Set(['RlsProbe']);

const FILTERED_OPERATIONS: ReadonlySet<string> = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
]);

const REFUSED_OPERATIONS: ReadonlySet<string> = new Set(['delete', 'deleteMany']);

interface QueryArgs {
  where?: Record<string, unknown>;
}

function isQueryArgs(value: unknown): value is QueryArgs {
  return typeof value === 'object' && value !== null;
}

const deletedVisible = new AsyncLocalStorage<true>();

/**
 * The explicit escape hatch docs/DOMAIN_MODEL.md §6 specifies for admin
 * queries. Everything the callback does — at any await depth — sees
 * soft-deleted rows.
 *
 * It is a scoped function rather than a flag or a second client because both
 * of those alternatives can be left switched on. `AsyncLocalStorage` restores
 * the previous state when the callback settles, including when it throws, so
 * "forgot to turn filtering back on" is not a reachable state.
 */
export async function withDeleted<T>(fn: () => Promise<T>): Promise<T> {
  return deletedVisible.run(true, fn);
}

/**
 * Applied through an extension rather than by convention, so it cannot be
 * forgotten — which matters more than usual when an agent is writing the
 * queries. There are exactly two ways past it, both deliberate: `withDeleted()`
 * above, and a caller that names `deletedAt` in its own `where`, which has
 * already said what it wants.
 */
export const softDeleteExtension = Prisma.defineExtension({
  name: 'metrika-soft-delete',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (!SOFT_DELETABLE_MODELS.has(model)) {
          return query(args);
        }

        if (REFUSED_OPERATIONS.has(operation)) {
          throw new HardDeleteForbiddenError(model);
        }

        if (!FILTERED_OPERATIONS.has(operation) || deletedVisible.getStore() === true) {
          return query(args);
        }

        // Fail CLOSED on an unrecognised args shape. `findMany()` with no
        // arguments at all is the most common call in the codebase; treating a
        // missing `args` as "nothing to filter" and passing it through is the
        // one branch here that leaks rows, and it leaks them on the happy path.
        const safeArgs: QueryArgs = isQueryArgs(args) ? args : {};

        const where = safeArgs.where ?? {};
        if ('deletedAt' in where) {
          return query(safeArgs);
        }

        return query({ ...safeArgs, where: { ...where, deletedAt: null } });
      },
    },
  },
});
```

- [ ] **Step 5: Write the client factory**

`packages/database/src/client.ts`:

```ts
// A plain named import, matching extensions/soft-delete.ts. `@prisma/client`
// IS CommonJS — `exports["."]` resolves both `import` and `require` to the same
// `default.js`, whose body is `module.exports = { ...require(...) }` — but that
// exact spread-re-export shape is one Node's built-in cjs-module-lexer analyses
// statically, so named ESM imports of `PrismaClient` and `Prisma` resolve
// correctly. Verified empirically on Prisma 6.19.3 / Node 24.19.0 / TS 6.0.3,
// under moduleResolution NodeNext and Bundler, compiled and stripped. There is
// no default-import indirection anywhere in this repository; if you find one,
// it is a leftover from a premise that was disproved, not a workaround.
import { PrismaClient } from '@prisma/client';
// `Prisma` is used here only for `Prisma.TransactionClient`, so it keeps its
// `import type` form and `consistent-type-imports` stays quiet. This is a
// TYPE-only import of a namespace, not the DI footgun: nothing in this file is
// injected by NestJS.
import type { Prisma } from '@prisma/client';
import { softDeleteExtension } from './extensions/soft-delete.js';

export interface DatabaseConfig {
  /**
   * The APPLICATION role's URL (metrika_app), never the owner's. The owner
   * bypasses nothing — FORCE ROW LEVEL SECURITY sees to that — but it holds
   * DDL rights the running process has no business having.
   */
  readonly databaseUrl: string;
}

export function createPrismaClient(config: DatabaseConfig): PrismaClient {
  const base = new PrismaClient({
    datasources: { db: { url: config.databaseUrl } },
  });

  // `$extends` returns a structurally narrower client (it drops `$on` and
  // `$use`). Widening back to PrismaClient is sound — the extension only
  // rewrites query arguments, so every model delegate and every `$` method
  // this codebase uses survives — and it keeps the emitted .d.ts free of the
  // deep inferred `$extends` type, which pnpm's nested node_modules layout
  // cannot name (TS2742). The behaviour is unaffected; only the static type is
  // widened, and the integration suite is what proves the extension still runs.
  return base.$extends(softDeleteExtension) as unknown as PrismaClient;
}

/**
 * Opens a transaction and sets `app.current_org_id` on it, which is what every
 * RLS policy reads. It has to be a transaction: Prisma pools connections, and a
 * session-level setting made on one connection is invisible to the next query,
 * which lands on another.
 *
 * `set_config(name, value, is_local => true)` rather than `SET LOCAL`: they are
 * equivalent, but `SET LOCAL` cannot take a bind parameter, so using it would
 * mean interpolating `organizationId` into SQL text.
 */
export async function withOrganizationContext<T>(
  client: PrismaClient,
  organizationId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_org_id', ${organizationId}, true)`;
    return fn(tx);
  });
}
```

`packages/database/src/index.ts`:

```ts
export type { Prisma, PrismaClient as MetrikaPrismaClient } from '@prisma/client';
export { createPrismaClient, withOrganizationContext, type DatabaseConfig } from './client.js';
export { HardDeleteForbiddenError } from './errors.js';
export { SOFT_DELETABLE_MODELS, withDeleted } from './extensions/soft-delete.js';
```

- [ ] **Step 6: Run the tests and watch them pass**

```bash
pnpm build
pnpm --filter @metrika/database test:integration
```

Expected: PASS — 4 harness tests and 10 soft-delete tests, 14 in total, from **one** Postgres container.

One honest note about the fail-closed guard. Prisma normalises an absent argument object to `{}` before the extension sees it, so `filters a findMany called with no arguments at all` passes with either the fail-open or the fail-closed form, and **there is no mutation that turns it red**. It is kept for two reasons that do not depend on today's normalisation: the test pins the observable behaviour so a future Prisma that stops normalising is caught, and the code's failure direction is the safe one for a filter that will later be hiding tenant data. It is defence in depth, and it is labelled as such rather than counted as a proven gate.

- [ ] **Step 7: Mutation — prove the `deletedAt` injection is what hides rows**

In `soft-delete.ts`, replace the injecting return with a pass-through:

```ts
        return query(safeArgs);
```

Run: `pnpm --filter @metrika/database test:integration`
Expected: **RED, four times** — `hides soft-deleted rows from findMany`, `…from findUnique`, `…from count` and `filters a findMany called with no arguments at all` all fail. Restore.

- [ ] **Step 8: Mutation — prove `withDeleted()` is the thing that reveals the rows**

In `soft-delete.ts`, remove the escape-hatch check from the guard so the scope is ignored:

```ts
        if (!FILTERED_OPERATIONS.has(operation)) {
          return query(args);
        }
```

Run: `pnpm --filter @metrika/database test:integration`
Expected: **RED, once** — `shows soft-deleted rows inside withDeleted() — the explicit admin escape hatch` fails with `expected null to be truthy`. `re-enables filtering as soon as withDeleted() returns` stays **green**, which is what tells you the failure is the hatch and not the filter. Restore.

Then the reverse: change `withDeleted` to enter the scope permanently instead of scoping it —

```ts
export async function withDeleted<T>(fn: () => Promise<T>): Promise<T> {
  deletedVisible.enterWith(true);
  return fn();
}
```

Run: same command.
Expected: **RED** — `re-enables filtering as soon as withDeleted() returns` fails, because `enterWith` leaks the scope into everything that runs after it in the same async context. That is exactly the "forgot to turn filtering back on" state `run()` makes unreachable. Restore the `run()` form.

- [ ] **Step 9: Mutation — prove the model allowlist is not vacuous**

Change `SOFT_DELETABLE_MODELS` to `new Set(['HealthCheck'])`.

Run: `pnpm --filter @metrika/database test:integration`
Expected: **RED, eight times.** `RlsProbe` stops being filtered and `HealthCheck` starts:

1. `hides soft-deleted rows from findMany` — `dead-row` is visible.
2. `hides soft-deleted rows from findUnique` — the row is returned.
3. `hides soft-deleted rows from count` — the count grows.
4. `filters a findMany called with no arguments at all` — `dead-noargs` is visible.
5. `re-enables filtering as soon as withDeleted() returns` — the row is still visible outside the scope.
6. `refuses a hard delete on a soft-deletable model` — the delete succeeds and nothing throws.
7. `names the correct call in the refusal` — same cause.
8. `does not filter models that are not soft-deletable` — `HealthCheck` has no `deletedAt` column, so Prisma raises `Unknown argument 'deletedAt'`.

That last one is the proof the set is consulted rather than ignored; a set that was never read would leave every test green. (`lets an explicit deletedAt filter through` and `shows soft-deleted rows inside withDeleted()` both stay green — they assert a row _is_ visible, which is what an unfiltered model gives you anyway. Eight failures, two survivors; count them.)

Restore `new Set(['RlsProbe'])`.

- [ ] **Step 10: Mutation — prove the transaction wrapper is load-bearing**

In `withOrganizationContext`, drop the transaction:

```ts
export async function withOrganizationContext<T>(
  client: PrismaClient,
  organizationId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  await client.$executeRaw`SELECT set_config('app.current_org_id', ${organizationId}, false)`;
  return fn(client as unknown as Prisma.TransactionClient);
}
```

Run: `pnpm --filter @metrika/database test:integration`
Expected: **RED.** The `create` calls in `seed` fail with `new row violates row-level security policy for table "RlsProbe"`, because the `WITH CHECK` clause evaluates `app_current_org_id()` on a pooled connection that never received the setting. Restore the transaction form.

- [ ] **Step 11: Mutation — prove the harness migration step is real**

This is the assertion Task 6 could not make without a Prisma client. Comment out the `prisma migrate deploy` call in `packages/testing/src/database.ts`'s `startDatabase`.

Run: `pnpm --filter @metrika/database test:integration`
Expected: **RED.** `has applied the migrations, so the schema is queryable` fails with Prisma's `The table \`public.HealthCheck\` does not exist in the current database.` Restore, re-run, confirm green.

- [ ] **Step 12: Verify and commit**

```bash
pnpm verify
pnpm --filter @metrika/database test:integration
```

Expected: exit 0 from `pnpm verify`, and the integration suite green (14 tests).

```bash
git add packages/database
git commit -m "feat(database): add createPrismaClient with soft-delete and organization-context extensions"
```

---

### Task 8: The row-level-security backstop suite

RLS is the control that catches the query nobody reviewed. A security control without a fixture asserting rejection is an intention, not a control — so this task is entirely tests, and every one of them has a mutation that turns it red.

**Files:**

- Create: `packages/database/test/rls.integration.test.ts`
- Modify: none

**Interfaces:**

- Consumes: Tasks 5, 6, 7
- Produces: nothing new — this task proves what Tasks 5 and 7 built

- [ ] **Step 1: Write the suite**

`packages/database/test/rls.integration.test.ts`. These tests deliberately run with **no application-level `where` clause on `organizationId`**: the whole point of a backstop is that it works when the primary control has failed.

```ts
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, stopDatabase, withDatabase } from './support.js';
import { createPrismaClient, withOrganizationContext } from '../src/index.js';
import type { MetrikaPrismaClient } from '../src/index.js';

const ORG_A = randomUUID();
const ORG_B = randomUUID();

let ownerClient: MetrikaPrismaClient;

beforeAll(async () => {
  const handle = await startTestDatabase();
  // A second client on the OWNER role. Postgres exempts a table's owner from
  // its policies unless FORCE ROW LEVEL SECURITY is set, so this connection is
  // the only way to test that FORCE is actually in the migration.
  ownerClient = createPrismaClient({ databaseUrl: handle.adminUrl });

  await withDatabase(async (db) => {
    await withOrganizationContext(db, ORG_A, async (tx) => {
      await tx.rlsProbe.create({ data: { organizationId: ORG_A, label: 'belongs-to-a' } });
    });
    await withOrganizationContext(db, ORG_B, async (tx) => {
      await tx.rlsProbe.create({ data: { organizationId: ORG_B, label: 'belongs-to-b' } });
    });
  });
});

afterAll(async () => {
  await ownerClient.$disconnect();
  await stopDatabase();
});

describe('the application role cannot bypass RLS', () => {
  it('is neither a superuser nor BYPASSRLS', async () => {
    const [role] = await withDatabase(async (db) =>
      db.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
        SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
      `,
    );
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});

describe('tenant isolation, with the application check bypassed', () => {
  it('returns only org A rows for an unfiltered read in org A context', async () => {
    const labels = await withDatabase(async (db) =>
      withOrganizationContext(db, ORG_A, async (tx) =>
        (await tx.rlsProbe.findMany()).map((r) => r.label),
      ),
    );

    expect(labels).toEqual(['belongs-to-a']);
  });

  it('returns null for a findUnique on another organization row', async () => {
    const foreign = await withDatabase(async (db) =>
      withOrganizationContext(db, ORG_B, async (tx) =>
        tx.rlsProbe.findFirst({ where: { label: 'belongs-to-b' } }),
      ),
    );
    expect(foreign).not.toBeNull();

    const leaked = await withDatabase(async (db) =>
      withOrganizationContext(db, ORG_A, async (tx) =>
        tx.rlsProbe.findUnique({ where: { id: foreign?.id ?? '' } }),
      ),
    );

    expect(leaked).toBeNull();
  });

  it('cannot update another organization row', async () => {
    const foreign = await withDatabase(async (db) =>
      withOrganizationContext(db, ORG_B, async (tx) =>
        tx.rlsProbe.findFirst({ where: { label: 'belongs-to-b' } }),
      ),
    );

    const updated = await withDatabase(async (db) =>
      withOrganizationContext(db, ORG_A, async (tx) =>
        tx.rlsProbe.updateMany({
          where: { id: foreign?.id ?? '' },
          data: { label: 'stolen' },
        }),
      ),
    );

    expect(updated.count).toBe(0);
  });

  it('cannot insert a row stamped with another organization id — this is what WITH CHECK buys', async () => {
    await expect(
      withDatabase(async (db) =>
        withOrganizationContext(db, ORG_A, async (tx) =>
          tx.rlsProbe.create({ data: { organizationId: ORG_B, label: 'planted' } }),
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('sees nothing at all when no organization context is set — deny by default', async () => {
    const rows = await withDatabase(async (db) => db.rlsProbe.findMany());
    expect(rows).toEqual([]);
  });
});

describe('the table owner is not exempt', () => {
  it('returns nothing for an owner connection with no organization context', async () => {
    const rows = await ownerClient.rlsProbe.findMany();
    expect(rows).toEqual([]);
  });

  it('returns only the scoped rows for an owner connection inside a context', async () => {
    const labels = await withOrganizationContext(ownerClient, ORG_B, async (tx) =>
      (await tx.rlsProbe.findMany()).map((r) => r.label),
    );
    expect(labels).toEqual(['belongs-to-b']);
  });
});
```

- [ ] **Step 2: Run the suite**

```bash
pnpm --filter @metrika/database test:integration
```

Expected: PASS — 22 tests across three files: 4 harness, 10 soft-delete, 8 RLS (1 role assertion + 5 isolation + 2 owner).

- [ ] **Step 3: Measure how many containers a run actually starts**

The three integration files in this package share a single Postgres because `vitest.integration.config.ts` puts the container's lifecycle in `globalSetup`. That claim is cheap to check and expensive to be wrong about — a container per file means a `prisma migrate deploy` per file and a wall-clock number that CI timeouts get tuned against.

In one terminal:

```bash
pnpm --filter @metrika/database test:integration
```

In another, while it is running:

```bash
docker ps --filter "ancestor=postgres:16-alpine" --format '{{.ID}} {{.Status}}'
```

Expected: **exactly one line.** This half is a real assertion — `globalSetup` runs once per run by definition, so anything other than 1 here is a defect. Also note the total wall-clock time the Vitest run reports.

Then the measurement: delete the `globalSetup: ['./test/global-setup.ts'],` line from `packages/database/vitest.integration.config.ts` and repeat both commands.

Expected: **three lines** — one container per test file — and the suite still passes, because `startDatabase()`'s fallback starts a container of its own when no published URL is in `process.env`. This is a measured number, not a prediction: an equivalent three-file fixture under `fileParallelism: false` with the default `isolate: true` and no `globalSetup` started three containers on Docker 29.6.2 / Vitest 4.1.10, confirmed by three distinct container IDs, three `create` events in `docker events`, and three distinct forked worker PIDs. `fileParallelism: false` serialises the files but the default `isolate: true` still respawns a fresh fork per file, so the module-level `let container` in `packages/testing/src/database.ts` never survives a file boundary. Expect roughly triple the wall clock too, plus three `prisma migrate deploy` runs.

**The count is machine-dependent at the margins — record what you actually see.** Container start-up and image-cache warmth vary by host (a cold first container costs ~7 s here versus ~2.5 s warm), and on a runner with fewer available workers than test files Vitest's scheduling can reuse a fork and yield a lower count for reasons that have nothing to do with correctness. Two things do not vary and are the real assertions:

- **With `globalSetup`: exactly 1.** Anything else is a defect, on any machine. That guarantee is why the design is what it is — it holds independently of `pool`, `isolate` and `fileParallelism`, all of which a future config change can flip, and independently of how those two flags interact (measured: only `fileParallelism: false` **and** `isolate: false` _together_ share one fork; `isolate: false` alone measured three concurrent containers, which is worse).
- **Without `globalSetup`: more than 1.** If you somehow measure exactly 1 here, the wording in `packages/testing/src/database.ts`, `packages/testing/src/global-setup.ts` and the Global Constraints paragraph of this plan is describing your host wrongly — say so in the pull request rather than deleting `globalSetup`, which remains correct for the reason above.

Restore the `globalSetup` line, re-run, confirm the count is back to one.

- [ ] **Step 4: Mutation — remove `FORCE` and prove the owner tests catch it**

Edit `packages/database/prisma/migrations/<timestamp>_init/migration.sql` and delete the line:

```sql
ALTER TABLE "RlsProbe" FORCE ROW LEVEL SECURITY;
```

Run: `pnpm --filter @metrika/database test:integration && pnpm --filter @metrika/database test:unit`
Expected: **RED, three times.** Both tests under `the table owner is not exempt` fail — the first returns two rows instead of none, the second returns `['belongs-to-a', 'belongs-to-b']` — and `test:unit`'s `FORCES row-level security, so the table owner is not exempt` (Task 5) fails without needing Docker at all. Note carefully that **every other RLS test stays green**, because they connect as `metrika_app`, which is not the owner. That asymmetry is exactly why the owner-connection tests exist: without them, dropping `FORCE` is an invisible change that leaves a full suite passing while a `psql` session and every migration script read across tenants.

Restore the line, re-run, confirm green.

- [ ] **Step 5: Mutation — remove `WITH CHECK` and prove the insert test catches it**

In the same migration, replace the policy with a `USING`-only version:

```sql
CREATE POLICY "RlsProbe_tenant_isolation" ON "RlsProbe"
  USING ("organizationId" = app_current_org_id());
```

Run: `pnpm --filter @metrika/database test:integration`
Expected: **RED.** `cannot insert a row stamped with another organization id` fails — the insert succeeds. The planted row is then invisible to both organizations, which is the quiet data-corruption path a `USING`-only policy leaves open, and which the blueprint's own example SQL in [DOMAIN_MODEL.md §6](../../DOMAIN_MODEL.md#6-prisma-schema-design) does not close.

Restore the `WITH CHECK` clause, re-run, confirm green. (`pnpm --filter @metrika/database test:unit` goes red here too, on `constrains writes as well as reads`.)

- [ ] **Step 6: Mutation — grant BYPASSRLS and prove the role assertion catches it**

In `packages/database/sql/00-app-role.sql`, change the role definition:

```sql
      NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
```

Run: `pnpm --filter @metrika/database test:integration`
Expected: **RED, four or more times** — `is neither a superuser nor BYPASSRLS` fails outright (in both `harness.integration.test.ts` and `rls.integration.test.ts`), and every isolation test starts returning both organizations' rows. That single attribute is enough to silently disable the entire backstop.

Restore `NOBYPASSRLS`, re-run, confirm green.

- [ ] **Step 7: Confirm the migration is reproducible from scratch**

The mutations above edited an applied migration. Prove the committed SQL is what a fresh database gets:

```bash
pnpm infra:reset && pnpm infra:up
pnpm db:deploy
pnpm --filter @metrika/database test:integration
```

Expected: `migrate deploy` applies one migration cleanly; the suite is green. `git status --short` shows no modification under `prisma/migrations/`.

- [ ] **Step 8: Verify and commit**

```bash
pnpm verify
```

Expected: exit 0.

```bash
git add packages/database/test
git commit -m "test(database): assert tenant isolation, FORCE RLS and the non-bypassing app role"
```

---

### Task 9a: `apps/api` scaffold and the Zod-validated environment

ROADMAP 0.7, first half — part one of two. This task ends with a package that installs, builds, lints, type-checks and has a green unit suite, and with nothing that needs Docker. Task 9b adds the module tree.

**Files:**

- Create: `apps/api/package.json`, `tsconfig.json`, `tsconfig.build.json`, `eslint.config.js`, `vitest.config.ts`, `src/config/env.ts`, `src/config/env.service.ts`, `src/config/config.module.ts`
- Modify: `package.json` (root — the `concurrently` devDependency)
- Test: `apps/api/test/env.test.ts`, `apps/api/test/env-example.test.ts`

**Interfaces:**

- Consumes: Tasks 1, 2, 3, 4
- Produces:
  - `EnvSchema` / `type Env` / `parseEnv(source: Record<string, string | undefined>): Env` / `class EnvValidationError`
  - `EnvService` — `readonly values: Env`, provided by `ConfigModule` through `useFactory`
  - `ConfigModule` — `@Global()`

- [ ] **Step 1: Write the failing env tests**

`apps/api/test/env.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseEnv } from '../src/config/env.js';

const VALID = {
  DATABASE_URL: 'postgresql://metrika_app:metrika_app@localhost:5432/metrika_dev?schema=public',
  HEALTH_DEEP_TOKEN: 'local-health-deep-token',
} as const;

describe('parseEnv', () => {
  it('applies defaults for the optional keys', () => {
    const env = parseEnv({ ...VALID });
    expect(env.NODE_ENV).toBe('development');
    expect(env.API_PORT).toBe(3001);
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('coerces API_PORT from its string form', () => {
    expect(parseEnv({ ...VALID, API_PORT: '4100' }).API_PORT).toBe(4100);
  });

  it('rejects a missing DATABASE_URL and names it', () => {
    const { HEALTH_DEEP_TOKEN } = VALID;
    expect(() => parseEnv({ HEALTH_DEEP_TOKEN })).toThrow(EnvValidationError);
    expect(() => parseEnv({ HEALTH_DEEP_TOKEN })).toThrow(/DATABASE_URL/);
  });

  it('rejects a DATABASE_URL that is not postgresql://', () => {
    expect(() => parseEnv({ ...VALID, DATABASE_URL: 'mysql://x/y' })).toThrow(/DATABASE_URL/);
  });

  it('rejects a short HEALTH_DEEP_TOKEN — it guards a diagnostic endpoint', () => {
    expect(() => parseEnv({ ...VALID, HEALTH_DEEP_TOKEN: 'short' })).toThrow(/HEALTH_DEEP_TOKEN/);
  });

  it('rejects an out-of-range port', () => {
    expect(() => parseEnv({ ...VALID, API_PORT: '70000' })).toThrow(/API_PORT/);
  });

  it('lists every problem at once rather than the first', () => {
    const message = (() => {
      try {
        parseEnv({ DATABASE_URL: 'mysql://x/y' });
        return '';
      } catch (error: unknown) {
        return error instanceof Error ? error.message : '';
      }
    })();

    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('HEALTH_DEEP_TOKEN');
  });
});
```

`apps/api/test/env-example.test.ts` — the gate [LOCAL_DEVELOPMENT.md §8](../../LOCAL_DEVELOPMENT.md#8-environment-configuration) promises, so a fresh clone can never fail with an unexplained missing variable:

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

function readEnvExample(): Record<string, string> {
  const raw = readFileSync(path.join(repoRoot, '.env.example'), 'utf8');
  const entries: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    entries[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return entries;
}

describe('.env.example', () => {
  it('parses at least one key, so a broken reader cannot make this test vacuous', () => {
    expect(Object.keys(readEnvExample()).length).toBeGreaterThan(5);
  });

  it('satisfies every requirement of the API env schema', () => {
    expect(() => parseEnv(readEnvExample())).not.toThrow();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @metrika/api test:unit`
Expected: FAIL — the package does not exist.

- [ ] **Step 3: Write the env module**

`apps/api/src/config/env.ts` — the only `process.env` reader in the API:

```ts
import { z } from 'zod';

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z
    .string()
    .regex(/^postgresql:\/\//, 'must be a postgresql:// connection string'),
  HEALTH_DEEP_TOKEN: z.string().min(16, 'must be at least 16 characters'),
});

export type Env = z.infer<typeof EnvSchema>;

export class EnvValidationError extends Error {
  constructor(issues: readonly z.core.$ZodIssue[]) {
    super(
      [
        'Environment configuration is invalid. Every problem, not just the first:',
        ...issues.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`),
        '',
        'Copy .env.example to .env and fill in the values it names.',
      ].join('\n'),
    );
    this.name = 'EnvValidationError';
  }
}

/**
 * Pure, so it can be unit-tested without touching the ambient environment.
 * Crashing at startup with a readable list beats a mysterious `undefined`
 * three layers into a request.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(result.error.issues);
  }
  return result.data;
}

export function loadEnv(): Env {
  return parseEnv(process.env);
}
```

`apps/api/src/config/env.service.ts`:

```ts
import type { Env } from './env.js';

/**
 * Deliberately NOT decorated with @Injectable(): ConfigModule provides it
 * through `useFactory`, so Nest never resolves its constructor parameters. A
 * class token with a factory is the simplest thing that gives the rest of the
 * app a single injectable handle on validated configuration.
 */
export class EnvService {
  constructor(readonly values: Env) {}
}
```

`apps/api/src/config/config.module.ts`:

```ts
import { Global, Module } from '@nestjs/common';
import { loadEnv } from './env.js';
import { EnvService } from './env.service.js';

@Global()
@Module({
  providers: [
    {
      provide: EnvService,
      useFactory: (): EnvService => new EnvService(loadEnv()),
    },
  ],
  exports: [EnvService],
})
export class ConfigModule {}
```

- [ ] **Step 4: Package, tsconfig and lint files**

`apps/api/package.json`:

```json
{
  "name": "@metrika/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -b tsconfig.build.json",
    "typecheck": "tsc -b",
    "lint": "eslint .",
    "start": "node --env-file=../../.env dist/main.js",
    "dev": "concurrently --kill-others --names tsc,api \"tsc -b tsconfig.build.json --watch --preserveWatchOutput\" \"node --watch --env-file=../../.env dist/main.js\"",
    "test:unit": "vitest run --config vitest.config.ts"
  },
  "dependencies": {
    "@metrika/contracts": "workspace:*",
    "@metrika/database": "workspace:*",
    "@nestjs/common": "11.1.28",
    "@nestjs/core": "11.1.28",
    "@nestjs/platform-fastify": "11.1.28",
    "fastify": "5.6.1",
    "reflect-metadata": "0.2.2",
    "rxjs": "7.8.2",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@metrika/eslint-config": "workspace:*",
    "@metrika/testing": "workspace:*",
    "@metrika/typescript-config": "workspace:*",
    "@types/node": "24.13.3",
    "eslint": "10.8.0",
    "typescript": "6.0.3",
    "vitest": "4.1.10"
  }
}
```

`test:integration` and its config land in Task 9b, with the first integration test. Declaring the script now would make `vitest run` exit 1 on an empty file set and `pnpm verify` red for the whole of this task.

`apps/api/tsconfig.json`:

```json
{
  "extends": "@metrika/typescript-config/nest.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"]
}
```

Task 9b adds `"vitest.integration.config.ts"` to this `include`.

`apps/api/tsconfig.build.json`:

```json
{
  "extends": "@metrika/typescript-config/nest.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "tsBuildInfoFile": "tsconfig.build.tsbuildinfo"
  },
  "include": ["src/**/*.ts"]
}
```

`apps/api/eslint.config.js`:

```js
import { nest, prismaBoundary } from '@metrika/eslint-config';

export default [
  ...nest({ tsconfigRootDir: import.meta.dirname, project: './tsconfig.json' }),
  ...prismaBoundary,
  {
    // The one sanctioned process.env reader, per CLAUDE.md. Everything else in
    // the app takes configuration through EnvService.
    files: ['src/config/env.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  {
    // Integration tests must inject the Testcontainers URL into the ambient
    // environment before the app boots — that is what makes them exercise the
    // real bootstrap rather than a hand-built module graph.
    files: ['test/**/*.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  { ignores: ['dist/**', 'coverage/**', 'openapi/**'] },
];
```

`apps/api/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.integration.test.ts'],
  },
});
```

- [ ] **Step 5: Install, verify the pins landed bare, and re-check the consent list**

```bash
pnpm --filter @metrika/api add --save-exact @nestjs/common@11.1.28 @nestjs/core@11.1.28 @nestjs/platform-fastify@11.1.28 fastify@5.6.1 reflect-metadata@0.2.2 rxjs@7.8.2 zod@4.4.3
pnpm --filter @metrika/api add --save-exact @metrika/contracts@workspace:* @metrika/database@workspace:*
pnpm --filter @metrika/api add --save-dev --save-exact typescript@6.0.3 vitest@4.1.10 eslint@10.8.0 @types/node@24.13.3
pnpm --filter @metrika/api add --save-dev --save-exact @metrika/eslint-config@workspace:* @metrika/typescript-config@workspace:* @metrika/testing@workspace:*
pnpm add --workspace-root --save-dev --save-exact concurrently@10.0.4
```

`concurrently` is pinned to the version in this plan's Global Constraints table, not resolved from `latest`. Every other version in this repository is pinned; a dev-only tool is not an exception, and "write down whatever you got" is how a table stops describing reality.

Check the install output for peer warnings (`grep -i 'peer'`) and add anything it names with `--save-exact`. Then confirm no caret survived:

```bash
grep -nE '"(@nestjs/|fastify|reflect-metadata|rxjs|zod|typescript|vitest|eslint)' apps/api/package.json
grep -n '"concurrently"' package.json
```

Expected: every value bare, and `"concurrently": "10.0.4"`.

`concurrently` and the `@nestjs/*` tree pull install scripts of their own, so re-check the consent list from scratch — `ERR_PNPM_IGNORED_BUILDS` exits 1 and fails CI on the first clean install, not on this incremental one:

```bash
rm -rf node_modules && pnpm install
echo "EXIT=$?"
```

Expected: `EXIT=0`, no `ERR_PNPM_IGNORED_BUILDS`. If it names a package, add it to `allowBuilds` in `pnpm-workspace.yaml` and repeat until clean.

- [ ] **Step 6: Run the unit suite**

```bash
pnpm build
pnpm --filter @metrika/api test:unit
```

Expected: PASS, 9 tests (7 `parseEnv` + 2 `.env.example`).

- [ ] **Step 7: Mutation — prove `.env.example` is genuinely checked**

Delete the `HEALTH_DEEP_TOKEN` line from `.env.example`.

Run: `pnpm --filter @metrika/api test:unit`
Expected: **RED.** `satisfies every requirement of the API env schema` fails. Restore the line, re-run, confirm green.

- [ ] **Step 8: Verify and commit**

```bash
pnpm verify
```

Expected: exit 0.

```bash
git add apps/api package.json pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "feat(api): add the api package with a zod-validated environment"
```

---

### Task 9b: the API module tree — persistence, health, bootstrap, and a boot test that catches DI

ROADMAP 0.7, first half — part two of two.

**Files:**

- Create: `apps/api/src/infrastructure/persistence/prisma.service.ts`, `persistence.module.ts`, `apps/api/src/modules/health/health.controller.ts`, `health.module.ts`, `apps/api/src/app.module.ts`, `apps/api/src/bootstrap.ts`, `apps/api/src/main.ts`, `apps/api/vitest.integration.config.ts`, `apps/api/test/database-root.ts`, `apps/api/test/support.ts`, `apps/api/test/global-setup.ts`
- Modify: `apps/api/package.json` (add `test:integration`), `apps/api/tsconfig.json` (add `vitest.integration.config.ts` to `include`)
- Test: `apps/api/test/boot.integration.test.ts`

**Interfaces:**

- Consumes: Tasks 5, 6, 7, 9a
- Produces:
  - `PrismaService` — `@Injectable()`, `readonly client: MetrikaPrismaClient`, `OnModuleInit`/`OnModuleDestroy`
  - `createApiApp(): Promise<NestFastifyApplication>` in `src/bootstrap.ts` — used by `main.ts` **and** by every integration test, so tests boot the real module tree
  - `apps/api/test/support.ts` — `startTestDatabase()`, `stopDatabase`, and `bootApiForTest()`, the one boot fixture every API integration suite uses
  - `GET /health/live` → `200 { "status": "ok", "environment": … }`

- [ ] **Step 1: Write the persistence layer and the first controller**

`apps/api/src/infrastructure/persistence/prisma.service.ts` — the only file in the API allowed to name `@metrika/database`:

```ts
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createPrismaClient, type MetrikaPrismaClient } from '@metrika/database';
import { EnvService } from '../../config/env.service.js';

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly client: MetrikaPrismaClient;

  // `EnvService` is imported as a VALUE, not with `import type`. An
  // `import type` here erases the binding that emitDecoratorMetadata writes
  // into design:paramtypes; Nest then reads the global `Function`, cannot
  // resolve it, and throws UnknownDependenciesException at boot. tsc reports
  // nothing and eslint reports nothing. test/boot.integration.test.ts is the
  // only thing that catches it. See the Global Constraints of Plan 0B-1.
  constructor(private readonly config: EnvService) {
    this.client = createPrismaClient({ databaseUrl: this.config.values.DATABASE_URL });
  }

  async onModuleInit(): Promise<void> {
    await this.client.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
```

`apps/api/src/infrastructure/persistence/persistence.module.ts`:

```ts
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PersistenceModule {}
```

`apps/api/src/modules/health/health.controller.ts` — `/health/live` only for now; `ready` and `deep` arrive in Task 12a with their Zod DTOs:

```ts
import { Controller, Get } from '@nestjs/common';
import { EnvService } from '../../config/env.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly config: EnvService) {}

  /**
   * Liveness must never check a dependency. A liveness probe that fails
   * because Redis is slow makes ECS kill healthy tasks and turns a degradation
   * into an outage. See docs/OBSERVABILITY.md §7 (Health checks).
   */
  @Get('live')
  live(): { status: 'ok'; environment: string } {
    return { status: 'ok', environment: this.config.values.NODE_ENV };
  }
}
```

`apps/api/src/modules/health/health.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';

@Module({ controllers: [HealthController] })
export class HealthModule {}
```

`apps/api/src/app.module.ts` — composition root only, no logic:

```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { PersistenceModule } from './infrastructure/persistence/persistence.module.js';
import { HealthModule } from './modules/health/health.module.js';

@Module({ imports: [ConfigModule, PersistenceModule, HealthModule] })
export class AppModule {}
```

- [ ] **Step 2: Write the bootstrap, shared by `main.ts` and the tests**

`apps/api/src/bootstrap.ts`:

```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';

export const API_PREFIX = 'api/v1';

/**
 * One bootstrap, used by main.ts and by every integration test. Tests that
 * construct their own module graph cannot catch a wiring mistake in the real
 * one, and wiring mistakes are the defect class this app is most exposed to.
 */
export async function createApiApp(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  app.setGlobalPrefix(API_PREFIX, { exclude: ['health/live', 'health/ready', 'health/deep'] });
  app.enableShutdownHooks();
  return app;
}
```

`apps/api/src/main.ts`:

```ts
import { createApiApp } from './bootstrap.js';
import { EnvService } from './config/env.service.js';

async function main(): Promise<void> {
  const app = await createApiApp();
  const { values } = app.get(EnvService);
  await app.listen({ port: values.API_PORT, host: '0.0.0.0' });
}

await main();
```

- [ ] **Step 3: Write the shared test support and the Vitest integration wiring**

Four integration suites in this app need the same six lines of setup. They get one function instead, so a change to the fixture is a change in one place and no suite can drift from the others.

`apps/api/test/database-root.ts`:

```ts
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

/**
 * packages/database's own directory, found through Node's resolver rather than
 * by walking `..`. It holds the `sql/` and `prisma/` the Testcontainers harness
 * needs, and @metrika/testing takes it as an option because it must not depend
 * on @metrika/database itself.
 *
 * The subpath resolves only because `@metrika/database`'s `exports` map
 * declares `"./package.json"`. An `exports` map is a closed allow-list: Node
 * answers every unlisted subpath with ERR_PACKAGE_PATH_NOT_EXPORTED.
 *
 * This is `require.resolve` of a JSON file, not an `import` of the module, so
 * it does not cross `prismaImportBoundary` — apps/api may only *import*
 * @metrika/database from src/infrastructure/persistence/**.
 */
export const DATABASE_PACKAGE_ROOT = path.dirname(
  require.resolve('@metrika/database/package.json'),
);
```

`apps/api/test/global-setup.ts`:

```ts
import { createDatabaseGlobalSetup } from '@metrika/testing';
import { DATABASE_PACKAGE_ROOT } from './database-root.js';

export default createDatabaseGlobalSetup({ databasePackageRoot: DATABASE_PACKAGE_ROOT });
```

`apps/api/test/support.ts`:

```ts
import { startDatabase, type DatabaseHandle } from '@metrika/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApiApp } from '../src/bootstrap.js';
import { DATABASE_PACKAGE_ROOT } from './database-root.js';

export { stopDatabase } from '@metrika/testing';

export const TEST_HEALTH_DEEP_TOKEN = 'integration-health-deep-token';

export async function startTestDatabase(): Promise<DatabaseHandle> {
  return startDatabase({ databasePackageRoot: DATABASE_PACKAGE_ROOT });
}

export interface BootedApi {
  readonly app: NestFastifyApplication;
  readonly baseUrl: string;
}

/**
 * Boots the REAL bootstrap against the shared test database and listens on an
 * ephemeral port. Every API integration suite uses this; a suite that builds
 * its own module graph cannot catch a wiring mistake in the real one, and
 * wiring mistakes are the defect class this app is most exposed to.
 */
export async function bootApiForTest(): Promise<BootedApi> {
  const handle = await startTestDatabase();
  process.env.DATABASE_URL = handle.applicationUrl;
  process.env.HEALTH_DEEP_TOKEN = TEST_HEALTH_DEEP_TOKEN;
  process.env.NODE_ENV = 'test';

  const app = await createApiApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, baseUrl: await app.getUrl() };
}
```

`apps/api/vitest.integration.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    // One container for the whole run — see the comment in
    // packages/testing/vitest.integration.config.ts (including the measured
    // per-file container count without globalSetup, and why `poolOptions`
    // must not be added back: it was removed in Vitest 4 and breaks
    // `pnpm typecheck`).
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
```

Add the script to `apps/api/package.json`:

```json
    "test:integration": "vitest run --config vitest.integration.config.ts",
```

and add `"vitest.integration.config.ts"` to `apps/api/tsconfig.json`'s `include`.

- [ ] **Step 4: Write the boot integration test**

`apps/api/test/boot.integration.test.ts` — the only net for the `import type` DI break:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { bootApiForTest, stopDatabase } from './support.js';
import { EnvService } from '../src/config/env.service.js';
import { PrismaService } from '../src/infrastructure/persistence/prisma.service.js';

let app: NestFastifyApplication;
let baseUrl: string;

beforeAll(async () => {
  ({ app, baseUrl } = await bootApiForTest());
});

afterAll(async () => {
  await app.close();
  await stopDatabase();
});

describe('application boot', () => {
  it('resolves every provider in the real module tree', () => {
    // Constructing the graph is what proves DI: a provider whose constructor
    // parameter type was erased by an `import type` throws
    // UnknownDependenciesException before this line is ever reached.
    expect(app.get(EnvService)).toBeInstanceOf(EnvService);
    expect(app.get(PrismaService)).toBeInstanceOf(PrismaService);
  });

  it('gives PrismaService a working client, not just a resolved token', async () => {
    const prisma = app.get(PrismaService);
    const rows = await prisma.client.$queryRaw<{ one: number }[]>`SELECT 1 AS one`;
    expect(rows[0]?.one).toBe(1);
  });

  it('serves GET /health/live over a real socket', async () => {
    const response = await fetch(`${baseUrl}/health/live`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', environment: 'test' });
  });

  it('does not prefix the health routes — probes must not track the API version', async () => {
    const prefixed = await fetch(`${baseUrl}/api/v1/health/live`);
    expect(prefixed.status).toBe(404);
  });
});
```

- [ ] **Step 5: Run everything**

```bash
pnpm build
pnpm --filter @metrika/api test:unit
pnpm --filter @metrika/api test:integration
```

Expected: 9 unit tests and 4 integration tests pass.

- [ ] **Step 6: Mutation — prove the boot test catches the DI footgun**

In `apps/api/src/infrastructure/persistence/prisma.service.ts`, change the `EnvService` import to a type-only import:

```ts
import type { EnvService } from '../../config/env.service.js';
```

First confirm the silence:

```bash
pnpm --filter @metrika/api typecheck && pnpm --filter @metrika/api lint
```

Expected: **both exit 0.** No error, no warning. This is the point.

Then:

```bash
pnpm --filter @metrika/api test:integration
```

Expected: **RED.** `beforeAll` fails with `UnknownDependenciesException: Nest can't resolve dependencies of the PrismaService (?). Please make sure that the argument Function at index [0] is available in the PersistenceModule context.`

Restore the value import, re-run all three, confirm green.

- [ ] **Step 7: Run the API by hand once**

```bash
cp .env.example .env
pnpm infra:up
pnpm db:deploy
pnpm build
pnpm --filter @metrika/api start &
sleep 2
curl -s -i http://localhost:3001/health/live
kill %1
```

Expected: `HTTP/1.1 200 OK` and `{"status":"ok","environment":"development"}`.

- [ ] **Step 8: Verify and commit**

```bash
pnpm verify
```

Expected: exit 0.

```bash
git add apps/api
git commit -m "feat(api): add nest on fastify module tree with a DI boot test"
```

---

### Task 10: Request context and the correlation ID

ROADMAP 0.7's request-context middleware. The OTel exporters and the Pino redaction list are 0.11 and land in Plan 0C — but the **ID** has to exist now, because the exception filter in Task 11 puts it in every error body and retrofitting it means touching every log call.

**Files:**

- Create: `apps/api/src/shared/request-context/request-context.ts`, `request-context.middleware.ts`, `request-context.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/request-context.test.ts`, `apps/api/test/request-context.integration.test.ts`

**Interfaces:**

- Consumes: Task 9b
- Produces:
  - `interface RequestContext { readonly requestId: string }`
  - `runWithRequestContext<T>(context: RequestContext, fn: () => T): T`
  - `getRequestContext(): RequestContext | undefined`
  - `getRequestId(): string` — `'unknown'` outside a request, never throws
  - `normaliseRequestId(header: unknown): string` — echoes a well-formed client value, otherwise mints a UUID
  - `RequestContextMiddleware` applied to `'{*splat}'`

- [ ] **Step 1: Write the failing tests**

`apps/api/test/request-context.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  getRequestContext,
  getRequestId,
  normaliseRequestId,
  runWithRequestContext,
} from '../src/shared/request-context/request-context.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('normaliseRequestId', () => {
  it('echoes a well-formed client-supplied id', () => {
    expect(normaliseRequestId('req-abc_123.4')).toBe('req-abc_123.4');
  });

  it('mints a UUID when the header is absent', () => {
    expect(normaliseRequestId(undefined)).toMatch(UUID);
  });

  it('mints a UUID when the header is an array — a duplicated header is not a value', () => {
    expect(normaliseRequestId(['a', 'b'])).toMatch(UUID);
  });

  it('rejects a value with characters that could forge a log line', () => {
    expect(normaliseRequestId('abc\ndef')).toMatch(UUID);
  });

  it('rejects an over-long value rather than truncating it', () => {
    expect(normaliseRequestId('x'.repeat(200))).toMatch(UUID);
  });

  it('rejects an empty string', () => {
    expect(normaliseRequestId('')).toMatch(UUID);
  });

  it('mints a different id on each call', () => {
    expect(normaliseRequestId(undefined)).not.toBe(normaliseRequestId(undefined));
  });
});

describe('request context storage', () => {
  it('exposes the id inside the scope', () => {
    runWithRequestContext({ requestId: 'inside' }, () => {
      expect(getRequestId()).toBe('inside');
    });
  });

  it('is undefined outside any scope', () => {
    expect(getRequestContext()).toBeUndefined();
  });

  it('reports "unknown" outside a scope rather than throwing — an error path must never fail on logging', () => {
    expect(getRequestId()).toBe('unknown');
  });

  it('does not leak out of the scope', () => {
    runWithRequestContext({ requestId: 'inside' }, () => getRequestId());
    expect(getRequestContext()).toBeUndefined();
  });

  it('survives an await boundary', async () => {
    await runWithRequestContext({ requestId: 'async-scope' }, async () => {
      await Promise.resolve();
      expect(getRequestId()).toBe('async-scope');
    });
  });

  it('keeps concurrent scopes separate', async () => {
    const seen = await Promise.all([
      runWithRequestContext({ requestId: 'a' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return getRequestId();
      }),
      runWithRequestContext({ requestId: 'b' }, async () => getRequestId()),
    ]);

    expect(seen).toEqual(['a', 'b']);
  });
});
```

`apps/api/test/request-context.integration.test.ts` — boots the real app through the shared fixture from Task 9b rather than assembling a second one:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { bootApiForTest, stopDatabase } from './support.js';

let app: NestFastifyApplication;
let baseUrl: string;

beforeAll(async () => {
  ({ app, baseUrl } = await bootApiForTest());
});

afterAll(async () => {
  await app.close();
  await stopDatabase();
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('X-Request-Id', () => {
  it('echoes a client-supplied id', async () => {
    const response = await fetch(`${baseUrl}/health/live`, {
      headers: { 'x-request-id': 'client-supplied-id' },
    });
    expect(response.headers.get('x-request-id')).toBe('client-supplied-id');
  });

  it('generates one when the client sends none', async () => {
    const response = await fetch(`${baseUrl}/health/live`);
    expect(response.headers.get('x-request-id')).toMatch(UUID);
  });

  it('generates a different one per request', async () => {
    const [first, second] = await Promise.all([
      fetch(`${baseUrl}/health/live`),
      fetch(`${baseUrl}/health/live`),
    ]);
    expect(first.headers.get('x-request-id')).not.toBe(second.headers.get('x-request-id'));
  });

  it('replaces a hostile id rather than echoing it', async () => {
    const response = await fetch(`${baseUrl}/health/live`, {
      headers: { 'x-request-id': 'a'.repeat(500) },
    });
    expect(response.headers.get('x-request-id')).toMatch(UUID);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @metrika/api test:unit -- request-context`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the storage**

`apps/api/src/shared/request-context/request-context.ts`:

```ts
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  readonly requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Never throws and never returns undefined. The exception filter calls this
 * while already handling a failure; a logging helper that can itself fail on
 * the error path turns a handled 422 into an unhandled crash.
 */
export function getRequestId(): string {
  return storage.getStore()?.requestId ?? 'unknown';
}

/**
 * A client MAY supply X-Request-Id, so it is untrusted input that ends up in
 * logs and in error bodies. Anything outside this narrow character class is
 * replaced rather than sanitised: a newline in a log line is a forged log
 * entry, and truncating an over-long value would let a client collide with
 * somebody else's prefix.
 */
const ACCEPTABLE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function normaliseRequestId(header: unknown): string {
  if (typeof header === 'string' && ACCEPTABLE_REQUEST_ID.test(header)) {
    return header;
  }
  return randomUUID();
}
```

- [ ] **Step 4: Write the middleware**

`apps/api/src/shared/request-context/request-context.middleware.ts`:

```ts
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { normaliseRequestId, runWithRequestContext } from './request-context.js';

export const REQUEST_ID_HEADER = 'x-request-id';

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: FastifyRequest['raw'], response: FastifyReply['raw'], next: () => void): void {
    const requestId = normaliseRequestId(request.headers[REQUEST_ID_HEADER]);
    // Set before next(): the header has to be on the response even when the
    // handler throws, and an exception filter runs after the headers object
    // has already been handed to Fastify.
    response.setHeader(REQUEST_ID_HEADER, requestId);
    runWithRequestContext({ requestId }, next);
  }
}
```

**If anything is ever added here that needs the request path, read `request.originalUrl`, not `request.url`.** Nest's Fastify adapter runs wildcard-mounted middleware through its bundled `middie` clone, which rewrites `req.url` to be relative to the wildcard match for the duration of the middleware call and restores it afterwards — so inside a `'{*splat}'` middleware `req.url` reads `/` for every request, on every route. Verified against `@nestjs/platform-fastify@11.1.28`. A request-context middleware is the single most likely place for that to be stamped into a log line, where it would be silently wrong on every entry.

`apps/api/src/shared/request-context/request-context.module.ts`:

```ts
import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { RequestContextMiddleware } from './request-context.middleware.js';

@Module({})
export class RequestContextModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Braced named wildcard. Verified against @nestjs/platform-fastify@11.1.28
    // with path-to-regexp@8.4.2:
    //
    //   '{*splat}'  matches '/' AND every nested path.        <- what we want
    //   '*splat'    starts cleanly and SILENTLY never matches the bare '/'.
    //   '*'         also works, but only because an undocumented
    //               LegacyRouteConverter inside the Fastify adapter rewrites it
    //               to '{*path}' and deliberately suppresses the deprecation
    //               warning. That is an internal compatibility shim, not a
    //               contract, and it can be tightened in any Nest minor.
    consumer.apply(RequestContextMiddleware).forRoutes('{*splat}');
  }
}
```

Register it first in `apps/api/src/app.module.ts` — middleware ordering follows import order, and nothing downstream may run without a request id:

```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { PersistenceModule } from './infrastructure/persistence/persistence.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { RequestContextModule } from './shared/request-context/request-context.module.js';

@Module({ imports: [RequestContextModule, ConfigModule, PersistenceModule, HealthModule] })
export class AppModule {}
```

- [ ] **Step 5: Run the tests and watch them pass**

```bash
pnpm --filter @metrika/api test:unit
pnpm --filter @metrika/api test:integration
```

Expected: PASS.

- [ ] **Step 6: Mutation — prove the hostile-input test is not decorative**

Widen the pattern so anything is accepted:

```ts
const ACCEPTABLE_REQUEST_ID = /^.*$/;
```

Run: `pnpm --filter @metrika/api test:unit -- request-context`
Expected: **RED, four times** — the array case, the newline case, the over-long case and the empty-string case all fail. Restore.

- [ ] **Step 7: Mutation — prove the echo is real**

In the middleware, always mint:

```ts
    const requestId = normaliseRequestId(undefined);
```

Run: `pnpm --filter @metrika/api test:integration -- request-context`
Expected: **RED.** `echoes a client-supplied id` fails. Restore.

- [ ] **Step 8: Verify and commit**

```bash
pnpm verify
```

Expected: exit 0.

```bash
git add apps/api
git commit -m "feat(api): add async-local request context and X-Request-Id propagation"
```

---

### Task 11: The exception filter, the exhaustive error map, and the Money request boundary

ROADMAP 0.7's exception filter. Closes carryover items **9** and **10**.

**Files:**

- Create: `apps/api/src/shared/errors/domain-error.ts`, `error-mapping.ts`, `domain-exception.filter.ts`, `apps/api/src/shared/http/money-request.schema.ts`
- Modify: `packages/contracts/src/errors.ts`, `apps/api/src/bootstrap.ts`
- Test: `apps/api/test/error-mapping.test.ts`, `apps/api/test/money-request.test.ts`, `apps/api/test/error-filter.integration.test.ts`

**Interfaces:**

- Consumes: Tasks 9b, 10
- Produces:
  - `DomainErrorCode` gains `ORDER_NOT_FOUND`
  - `class DomainError extends Error` — `readonly code: DomainErrorCode`, `readonly details?: Readonly<Record<string, unknown>>`
  - `DOMAIN_ERROR_RESPONSE: Readonly<Record<DomainErrorCode, { readonly status: number; readonly retryable: boolean }>>`
  - `DomainExceptionFilter` registered globally
  - `MoneyRequest` — `Money` refined so `exponent` must match `CURRENCY_REGISTRY`

- [ ] **Step 1: Write the failing tests**

`apps/api/test/error-mapping.test.ts`:

```ts
import { DomainErrorCode } from '@metrika/contracts';
import { describe, expect, it } from 'vitest';
import { DOMAIN_ERROR_RESPONSE } from '../src/shared/errors/error-mapping.js';

describe('DOMAIN_ERROR_RESPONSE', () => {
  it('covers every code in the closed union', () => {
    const mapped = Object.keys(DOMAIN_ERROR_RESPONSE).sort();
    const declared = [...DomainErrorCode.options].sort();
    expect(mapped).toEqual(declared);
  });

  it('maps no known domain failure to 500 except INTERNAL_ERROR', () => {
    const fiveHundreds = Object.entries(DOMAIN_ERROR_RESPONSE)
      .filter(([, value]) => value.status === 500)
      .map(([code]) => code);
    expect(fiveHundreds).toEqual(['INTERNAL_ERROR']);
  });

  it('uses only statuses the contract documents', () => {
    const allowed = new Set([400, 401, 403, 404, 409, 410, 413, 422, 429, 500, 502]);
    for (const [code, value] of Object.entries(DOMAIN_ERROR_RESPONSE)) {
      expect(allowed.has(value.status), `${code} → ${String(value.status)}`).toBe(true);
    }
  });

  it('marks exactly the upstream and throttling failures retryable', () => {
    const retryable = Object.entries(DOMAIN_ERROR_RESPONSE)
      .filter(([, value]) => value.retryable)
      .map(([code]) => code)
      .sort();

    expect(retryable).toEqual(
      [
        'GEOMETRY_ANALYSIS_FAILED',
        'PAYMENT_VERIFICATION_FAILED',
        'QUOTA_EXCEEDED',
        'RATE_LIMITED',
        'SLICING_FAILED',
      ].sort(),
    );
  });

  it('maps the codes the contract table pins, exactly', () => {
    expect(DOMAIN_ERROR_RESPONSE.QUOTE_EXPIRED.status).toBe(410);
    expect(DOMAIN_ERROR_RESPONSE.UNITS_NOT_CONFIRMED.status).toBe(422);
    expect(DOMAIN_ERROR_RESPONSE.FILE_TOO_LARGE.status).toBe(413);
    expect(DOMAIN_ERROR_RESPONSE.IDEMPOTENCY_KEY_REUSED.status).toBe(409);
    expect(DOMAIN_ERROR_RESPONSE.ORDER_NOT_FOUND.status).toBe(404);
  });
});
```

`apps/api/test/money-request.test.ts` — carryover 9:

```ts
import { describe, expect, it } from 'vitest';
import { MoneyRequest } from '../src/shared/http/money-request.schema.js';

describe('MoneyRequest', () => {
  it('accepts COP at exponent 0, as Colombian commerce uses it', () => {
    expect(
      MoneyRequest.safeParse({ amountMinor: '350000', currency: 'COP', exponent: 0 }).success,
    ).toBe(true);
  });

  it('rejects COP at exponent 2 — ISO 4217 says two, the registry says nought, and $3,500.00 is wrong', () => {
    expect(
      MoneyRequest.safeParse({ amountMinor: '350000', currency: 'COP', exponent: 2 }).success,
    ).toBe(false);
  });

  it('accepts USD at exponent 2', () => {
    expect(MoneyRequest.safeParse({ amountMinor: '1999', currency: 'USD', exponent: 2 }).success).toBe(
      true,
    );
  });

  it('rejects USD at exponent 0', () => {
    expect(MoneyRequest.safeParse({ amountMinor: '1999', currency: 'USD', exponent: 0 }).success).toBe(
      false,
    );
  });

  it('names the exponent in the issue path, so the error is actionable', () => {
    const result = MoneyRequest.safeParse({ amountMinor: '1', currency: 'COP', exponent: 2 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['exponent']);
    }
  });

  it('still rejects everything base Money rejects', () => {
    expect(MoneyRequest.safeParse({ amountMinor: 100, currency: 'COP', exponent: 0 }).success).toBe(
      false,
    );
    expect(
      MoneyRequest.safeParse({ amountMinor: '1.5', currency: 'COP', exponent: 0 }).success,
    ).toBe(false);
  });
});
```

`apps/api/test/error-filter.integration.test.ts` — a controller that throws on demand, wired into a module graph of its own:

```ts
// This file is the ONE integration suite that does not boot the real
// application, because there is deliberately no route in the real application
// that throws. Two consequences are handled explicitly:
//
//   * `reflect-metadata` is imported here. Every other suite gets it
//     transitively through src/bootstrap.js; this one does not, and Nest's
//     decorators need it installed before any decorated class is evaluated.
//     Relying on @nestjs/core to import it for us is relying on an
//     implementation detail of somebody else's package.
//   * There is no startDatabase()/stopDatabase() call. BoomModule touches no
//     database, and starting one would be a 3-second no-op that makes the
//     suite look like it depends on Docker when it does not.
//
// What it still shares with production is the filter and the request-context
// middleware — the two things under test. Task 12a's health suite covers the
// filter as registered by the real bootstrap.
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DomainError } from '../src/shared/errors/domain-error.js';
import { DomainExceptionFilter } from '../src/shared/errors/domain-exception.filter.js';
import { RequestContextModule } from '../src/shared/request-context/request-context.module.js';

@Controller('boom')
class BoomController {
  @Get('domain')
  domain(): never {
    throw new DomainError('QUOTE_EXPIRED', 'La cotización ha expirado', { quoteId: 'q-1' });
  }

  @Get('unexpected')
  unexpected(): never {
    throw new Error('a stack trace that must never cross the boundary');
  }
}

@Module({ imports: [RequestContextModule], controllers: [BoomController] })
class BoomModule {}

let app: NestFastifyApplication;
let baseUrl: string;

beforeAll(async () => {
  app = await NestFactory.create<NestFastifyApplication>(BoomModule, new FastifyAdapter(), {
    logger: false,
  });
  app.useGlobalFilters(new DomainExceptionFilter());
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app.close();
});

describe('DomainExceptionFilter', () => {
  it('maps a DomainError to its documented status', async () => {
    const response = await fetch(`${baseUrl}/boom/domain`);
    expect(response.status).toBe(410);
  });

  it('returns the documented error envelope', async () => {
    const response = await fetch(`${baseUrl}/boom/domain`, {
      headers: { 'x-request-id': 'trace-me' },
    });
    expect(await response.json()).toEqual({
      error: {
        code: 'QUOTE_EXPIRED',
        message: 'La cotización ha expirado',
        details: { quoteId: 'q-1' },
        requestId: 'trace-me',
        retryable: false,
      },
    });
  });

  it('maps an unexpected error to 500 INTERNAL_ERROR', async () => {
    const response = await fetch(`${baseUrl}/boom/unexpected`);
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });

  it('never leaks a stack trace or the original message', async () => {
    const response = await fetch(`${baseUrl}/boom/unexpected`);
    const raw = await response.text();
    expect(raw).not.toContain('stack');
    expect(raw).not.toContain('must never cross the boundary');
    expect(raw).not.toContain('.ts:');
  });

  it('carries the request id on the error response too', async () => {
    const response = await fetch(`${baseUrl}/boom/unexpected`, {
      headers: { 'x-request-id': 'error-path-id' },
    });
    expect(response.headers.get('x-request-id')).toBe('error-path-id');
    const body = (await response.json()) as { error: { requestId: string } };
    expect(body.error.requestId).toBe('error-path-id');
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @metrika/api test:unit`
Expected: FAIL — none of the three modules exist, and `DomainErrorCode` has no `ORDER_NOT_FOUND`.

- [ ] **Step 3: Add `ORDER_NOT_FOUND` to the closed union**

In `packages/contracts/src/errors.ts`, insert it beside `QUOTE_NOT_FOUND` so the ordering stays domain-grouped:

```ts
  'QUOTE_NOT_FOUND',
  'QUOTE_EXPIRED',
  'QUOTE_SUPERSEDED',
  'ORDER_NOT_FOUND',
```

It was deliberately withheld from Plan 0A as speculative. It stops being speculative the moment a code → HTTP mapping exists that would otherwise have no answer for a missing order.

- [ ] **Step 4: Write the error types and the mapping**

`apps/api/src/shared/errors/domain-error.ts`:

```ts
import type { DomainErrorCode } from '@metrika/contracts';

/**
 * A failure the domain understands. Anything thrown that is not one of these
 * becomes INTERNAL_ERROR at the boundary — a generic 500 for a condition the
 * domain does understand is a bug: it tells the client nothing and hides a
 * real state from monitoring.
 */
export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}
```

`apps/api/src/shared/errors/error-mapping.ts`:

```ts
import type { DomainErrorCode } from '@metrika/contracts';

export interface DomainErrorResponse {
  readonly status: number;
  /** Whether an identical retry could plausibly succeed. Drives client backoff. */
  readonly retryable: boolean;
}

/**
 * `Record<DomainErrorCode, …>` rather than a partial map, deliberately: adding
 * a code to the union without adding it here is a COMPILE error, not a runtime
 * surprise on the one request that hits it. The table is
 * docs/CONTRACTS_AND_API.md's, with the codes that table omits filled in on the
 * same principle — a rejected input is 400, a state the domain understands but
 * will not act on is 422, an upstream compute failure is 502.
 */
export const DOMAIN_ERROR_RESPONSE: Readonly<Record<DomainErrorCode, DomainErrorResponse>> = {
  VALIDATION_FAILED: { status: 400, retryable: false },
  UNAUTHENTICATED: { status: 401, retryable: false },
  INSUFFICIENT_PERMISSIONS: { status: 403, retryable: false },
  MODEL_NOT_FOUND: { status: 404, retryable: false },
  MODEL_NOT_READY: { status: 422, retryable: false },
  MODEL_NOT_PRINTABLE: { status: 422, retryable: false },
  MODEL_TOO_COMPLEX: { status: 413, retryable: false },
  UNSUPPORTED_FILE_FORMAT: { status: 400, retryable: false },
  FILE_TOO_LARGE: { status: 413, retryable: false },
  CHECKSUM_MISMATCH: { status: 400, retryable: false },
  MALICIOUS_ARCHIVE: { status: 400, retryable: false },
  UNITS_NOT_CONFIRMED: { status: 422, retryable: false },
  IMPLAUSIBLE_SCALE: { status: 422, retryable: false },
  GEOMETRY_ANALYSIS_FAILED: { status: 502, retryable: true },
  INVALID_PRINT_CONFIGURATION: { status: 400, retryable: false },
  DOES_NOT_FIT_BUILD_VOLUME: { status: 422, retryable: false },
  SLICING_FAILED: { status: 502, retryable: true },
  QUOTE_NOT_FOUND: { status: 404, retryable: false },
  QUOTE_EXPIRED: { status: 410, retryable: false },
  QUOTE_SUPERSEDED: { status: 409, retryable: false },
  ORDER_NOT_FOUND: { status: 404, retryable: false },
  INVALID_STATE_TRANSITION: { status: 409, retryable: false },
  PAYMENT_VERIFICATION_FAILED: { status: 502, retryable: true },
  IDEMPOTENCY_KEY_REUSED: { status: 409, retryable: false },
  RATE_LIMITED: { status: 429, retryable: true },
  QUOTA_EXCEEDED: { status: 429, retryable: true },
  INTERNAL_ERROR: { status: 500, retryable: false },
};
```

`apps/api/src/shared/errors/domain-exception.filter.ts`:

```ts
import { Catch, type ArgumentsHost, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { isDomainError } from './domain-error.js';
import { DOMAIN_ERROR_RESPONSE } from './error-mapping.js';
import { getRequestId } from '../request-context/request-context.js';

interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
    readonly requestId: string;
    readonly retryable: boolean;
  };
}

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const requestId = getRequestId();

    if (isDomainError(exception)) {
      const { status, retryable } = DOMAIN_ERROR_RESPONSE[exception.code];
      const envelope: ErrorEnvelope = {
        error: {
          code: exception.code,
          message: exception.message,
          ...(exception.details !== undefined && { details: exception.details }),
          requestId,
          retryable,
        },
      };
      void reply.status(status).send(envelope);
      return;
    }

    if (exception instanceof HttpException) {
      const envelope: ErrorEnvelope = {
        error: {
          code: 'VALIDATION_FAILED',
          message: exception.message,
          requestId,
          retryable: false,
        },
      };
      void reply.status(exception.getStatus()).send(envelope);
      return;
    }

    // Everything else. The original message and stack stay on this side of the
    // boundary; `requestId` is the only thing a support conversation needs to
    // find the full trace. Structured logging of the cause lands with the
    // telemetry bootstrap in Plan 0C.
    const envelope: ErrorEnvelope = {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Ha ocurrido un error inesperado.',
        requestId,
        retryable: false,
      },
    };
    void reply.status(DOMAIN_ERROR_RESPONSE.INTERNAL_ERROR.status).send(envelope);
  }
}
```

Register it in `apps/api/src/bootstrap.ts`, immediately after `setGlobalPrefix`:

```ts
  app.useGlobalFilters(new DomainExceptionFilter());
```

- [ ] **Step 5: Write the Money request boundary**

`apps/api/src/shared/http/money-request.schema.ts`:

```ts
import { CURRENCY_REGISTRY, Money } from '@metrika/contracts';

/**
 * `Money` itself deliberately does not check `exponent` against the registry —
 * ADR-0014 keeps the wire type able to carry a historical exponent, so an old
 * quote stays readable after the registry changes. That freedom must not extend
 * to INBOUND data: a request that declares COP at exponent 2 is either a
 * client bug or an attempt to move the decimal point, and either way it must
 * not reach the pricing kernel.
 *
 * Use this schema for every request body field; keep plain `Money` for stored
 * and returned values.
 *
 * `.superRefine`, not `.refine`. Zod 4 removed `.refine`'s function-params
 * overload: the signature is now
 * `refine(check, params?: string | core.$ZodCustomParams)` and
 * `$ZodCustomParams` is an OBJECT (`{ path?, error?, … }`), so passing a
 * `(value) => ({ … })` callback is a TS2345. A per-value message therefore has
 * to come from `ctx.addIssue`. (`message` is also deprecated in Zod 4 in favour
 * of `error` — inside `addIssue` it is still the field name, which is why it
 * appears below.) Verified against the installed zod@4.4.3 with TS 6.0.3: this
 * form compiles, and `issues[0].path` is `['exponent']`.
 */
export const MoneyRequest = Money.superRefine((value, ctx) => {
  const expected = CURRENCY_REGISTRY[value.currency].exponent;
  if (value.exponent !== expected) {
    ctx.addIssue({
      code: 'custom',
      path: ['exponent'],
      message: `${value.currency} uses exponent ${String(expected)}, not ${String(value.exponent)}`,
    });
  }
});
```

- [ ] **Step 6: Run everything and watch it pass**

```bash
pnpm build
pnpm --filter @metrika/contracts test:unit
pnpm --filter @metrika/api test:unit
pnpm --filter @metrika/api test:integration
```

Expected: PASS throughout. `packages/contracts` stays at 100% coverage — `ORDER_NOT_FOUND` is a union member, not a branch.

- [ ] **Step 7: Mutation — prove the exhaustiveness test is not a self-referential round trip**

Plan 0A shipped a `z.enum` test that round-tripped the enum over its own `.options` and asserted nothing. This one compares two independent artefacts, so prove that.

Delete the `ORDER_NOT_FOUND` line from `DOMAIN_ERROR_RESPONSE` (leave it in the contract union).

Run: `pnpm --filter @metrika/api typecheck`
Expected: **RED** — `Property 'ORDER_NOT_FOUND' is missing in type … but required in type 'Record<DomainErrorCode, DomainErrorResponse>'`.

Now do the reverse: restore the map entry and instead delete `'ORDER_NOT_FOUND'` from the contract union.

Run: `pnpm --filter @metrika/api typecheck; pnpm --filter @metrika/api test:unit -- error-mapping`

Expected: **BOTH red, and that is the intended outcome.** `tsc` reports `TS2353: Object literal may only specify known properties, and 'ORDER_NOT_FOUND' does not exist in type 'Record<DomainErrorCode, DomainErrorResponse>'` — excess-property checking fires on an object literal assigned to a `Record` over a closed union — and `covers every code in the closed union` fails because the map has a key the union does not. Run the two commands separately (`;`, not `&&`) so the second is not skipped by the first one's exit code.

Both gates are kept on purpose. The compile error is the faster one and the one that fires in an editor; the runtime test is the one that survives the day this map stops being an object literal (a `satisfies`, a spread, or a computed table all defeat excess-property checking, and none of them defeats comparing two independent artefacts).

Restore both, re-run, confirm green.

- [ ] **Step 8: Mutation — prove the stack-trace test fires**

In the filter's final branch, leak the cause:

```ts
        message: exception instanceof Error ? exception.stack ?? exception.message : 'unknown',
```

Run: `pnpm --filter @metrika/api test:integration -- error-filter`
Expected: **RED, twice** — `never leaks a stack trace or the original message` fails on both the `must never cross the boundary` substring and the `.ts:` substring. Restore.

- [ ] **Step 9: Mutation — prove the Money boundary is checking the registry**

In `money-request.schema.ts`, delete the `ctx.addIssue({ … })` call so the check runs and reports nothing:

```ts
export const MoneyRequest = Money.superRefine((value, ctx) => {
  const expected = CURRENCY_REGISTRY[value.currency].exponent;
  if (value.exponent !== expected) {
    // reports nothing
  }
});
```

Run: `pnpm --filter @metrika/api test:unit -- money-request`
Expected: **RED, three times** — `rejects COP at exponent 2`, `rejects USD at exponent 0` and `names the exponent in the issue path`. The two "accepts" cases and `still rejects everything base Money rejects` stay green, which is what tells you the failure is the registry check and not the base schema. Restore.

- [ ] **Step 10: Verify and commit**

```bash
pnpm verify
```

Expected: exit 0.

```bash
git add packages/contracts apps/api
git commit -m "feat(api): add domain exception filter with an exhaustive error map and the money request boundary"
```

---

### Task 12a: ADR-0019, `nestjs-zod`, and `/health/{ready,deep}`

ROADMAP 0.15 (the ts-rest spike, decided) and the second half of 0.7 — part one of two. This task ends with three working health routes and a guard with a fixture; Task 12b turns the same module tree into a committed OpenAPI document.

**Files:**

- Create: `docs/adr/0019-nestjs-zod-contracts.md`, `apps/api/src/shared/http/zod-dto.ts`, `apps/api/src/modules/health/health.dto.ts`, `apps/api/src/modules/health/health.service.ts`, `apps/api/src/modules/health/deep-health.guard.ts`
- Modify: `docs/adr/0009-ts-rest-contracts.md` (status line only), `docs/adr/README.md`, `apps/api/src/modules/health/health.controller.ts`, `health.module.ts`, `apps/api/src/app.module.ts` (the `APP_INTERCEPTOR` provider), `apps/api/eslint.config.js` (the `createZodDto` funnel rule), `apps/api/package.json`
- Test: `apps/api/test/health.integration.test.ts`

**Interfaces:**

- Consumes: Tasks 9b, 10, 11
- Produces:
  - `metrikaDto<T extends ZodType>(schema: T): ZodDto<T, true>` — the only sanctioned `createZodDto` call site in the app, enforced by lint rather than by the compiler (Step 4)
  - the global `{ provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor }` provider in `AppModule` — the half of response validation that actually runs at request time (Step 5)
  - `HealthLiveDto`, `HealthReadyDto`, `HealthDeepDto`
  - `HealthService.checkAll(): Promise<readonly DependencyResult[]>`
  - `GET /health/ready` → 200 with per-dependency status
  - `GET /health/deep` → 401 without `Authorization: Bearer <HEALTH_DEEP_TOKEN>`, else 200 with per-dependency latency

- [ ] **Step 1: Record the spike result**

ADRs are immutable, so ADR-0009 is superseded rather than edited — apart from its status line, which is what points a reader forward.

`docs/adr/0019-nestjs-zod-contracts.md`:

```markdown
# ADR-0019 — Zod as the single source of truth, delivered via `nestjs-zod`

**Status:** Accepted · **Date:** 2026-08-08 · **Supersedes:** [ADR-0009](./0009-ts-rest-contracts.md)

## Context

ADR-0009 chose ts-rest, gated on a spike (ROADMAP 0.15): compatibility with the
chosen Zod major, NestJS on the Fastify adapter, and valid OpenAPI 3.1 emission.
The spike ran. ts-rest failed two of the three gates and the project's own
abandonment criterion.

**Zod 4.** `@ts-rest/core@latest` is 3.52.1, published 2025-03-04, and its
declarations are hard-pinned to Zod 3 internals. Type-checking a trivial branded
contract against it with `zod@4.4.3` produces 34 errors out of ts-rest's own
`.d.ts` files — `'…/zod/v4/classic/external' has no exported member named
'AnyZodObject'`, `no exported member 'ZodEffects'`. Not a peer warning: total
breakage. The only Zod-4-capable line is `3.53.0-rc.1`, behind the `rc`
dist-tag.

**Maintenance.** `npm view @ts-rest/core time.modified` is `2025-06-02`. No
publish of any kind — alpha, rc or stable — in the fourteen months since. The
last stable release is seventeen months old. ADR-0009 called abandonment "a real
if unlikely risk"; it is now observed, not hypothesised.

**OpenAPI 3.1.** `@ts-rest/open-api` emits `"openapi": "3.0.2"` and, against Zod
4 schemas, **silently empty** `"schema": {}` objects for every body and
response — `@anatine/zod-openapi`'s Zod-3 shape detection never matches and
falls through without erroring. A custom `SchemaTransformer` using Zod 4's
native `z.toJSONSchema()` fixes the content; the version field still has to be
overwritten by hand.

**What did work.** `@ts-rest/nest@3.53.0-rc.1` booted on Fastify and served real
requests; `.brand()` survived into inferred client types; missing-field and
wrong-base-type controller returns failed to compile. The concept is sound. The
package is not maintained.

## Decision

Take ADR-0009's own documented fallback:

- **`nestjs-zod@5.5.0`** for validation and OpenAPI metadata. It peer-declares
  `zod: "^3.25.0 || ^4.0.0"` — first-class Zod 4 — and was published two weeks
  before this ADR.
- **`@nestjs/swagger@11.4.6`** for document generation, run through
  `cleanupOpenApiDoc({ version: '3.1' })` **and** an explicit
  `document.openapi = '3.1.1'` override. No tool tested emits 3.1 natively; the
  override is mandatory and belongs in one function that every emitter calls.
- **`orval`** to generate the TanStack-Query client from the emitted document,
  in `packages/api-client` (Plan 0B-2). This leg was version-checked but never
  run; 0B-2 must prove it before the fallback is treated as fully verified.

Three obligations travel with the decision:

1. **Response validation defaults ON, project-wide.** Without it, both
   libraries type a controller's return against the schema's *input* type, and
   `.brand()` is output-only in Zod — so a plain `string` satisfies a branded-ID
   field at construction, compiles, and ships unvalidated. `nestjs-zod`'s
   response validation is the equivalent of ts-rest's `validateResponses`, and
   both default to **off**. Turning it on takes **two** registrations, and
   either one alone is silent:
   - `{ codec: true }` on every DTO, funnelled through `metrikaDto()` in
     `apps/api/src/shared/http/zod-dto.ts`. This is the compile-time half: it
     is what makes `@ZodResponse` check the handler's return against the
     schema's *output* type. It is a convention enforced by a lint rule, not by
     the type system — `@ZodResponse` has overloads that accept a non-codec DTO
     and simply check the weaker side.
   - `{ provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor }` in
     `apps/api/src/app.module.ts`. This is the runtime half. `@ZodResponse` only
     attaches metadata; the interceptor is what reads it and parses the
     response. Measured on this codebase's exact DTO shape: with the provider a
     handler returning an out-of-enum value answers 500, without it the same
     handler answers 200 and ships the invalid body.

   Neither may become opt-in per route, and a change that removes either one
   must fail a test. `apps/api/test/health.integration.test.ts` is that test:
   `/health/ready`'s handler hands the DTO the service's full result and lets
   `HealthReadySchema`'s `omit` remove `latencyMs`, so if nothing parses the
   response, an unauthenticated endpoint starts reporting per-dependency
   latency and the fixture goes red. Redaction that only happens when
   validation runs is the cheapest available canary; every app added later
   needs one of its own.
2. **`packages/contracts` stays pure Zod.** Neither `initContract().router()`
   nor `createZodDto()` can live there — both drag in a framework, and
   CLAUDE.md's boundary rule allows only `zod`. The DTO wrappers live in
   `apps/api`, alongside the controllers that use them. Because the client is
   generated from the emitted document rather than from the wrapper objects,
   nothing outside `apps/api` needs them.
3. **Fixtures, not assertions.** A controller whose return omits a required
   field or supplies the wrong base type must fail `tsc`, and the emitted
   document's schemas must be non-empty. Both are asserted in
   `apps/api/test/openapi.integration.test.ts`, because "the schema is empty
   but nothing errored" is the exact failure mode that made ts-rest look like it
   worked.

## Alternatives

- **Pin `@ts-rest/*@3.53.0-rc.1` anyway.** It works end to end today. Rejected:
  a repository whose central property is that an accepted quote stays
  reconstructible indefinitely should not anchor its contract layer on a
  non-GA prerelease with no publishes in fourteen months.
- **class-validator + `@nestjs/swagger`.** Rejected in ADR-0009 and still
  rejected: it requires a second schema definition alongside Zod.
- **tRPC.** Rejected in ADR-0009: abandons REST and OpenAPI.

## Consequences

**Accepted:** a codegen step (`orval`) the ts-rest path would not have needed,
and a less pleasant client than ts-rest's inferred one. `@nestjs/swagger` drags
`class-transformer` and `class-validator` in as peers even though `nestjs-zod`
replaces them for validation. Neither library's default OpenAPI path emits a
3.1-versioned document, so a second document generator added later that skips
the override would silently claim 3.0 while containing 3.1-only constructs —
which is why there is exactly one `buildOpenApiDocument`.

**Gained:** one definition per concept across four consumers and two languages,
on packages that are actually maintained, with the source of truth still Zod in
`packages/contracts` — so the migration cost this ADR just paid is the same
bounded cost ADR-0009 predicted, and it stays bounded.
```

Then edit **only** the status line of `docs/adr/0009-ts-rest-contracts.md`:

```markdown
**Status:** Superseded by [ADR-0019](./0019-nestjs-zod-contracts.md) · **Date:** 2026-08-07
```

Add the row to `docs/adr/README.md`'s index.

- [ ] **Step 2: Write the failing health tests**

`apps/api/test/health.integration.test.ts` — boots the real app through the shared fixture from Task 9b:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { bootApiForTest, stopDatabase, TEST_HEALTH_DEEP_TOKEN } from './support.js';

const TOKEN = TEST_HEALTH_DEEP_TOKEN;

let app: NestFastifyApplication;
let baseUrl: string;

beforeAll(async () => {
  ({ app, baseUrl } = await bootApiForTest());
});

afterAll(async () => {
  await app.close();
  await stopDatabase();
});

describe('GET /health/live', () => {
  it('is 200 and checks no dependency', async () => {
    const response = await fetch(`${baseUrl}/health/live`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', environment: 'test' });
  });
});

describe('GET /health/ready', () => {
  it('is 200 with the database reachable', async () => {
    const response = await fetch(`${baseUrl}/health/ready`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; checks: { name: string }[] };
    expect(body.status).toBe('ok');
    expect(body.checks.map((c) => c.name)).toEqual(['database']);
  });

  /**
   * This is the fixture for ADR-0019 obligation 1, and the only test in the
   * repository that fails when the global ZodSerializerInterceptor is removed.
   *
   * The controller hands the DTO the service's full DependencyResult, which
   * carries `latencyMs`. `HealthReadySchema` omits that field, so the response
   * schema is what removes it — and a Zod schema only removes anything if
   * something parses the response. Delete the APP_INTERCEPTOR provider and
   * `latencyMs` appears in the body of an UNAUTHENTICATED endpoint, which is
   * both a leak of internal topology and proof that every other route's
   * response validation is off too.
   *
   * toEqual, not toMatchObject: the point is the absent key.
   */
  it('reports no per-dependency latency — readiness is unauthenticated, /health/deep is not', async () => {
    const response = await fetch(`${baseUrl}/health/ready`);
    const body = (await response.json()) as { checks: Record<string, unknown>[] };
    expect(body.checks).toEqual([{ name: 'database', status: 'ok' }]);
  });
});

describe('GET /health/deep', () => {
  it('is 401 with no credentials — the endpoint reports internal topology', async () => {
    const response = await fetch(`${baseUrl}/health/deep`);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHENTICATED');
  });

  it('is 401 with the wrong token', async () => {
    const response = await fetch(`${baseUrl}/health/deep`, {
      headers: { authorization: 'Bearer not-the-token' },
    });
    expect(response.status).toBe(401);
  });

  it('is 401 with a correct token under the wrong scheme', async () => {
    const response = await fetch(`${baseUrl}/health/deep`, {
      headers: { authorization: TOKEN },
    });
    expect(response.status).toBe(401);
  });

  it('is 200 with the right token and reports per-dependency latency', async () => {
    const response = await fetch(`${baseUrl}/health/deep`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      checks: { name: string; status: string; latencyMs: number }[];
    };
    const database = body.checks.find((c) => c.name === 'database');
    expect(database?.status).toBe('ok');
    expect(database?.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `pnpm --filter @metrika/api test:integration`
Expected: FAIL — `/health/ready` and `/health/deep` are 404.

- [ ] **Step 4: Write the DTO helper, the lint rule that makes it the only call site, and the health DTOs**

The response-validation option was resolved before this plan was written; it is not something to go looking for. The installed `nestjs-zod@5.5.0` declaration is:

```ts
declare function createZodDto<TSchema extends UnknownSchema, TCodec extends boolean = false>(
  schema: TSchema,
  options?: { codec: TCodec },
): ZodDto<TSchema, TCodec>;
```

Verified to type-check and to emit a nameable `.d.ts` under TS 6.0.3 with this repo's full strict flag set.

**`ZodResponse` does not reject a DTO built without `{ codec: true }`** — do not rely on the compiler to enforce the funnel. The installed `.d.ts` declares four `ZodResponse` overloads; two of them take `ZodDto<TSchema, false>` and `[ZodDto<TSchema, false>]`, and `class PlainDto extends createZodDto(S) {}` passed straight to `@ZodResponse({ status: 200, type: PlainDto })` type-checks clean, `tsc` exit 0. What `codec` changes is:

|                                        | `{ codec: true }`           | plain `createZodDto(S)`      |
| -------------------------------------- | --------------------------- | ---------------------------- |
| Handler return type is checked against | `output<TSchema>`           | `input<TSchema>`             |
| Schema `@ApiResponse` publishes        | the DTO's **input** version | the DTO's **output** version |

Row 1 is read straight off the four overload signatures. Row 2 is `nestjs-zod`'s own doc comment on `ZodResponse`; it makes no difference to the three health schemas, whose input and output types are identical because none of them transforms, but it will matter the first time a DTO carries a `.transform()` or a `.brand()`.

`.brand()` is output-only in Zod, so only the `output<TSchema>` side turns a plain unbranded string in a branded-ID response field into a compile error. That is the whole reason for the funnel — and since the compiler will not enforce it, **the lint rule below is what does**, so a future bare `createZodDto(schema)` is an error rather than a quiet downgrade.

`apps/api/src/shared/http/zod-dto.ts`:

```ts
import { createZodDto, type ZodDto } from 'nestjs-zod';
import type { ZodType } from 'zod';

/**
 * The only sanctioned way to make a DTO in this app — and the only file allowed
 * to import `createZodDto`, per the lint rule in apps/api/eslint.config.js.
 *
 * `codec: true` turns on OUTPUT-side type checking at `@ZodResponse`. Without
 * it, both nestjs-zod and ts-rest type a controller's return against the
 * schema's *input* type, and `.brand()` is output-only in Zod — so a plain
 * unbranded string satisfies a branded-ID response field, compiles, and ships.
 * ADR-0019 makes this default an obligation rather than an option.
 *
 * THIS FILE IS ONLY HALF OF RESPONSE VALIDATION. `@ZodResponse` attaches
 * metadata (`ZodSerializerDto`, `ApiResponse`, `HttpCode`); it validates
 * nothing by itself. The other half is the global
 * `{ provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor }` provider in
 * src/app.module.ts, which is what reads that metadata and parses the response
 * at request time. Delete that provider and every route in this app answers 200
 * with whatever the handler returned. Both halves, or neither works — the only
 * thing that notices is the readiness fixture in
 * test/health.integration.test.ts.
 *
 * The return type is written out rather than inferred. `apps/api`'s build
 * inherits `composite`/`declaration: true`, so TypeScript has to NAME
 * `createZodDto(...)`'s return in the emitted `.d.ts`; under pnpm's nested
 * node_modules layout an inferred type reaching into `nestjs-zod`'s internals
 * is the classic `TS2742: The inferred type of 'metrikaDto' cannot be named
 * without a reference to …`. `ZodDto` is exported from the package root, so
 * naming it explicitly is both the fix and the documentation.
 */
export function metrikaDto<T extends ZodType>(schema: T): ZodDto<T, true> {
  return createZodDto(schema, { codec: true });
}
```

Now make the funnel real. Add this block to `apps/api/eslint.config.js`, **before** the final `{ ignores: … }` entry:

```js
  {
    // `metrikaDto()` is a convention until something enforces it: `ZodResponse`
    // has overloads that accept a non-codec DTO and silently check the weaker
    // side (input<T> instead of output<T>), so `class Dto extends
    // createZodDto(S) {}` compiles clean and ships a branded-ID field
    // unvalidated. This rule is what makes the funnel the only way in.
    //
    // The `@typescript-eslint/` extension rule, not the core one, deliberately.
    // Flat config REPLACES a rule's options wholesale when a later entry names
    // the same rule: a second core `no-restricted-imports` block matching
    // src/**/*.ts would silently drop prismaImportBoundary's @prisma/client ban
    // for every file both blocks match. Verified — the Prisma finding
    // disappears with no error and no warning. The extension is a different
    // rule id, so the two coexist and both fire.
    files: ['src/**/*.ts'],
    ignores: ['src/shared/http/zod-dto.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'nestjs-zod',
              importNames: ['createZodDto'],
              message:
                'Use metrikaDto() from src/shared/http/zod-dto.ts — a bare createZodDto() DTO type-checks fine and ships unvalidated. See ADR-0019.',
            },
          ],
        },
      ],
    },
  },
```

No new dependency and no plugin registration: `nest()` already composes `typescript-eslint`'s `strictTypeChecked`, so the `@typescript-eslint` plugin is in scope for `apps/api`, and `no-restricted-imports` has shipped in `@typescript-eslint/eslint-plugin` since v6 — 8.66.0 is what this repo pins. Step 8 mutates both halves of this rule.

`apps/api/src/modules/health/health.dto.ts`:

```ts
import { z } from 'zod';
import { metrikaDto } from '../../shared/http/zod-dto.js';

export const HealthStatus = z.enum(['ok', 'degraded', 'down']);

export const DependencyCheck = z.object({
  name: z.string(),
  status: HealthStatus,
  latencyMs: z.number().nonnegative(),
});

export const HealthLiveSchema = z.object({
  status: z.literal('ok'),
  environment: z.enum(['development', 'test', 'production']),
});

export const HealthReadySchema = z.object({
  status: HealthStatus,
  checks: z.array(DependencyCheck.omit({ latencyMs: true })),
});

export const HealthDeepSchema = z.object({
  status: HealthStatus,
  checks: z.array(DependencyCheck),
});

export class HealthLiveDto extends metrikaDto(HealthLiveSchema) {}
export class HealthReadyDto extends metrikaDto(HealthReadySchema) {}
export class HealthDeepDto extends metrikaDto(HealthDeepSchema) {}
```

`apps/api/src/modules/health/health.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/persistence/prisma.service.js';

export interface DependencyResult {
  readonly name: string;
  readonly status: 'ok' | 'degraded' | 'down';
  readonly latencyMs: number;
}

@Injectable()
export class HealthService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * A real round trip, not a connection check: a pool that has a socket open to
   * a database that is refusing queries is not ready, and `$connect()` alone
   * would report it as healthy.
   */
  async checkDatabase(): Promise<DependencyResult> {
    const startedAt = performance.now();
    try {
      await this.prisma.client.$queryRaw`SELECT 1`;
      return { name: 'database', status: 'ok', latencyMs: performance.now() - startedAt };
    } catch {
      return { name: 'database', status: 'down', latencyMs: performance.now() - startedAt };
    }
  }

  async checkAll(): Promise<readonly DependencyResult[]> {
    return [await this.checkDatabase()];
  }
}
```

`apps/api/src/modules/health/deep-health.guard.ts`:

```ts
// `type CanActivate` and `type ExecutionContext`: both are interfaces, and
// `verbatimModuleSyntax` is true in base.json and stays true in nest.json, so a
// value import of either is `error TS1484: '…' is a type and must be imported
// using a type-only import`. `Injectable` is a real value (the decorator) and
// must NOT be type-imported. Nothing here is injected by type, so this is not
// the DI footgun — the guard's own `EnvService` parameter is a value import.
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { DomainError } from '../../shared/errors/domain-error.js';
import { EnvService } from '../../config/env.service.js';

/**
 * /health/deep reports internal topology and per-dependency latency, so it is
 * authenticated. A shared secret is the control until Phase 1 replaces it with
 * the Clerk guard — and it is a real control, with a fixture asserting the 401
 * rather than a comment asserting the intent.
 */
@Injectable()
export class DeepHealthGuard implements CanActivate {
  constructor(private readonly config: EnvService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers.authorization;

    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new DomainError('UNAUTHENTICATED', 'Credenciales requeridas.');
    }

    const presented = Buffer.from(header.slice('Bearer '.length));
    const expected = Buffer.from(this.config.values.HEALTH_DEEP_TOKEN);

    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      throw new DomainError('UNAUTHENTICATED', 'Credenciales inválidas.');
    }

    return true;
  }
}
```

- [ ] **Step 5: Finish the controller and register the interceptor that actually validates**

`apps/api/src/modules/health/health.controller.ts`:

```ts
import { Controller, Get, HttpCode, UseGuards } from '@nestjs/common';
import { ZodResponse } from 'nestjs-zod';
import { EnvService } from '../../config/env.service.js';
import { DeepHealthGuard } from './deep-health.guard.js';
import { HealthDeepDto, HealthLiveDto, HealthReadyDto } from './health.dto.js';
import { HealthService } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly config: EnvService,
    private readonly health: HealthService,
  ) {}

  /**
   * Liveness must never check a dependency. A liveness probe that fails because
   * Redis is slow makes the orchestrator kill healthy tasks and turns a
   * degradation into an outage — see docs/OBSERVABILITY.md.
   */
  @Get('live')
  @ZodResponse({ status: 200, type: HealthLiveDto })
  live(): HealthLiveDto {
    return { status: 'ok', environment: this.config.values.NODE_ENV };
  }

  /**
   * `checks: [...results]` hands the DTO the FULL DependencyResult, `latencyMs`
   * included, and lets `HealthReadySchema` — which omits that field — be the
   * thing that removes it. Deliberate, not sloppy: hand-stripping the field here
   * would make the schema decorative and would make the global
   * ZodSerializerInterceptor deletable with every test still green. As written,
   * `test/health.integration.test.ts` fails the moment response validation stops
   * running, which is what ADR-0019 obligation 1 requires of it.
   *
   * Readiness is unauthenticated, so it reports WHICH dependencies are up and
   * nothing more. Per-dependency latency is internal topology and lives on
   * /health/deep, behind the token.
   */
  @Get('ready')
  @ZodResponse({ status: 200, type: HealthReadyDto })
  async ready(): Promise<HealthReadyDto> {
    const results = await this.health.checkAll();
    const status = results.every((r) => r.status === 'ok') ? 'ok' : 'down';
    return { status, checks: [...results] };
  }

  @Get('deep')
  @UseGuards(DeepHealthGuard)
  @HttpCode(200)
  @ZodResponse({ status: 200, type: HealthDeepDto })
  async deep(): Promise<HealthDeepDto> {
    const checks = await this.health.checkAll();
    const status = checks.every((c) => c.status === 'ok') ? 'ok' : 'down';
    return { status, checks: [...checks] };
  }
}
```

`apps/api/src/modules/health/health.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { DeepHealthGuard } from './deep-health.guard.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

@Module({
  controllers: [HealthController],
  providers: [HealthService, DeepHealthGuard],
})
export class HealthModule {}
```

Now the registration without which none of the above validates anything. `apps/api/src/app.module.ts` — the version from Task 10, plus one provider:

```ts
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ZodSerializerInterceptor } from 'nestjs-zod';
import { ConfigModule } from './config/config.module.js';
import { PersistenceModule } from './infrastructure/persistence/persistence.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { RequestContextModule } from './shared/request-context/request-context.module.js';

@Module({
  imports: [RequestContextModule, ConfigModule, PersistenceModule, HealthModule],
  // The runtime half of ADR-0019's obligation 1. `@ZodResponse` only ATTACHES
  // metadata (ZodSerializerDto + ApiResponse + HttpCode); this interceptor is
  // what reads it and parses the handler's return value. Measured on this exact
  // DTO shape: without this provider a handler returning an out-of-enum value
  // answers `200 {"status":"ok","environment":"staging"}`; with it, 500. The
  // readiness fixture in test/health.integration.test.ts is what goes red if
  // this line is removed — do not delete one without the other.
  //
  // It lives HERE, in the composition root, not in HealthModule. Nest hoists an
  // APP_INTERCEPTOR provider to application scope no matter which module
  // declares it, so both placements behave identically today — the difference is
  // what a reader finds and what a deletion takes with it. Declared inside a
  // feature module, a project-wide guarantee becomes a side effect of that
  // feature: retire or stop importing HealthModule in some later phase and every
  // OTHER controller in the app loses response validation as a side effect —
  // and the health fixture that would have caught it is gone in the same move.
  // ADR-0019 says project-wide, so it is registered project-wide.
  //
  // Not `app.useGlobalInterceptors(...)` in bootstrap.ts either (which is where
  // DomainExceptionFilter is registered): the interceptor takes `Reflector` in
  // its constructor, so the DI form is the one that does not require
  // hand-constructing framework internals.
  providers: [{ provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor }],
})
export class AppModule {}
```

Verified to compile under this repo's full strict flag set (`verbatimModuleSyntax`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`, `isolatedModules`, `NodeNext`): `tsc` exit 0. `APP_INTERCEPTOR` is a value from `@nestjs/core`, and `ZodSerializerInterceptor` is a class — neither is `import type`.

- [ ] **Step 6: Install and run**

```bash
pnpm --filter @metrika/api add --save-exact nestjs-zod@5.5.0 @nestjs/swagger@11.4.6
grep -nE '"(nestjs-zod|@nestjs/swagger)"' apps/api/package.json
```

Expected: bare `5.5.0` and `11.4.6`. `@nestjs/swagger` is needed here and not only in Task 12b: `@ZodResponse` applies `@ApiResponse` internally. Check the install output for peer warnings and add anything named (`class-transformer`, `class-validator`, `@fastify/static` are the expected candidates) with `--save-exact`.

```bash
pnpm build
pnpm --filter @metrika/api test:integration
```

Expected: PASS — 4 boot, 4 request-context, 5 error-filter and 7 health tests (1 live, 2 ready, 4 deep).

- [ ] **Step 7: Mutation — prove response validation is really on, and that the interceptor is what turns it on**

Two halves. Both are needed: the first proves validation runs, the second proves _which_ registration makes it run — and the second is the one that catches a future "this provider looks unused, delete it".

**Half A.** Make the live handler return a value outside its enum:

```ts
  live(): HealthLiveDto {
    return { status: 'ok', environment: 'staging' as HealthLiveDto['environment'] };
  }
```

Run: `pnpm build && pnpm --filter @metrika/api test:integration -- health`
Expected: **RED with a 500**, not a green 200 carrying `"staging"`. `is 200 and checks no dependency` fails with `expected 500 to be 200`. The interceptor throws `ZodSerializationException`, which extends `InternalServerErrorException` and therefore `HttpException`, so `DomainExceptionFilter`'s `HttpException` branch answers `exception.getStatus()` — 500 — with `error.code: "VALIDATION_FAILED"`.

Restore the handler, re-run, confirm green before starting Half B.

**Half B — the registration, not the decorator, is what runs.** With everything restored, delete the provider line from `apps/api/src/app.module.ts`:

```ts
  providers: [{ provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor }],
```

(Delete only that line; leave the two imports. `noUnusedLocals` is `false`, so `pnpm build` stays green — lint would flag them, and this step does not run lint.)

Run: same command.
Expected: **RED.** `reports no per-dependency latency — readiness is unauthenticated, /health/deep is not` fails with `expected [ { name: 'database', status: 'ok', latencyMs: 3.9 } ] to deeply equal [ { name: 'database', status: 'ok' } ]` (the number varies). `@ZodResponse` is metadata only: with no interceptor reading it, nothing parses the response, `HealthReadySchema`'s `omit` never runs, and `latencyMs` ships from an unauthenticated endpoint. That one leak stands in for the whole class — with this provider gone, every branded-ID and every redacting response schema in the app is inert, and nothing else would have noticed.

Restore the provider, re-run, confirm green.

- [ ] **Step 8: Mutation — prove the `createZodDto` lint rule is a real gate**

Two halves again, because this rule has a silent failure mode of its own.

**Half A — the rule fires.** In `apps/api/src/modules/health/health.dto.ts`, bypass the funnel:

```ts
import { createZodDto } from 'nestjs-zod';
export class HealthLiveDto extends createZodDto(HealthLiveSchema) {}
```

Run: `pnpm --filter @metrika/api lint`
Expected: **RED**, exit 1, one finding: `'createZodDto' import from 'nestjs-zod' is restricted. Use metrikaDto() from src/shared/http/zod-dto.ts …  @typescript-eslint/no-restricted-imports`. Note that `pnpm typecheck` on the same tree is **exit 0** — that is precisely why the rule exists. Restore `metrikaDto`, re-run, confirm exit 0 for both.

**Half B — the rule does not clobber the Prisma boundary.** Add two lines to the same file — the second one so that `@typescript-eslint/no-unused-vars` does not fire and confuse the reading:

```ts
import { PrismaClient } from '@prisma/client';
export const PRISMA_PROBE = PrismaClient;
```

Run: `pnpm --filter @metrika/api lint`
Expected: **RED** with the `no-restricted-imports` finding from `prismaImportBoundary` (`'@prisma/client' import is restricted from being used. Prisma access goes through apps/api/src/infrastructure/persistence — see ADR-0005`).

Then, keeping that import, change the new block's rule name in `apps/api/eslint.config.js` from `'@typescript-eslint/no-restricted-imports'` to the core `'no-restricted-imports'` and re-run.

Expected: the Prisma finding **disappears** and lint exits 0 — flat config replaced `prismaImportBoundary`'s options with this block's, silently, for every file both blocks match. That is the mistake the extension-rule choice avoids; seeing it once is what keeps somebody from "simplifying" the rule name later. Restore the `@typescript-eslint/` prefix, delete both added lines, re-run, confirm exit 0.

Verified before this plan was written, on `eslint@10.8.0` + `@typescript-eslint/eslint-plugin@8.66.0` with exactly these two config blocks: with the extension rule, both findings are reported (`@typescript-eslint/no-restricted-imports` for `createZodDto`, `no-restricted-imports` for `@prisma/client`); with the core rule in both blocks, only the `createZodDto` finding survives.

- [ ] **Step 9: Mutation — prove the deep-health guard is a control**

In `deep-health.guard.ts`, replace the body of `canActivate` with `return true;`.

Run: `pnpm build && pnpm --filter @metrika/api test:integration -- health`
Expected: **RED, three times** — all three 401 assertions fail. Restore.

- [ ] **Step 10: Verify and commit**

```bash
pnpm verify
```

Expected: exit 0.

Two commits, because the ADR is a decision and the code is its consequence:

```bash
git add docs/adr
git commit -m "docs(adr): supersede ADR-0009 with nestjs-zod after the ts-rest spike failed"
git add apps/api pnpm-lock.yaml
git commit -m "feat(api): add health readiness and deep probes with nestjs-zod response validation"
```

---

### Task 12b: `buildOpenApiDocument`, the emit script, and the committed document

ROADMAP 0.7's contract surface — part two of two.

**Files:**

- Create: `apps/api/src/openapi/build-document.ts`, `apps/api/src/scripts/emit-openapi.ts`, `apps/api/openapi/openapi.json` (generated, committed)
- Modify: `apps/api/src/bootstrap.ts`, `apps/api/package.json`, `.prettierignore`
- Test: `apps/api/test/openapi.integration.test.ts`

**Interfaces:**

- Consumes: Task 12a
- Produces:
  - `buildOpenApiDocument(app): OpenAPIObject` — `openapi: "3.1.1"`, used by `bootstrap.ts` and by the emit script
  - `apps/api/openapi/openapi.json`, committed and diffed in CI
  - `GET /api/v1/openapi.json`
  - `pnpm --filter @metrika/api openapi:emit` — runs with **no database reachable**

- [ ] **Step 1: Keep Prettier's hands off the emitted document**

Do this **before** the file is first written, not after. `emit-openapi.ts` serialises with `JSON.stringify(document, null, 2)`, which expands every array onto its own lines. `prettier.config.js` sets `printWidth: 100`, and Prettier collapses short JSON arrays that fit — `"required": ["status", "environment"]` is the common case. So the two disagree about the same file, permanently: `pnpm format` rewrites a freshly emitted document, `pnpm format:check` (inside `verify`) fails on one, and CI's `git diff --exit-code -- apps/api/openapi/openapi.json` fails on a clean tree.

Add to `.prettierignore`:

```
apps/api/openapi/
```

The document is machine-generated and diffed byte-for-byte in CI; a formatter is not the right owner for it.

- [ ] **Step 2: Write the failing OpenAPI test**

`apps/api/test/openapi.integration.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { bootApiForTest, stopDatabase } from './support.js';
import { buildOpenApiDocument } from '../src/openapi/build-document.js';

let app: NestFastifyApplication;
let baseUrl: string;

beforeAll(async () => {
  ({ app, baseUrl } = await bootApiForTest());
});

afterAll(async () => {
  await app.close();
  await stopDatabase();
});

describe('buildOpenApiDocument', () => {
  it('declares OpenAPI 3.1, not the 3.0 the generator defaults to', () => {
    expect(buildOpenApiDocument(app).openapi).toBe('3.1.1');
  });

  it('documents the three health routes', () => {
    const paths = Object.keys(buildOpenApiDocument(app).paths ?? {});
    expect(paths).toContain('/health/live');
    expect(paths).toContain('/health/ready');
    expect(paths).toContain('/health/deep');
  });

  it('emits populated response schemas — an empty schema object is the ts-rest failure mode', () => {
    const document = buildOpenApiDocument(app);
    const schemas = document.components?.schemas ?? {};
    const deep = schemas['HealthDeepDto'];

    expect(deep).toBeDefined();
    expect(Object.keys((deep as { properties?: object }).properties ?? {})).toContain('checks');
  });

  it('is served at /api/v1/openapi.json', async () => {
    const response = await fetch(`${baseUrl}/api/v1/openapi.json`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { openapi: string };
    expect(body.openapi).toBe('3.1.1');
  });
});
```

Run: `pnpm --filter @metrika/api test:integration`
Expected: FAIL — `build-document.js` does not exist.

- [ ] **Step 3: Build the OpenAPI document, once**

`apps/api/src/openapi/build-document.ts`:

```ts
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import type { INestApplication } from '@nestjs/common';

export const OPENAPI_VERSION = '3.1.1';

/**
 * The ONLY document generator in this repository, deliberately.
 *
 * `SwaggerModule.createDocument` hardcodes `openapi: "3.0.0"`, and
 * `cleanupOpenApiDoc({ version: '3.1' })` converts the schema bodies to
 * JSON Schema 2020-12 without touching that field. A second generator that
 * skipped the override would emit a document claiming 3.0 while containing
 * 3.1-only constructs (Zod 4's `anyOf`-based nullable, for one), which breaks
 * strict 3.0 consumers in a way no test of ours would notice. One function,
 * called by main.ts and by scripts/emit-openapi.ts.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Metrika API')
    .setDescription('Manufacturing quotes for 3D-printed architectural models.')
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();

  const document = cleanupOpenApiDoc(SwaggerModule.createDocument(app, config), {
    version: '3.1',
  });

  return { ...document, openapi: OPENAPI_VERSION };
}
```

`apps/api/src/scripts/emit-openapi.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createApiApp } from '../bootstrap.js';
import { buildOpenApiDocument } from '../openapi/build-document.js';

const OUTPUT = path.resolve(import.meta.dirname, '../../openapi/openapi.json');

/**
 * There is deliberately NO `await app.init()` here.
 *
 * `NestFactory.create()` already instantiates every module and provider, which
 * is all `SwaggerModule.createDocument` reads — it walks the modules container
 * for controller metadata. `app.init()` additionally fires the lifecycle hooks,
 * and `PrismaService.onModuleInit` calls `$connect()`. This script runs in CI
 * with no Postgres anywhere, so an `init()` would fail with "Can't reach
 * database server" on every run. Emitting a document is a static operation on
 * the module graph; it must not need a database, and this is the line that
 * keeps it that way.
 *
 * `close()` is safe on an uninitialised app: it runs the destroy hooks, and
 * Prisma's `$disconnect()` on a client that never connected is a no-op.
 */
const app = await createApiApp();
const document = buildOpenApiDocument(app);
await app.close();

mkdirSync(path.dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
```

Serve it from `apps/api/src/bootstrap.ts`, after the filter registration:

```ts
  const document = buildOpenApiDocument(app);
  app
    .getHttpAdapter()
    .getInstance()
    .get(`/${API_PREFIX}/openapi.json`, async () => document);
```

Add the script to `apps/api/package.json`:

```json
    "openapi:emit": "node dist/scripts/emit-openapi.js",
```

- [ ] **Step 4: Emit the document and prove it needs no database**

```bash
pnpm build
pnpm --filter @metrika/api test:integration
```

Expected: the integration suite passes — 4 new OpenAPI tests on top of Task 12a's.

Now emit, with a `DATABASE_URL` that points at nothing and no Postgres running anywhere. This is exactly the CI `openapi` job's situation:

```bash
pnpm infra:down
DATABASE_URL='postgresql://metrika_app:metrika_app@127.0.0.1:5432/metrika_dev?schema=public' \
  HEALTH_DEEP_TOKEN='local-health-deep-token' \
  pnpm --filter @metrika/api openapi:emit
echo "EXIT=$?"
```

Expected: `EXIT=0`, and `apps/api/openapi/openapi.json` written with `"openapi": "3.1.1"`. `DATABASE_URL` still has to be **present and well-formed**, because `ConfigModule`'s factory validates the environment while the module graph is built; it does not have to be **reachable**, because nothing connects. Bring the stack back up with `pnpm infra:up` afterwards.

- [ ] **Step 5: Mutation — prove the emit script stays database-free**

Add the line the script deliberately omits, immediately after `createApiApp()`:

```ts
await app.init();
```

Run the same emit command with the stack down.
Expected: **RED** — the script fails with Prisma's `Can't reach database server at 127.0.0.1:5432`, non-zero exit. That is the failure the CI `openapi` job would hit on every run, and it is why `init()` is not there. Remove the line, re-run, confirm `EXIT=0`.

- [ ] **Step 6: Mutation — prove the schema-population test catches the ts-rest failure mode**

In `build-document.ts`, drop the `cleanupOpenApiDoc` call:

```ts
  const document = SwaggerModule.createDocument(app, config);
```

Run: `pnpm build && pnpm --filter @metrika/api test:integration -- openapi`
Expected: **RED** — `emits populated response schemas` fails because the DTO's schema body is empty or absent. Note that nothing else complains: no exception, no warning, and the document still looks structurally valid. That is the exact silent-data-loss the spike found in the ts-rest path. Restore.

- [ ] **Step 7: Mutation — prove `.prettierignore` is what keeps the document stable**

Remove the `apps/api/openapi/` line from `.prettierignore`.

Run:

```bash
pnpm format
git diff --stat -- apps/api/openapi/openapi.json
```

Expected: **a non-empty diff** — Prettier collapses the short `"required"` arrays that `JSON.stringify` expanded. That diff is what would make CI's `git diff --exit-code` gate fail on a clean tree, forever. Restore the line, run `pnpm --filter @metrika/api openapi:emit`, and confirm `git diff --exit-code -- apps/api/openapi/openapi.json` exits 0.

- [ ] **Step 8: Verify and commit**

```bash
pnpm verify
```

Expected: exit 0.

```bash
git add apps/api .prettierignore
git commit -m "feat(api): emit and commit an OpenAPI 3.1 document from one document builder"
```

---

### Task 13: CI, a clean-clone run, and documentation that matches what exists

**Files:**

- Modify: `.github/workflows/ci.yml`, `CLAUDE.md`, `CONTRIBUTING.md`, `docs/LOCAL_DEVELOPMENT.md`, `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`, `docs/INFRASTRUCTURE.md`

**Interfaces:**

- Consumes: Tasks 1–12b
- Produces: a green CI run with `verify`, `integration` and `openapi` jobs

- [ ] **Step 1: Add the integration and contract jobs**

Append to `.github/workflows/ci.yml`, keeping the existing `verify` job unchanged apart from the build step and the environment block:

```yaml
  integration:
    runs-on: ubuntu-latest
    env:
      # packages/database's `build` runs `prisma generate`, which resolves
      # schema.prisma's `env("DATABASE_ADMIN_URL")`. CI has no `.env` — that is
      # what `--env-file-if-exists` in the root db:* scripts is for — so the
      # value comes from here. Nothing connects to it; the Testcontainers
      # harness passes the real, container-derived URL explicitly.
      DATABASE_ADMIN_URL: postgresql://metrika:metrika@127.0.0.1:5432/metrika_ci?schema=public
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: pnpm

      - name: Install
        run: pnpm install --frozen-lockfile

      - name: Build
        run: pnpm build

      # No `docker compose up` here: Testcontainers starts its own Postgres per
      # run, which is the point of it — the suite must not depend on a stack a
      # workflow file happened to bring up. ubuntu-latest ships a running
      # Docker daemon, so packages/testing's preflight passes.
      - name: Integration tests
        run: pnpm test:integration

  openapi:
    runs-on: ubuntu-latest
    env:
      DATABASE_ADMIN_URL: postgresql://metrika:metrika@127.0.0.1:5432/metrika_ci?schema=public
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: pnpm

      - name: Install
        run: pnpm install --frozen-lockfile

      - name: Build
        run: pnpm build

      # There is no `services: postgres:` block and no Testcontainer here, on
      # purpose. `emit-openapi.ts` does not call `app.init()`, so no lifecycle
      # hook fires and `PrismaService.$connect()` is never reached — emitting a
      # document is a static operation on the module graph. DATABASE_URL still
      # has to be present and well-formed, because ConfigModule validates the
      # environment while the graph is built; it does not have to be reachable.
      # Task 12b Step 5 is the mutation that keeps this true.
      - name: Regenerate the OpenAPI document
        env:
          DATABASE_URL: postgresql://metrika_app:metrika_app@127.0.0.1:5432/metrika_dev?schema=public
          HEALTH_DEEP_TOKEN: ci-health-deep-token-value
        run: pnpm --filter @metrika/api openapi:emit

      # The document is committed, so a route or schema change that nobody
      # regenerated shows up as a diff here rather than as a client that no
      # longer matches the server.
      - name: Fail if the committed document is stale
        run: git diff --exit-code -- apps/api/openapi/openapi.json
```

Add the `Build` step to the existing `verify` job, before `Lint`, and give that job the same environment block:

```yaml
    env:
      DATABASE_ADMIN_URL: postgresql://metrika:metrika@127.0.0.1:5432/metrika_ci?schema=public
    steps:
      # …
      - name: Build
        run: pnpm build
```

- [ ] **Step 2: Mutation — prove the OpenAPI diff gate fires**

Edit `apps/api/openapi/openapi.json` by hand: change `"3.1.1"` to `"3.1.0"`.

Run:

```bash
pnpm --filter @metrika/api openapi:emit
git diff --exit-code -- apps/api/openapi/openapi.json; echo "EXIT=$?"
```

Expected: `EXIT=1` and a visible diff. Restore with a second `openapi:emit`, confirm `EXIT=0`.

- [ ] **Step 3: Prove a clean clone works**

The definition of done is a clean clone, not a warm working tree:

```bash
pnpm infra:reset
rm -rf node_modules packages/*/node_modules apps/*/node_modules packages/*/dist apps/*/dist
rm -rf packages/*/*.tsbuildinfo apps/*/*.tsbuildinfo .turbo
pnpm install --frozen-lockfile
pnpm infra:up
cp .env.example .env
pnpm db:deploy
pnpm verify
pnpm test:integration
```

Expected: `pnpm install` exits 0 with no `ERR_PNPM_IGNORED_BUILDS`; `verify` exits 0; the integration suites are green.

Record two numbers in the pull-request description, because both are things CI timeouts are tuned against and neither has ever been measured at suite scale on this project:

1. The wall-clock time Vitest reports for `pnpm test:integration`. Expect roughly **2.5–2.6 s per container** on a comparable machine (macOS/arm64, Docker 29.6.2, 4 GB Docker VM, image already cached) plus one `prisma migrate deploy` per package — so a few seconds per suite, not minutes. A cold image pull or the first container of a session adds ~5 s of Docker Desktop and Ryuk warm-up that is not representative of steady-state CI.
2. The peak container count during that run. In a second terminal, while it is running:

   ```bash
   docker ps --filter "ancestor=postgres:16-alpine" --format '{{.ID}}' | wc -l
   ```

   Expected: **at most 3** — one per package with an integration suite (`packages/testing`, `packages/database`, `apps/api`), each a separate Vitest run with its own `globalSetup`, and Turbo may overlap them. What must never appear is one container per _test file_: this plan ships **nine** integration files (1 in `packages/testing`, 3 in `packages/database`, 5 in `apps/api`), and nine containers is the symptom that a `globalSetup` entry was dropped.

- [ ] **Step 4: Reconcile `CLAUDE.md`**

Replace the "Current state" section:

```markdown
## Current state

Phase 0A and Plan 0B-1 are complete: the monorepo and quality gates,
`packages/contracts`, `packages/database` (Prisma + RLS + soft delete),
`packages/testing` (Testcontainers Postgres) and `apps/api` (NestJS on Fastify,
health probes, OpenAPI 3.1) exist and are tested. `apps/web` and `apps/workers`
do not exist yet — Plans 0B-2 and 0B-3 build them.

Read [`docs/ROADMAP.md`](./docs/ROADMAP.md) before starting work and confirm
which phase and which sub-plan the work belongs to.
```

Replace the Commands note:

```markdown
Working today: `verify` (format:check + build + lint + typecheck + test:unit),
`build`, `test:integration` (Docker required), `infra:up`/`infra:down`/`infra:reset`,
`db:generate`/`db:migrate`/`db:deploy`/`db:reset`/`db:studio` (all from the
repository root — they load the root `.env` and pass `--schema` explicitly; a
bare `pnpm exec prisma` inside `packages/database` cannot find
`DATABASE_ADMIN_URL`), and `pnpm --filter @metrika/api dev`.
Not yet created (Plans 0B-2/0B-3): `dev` across all runtimes, `test:e2e`,
`db:seed`, `contracts:emit`.
```

Add to the "Rules that are easy to break" section, under **Boundaries**:

```markdown
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
  dotenv search never reaches the repository root, so `cd packages/database &&
  pnpm exec prisma …` fails with `Environment variable not found:
  DATABASE_ADMIN_URL` on a correctly configured machine.
- Soft-deleted rows are revealed by `withDeleted(fn)` — a scoped function, so
  "forgot to turn filtering back on" is not a reachable state. Do not add a
  flag or a second client.
```

- [ ] **Step 5: Reconcile the other documents**

`docs/LOCAL_DEVELOPMENT.md`:

- §1 (Prerequisites) — add a row making Docker's role explicit: integration tests will not run without it.
- §2 (Getting running) — replace the "Working after Plan 0A" note with what works now, change `cp .env.example .env.local` to `cp .env.example .env`, change `docker compose up -d` to `pnpm infra:up`, and replace any `cd packages/database && prisma …` line with `pnpm db:deploy`.
- §5 (Everyday commands) — add `pnpm infra:up`/`infra:down`/`infra:reset` and the five root `db:*` scripts.
- §6 (Debugging) — replace `.env.local` with `.env`.
- §7 (Common problems) — add three rows:
  - `pnpm install exits 1 with ERR_PNPM_IGNORED_BUILDS` → a new dependency has an install script → add it to `allowBuilds` in `pnpm-workspace.yaml`.
  - `error: Environment variable not found: DATABASE_ADMIN_URL` → a Prisma command was run from inside `packages/database` → use the root `pnpm db:*` scripts; Prisma's dotenv search never reaches the repository root.
  - `Cyclic dependency detected` from Turbo → something added `@metrika/database` to `packages/testing` → remove it; the dependency runs one way only.
- §8 (Environment configuration) — replace every `.env.local` with `.env` and state that the superset check is `apps/api/test/env-example.test.ts`.

`docs/ROADMAP.md` — mark 0.6, 0.7, 0.13 and 0.15 done, 0.10 partially done, and update the progress paragraph:

```markdown
Progress: 0.1–0.7, 0.12, 0.13 (Postgres harness), 0.15 complete. 0.10 partially:
`postgres`, `redis`, `minio` and `mailpit` exist; `temporal` and `temporal-ui`
land in Plan 0B-3. Remaining: 0.8, 0.9, 0.11, 0.14, and 0.13's Redis/MinIO/
Temporal harnesses.
```

In the "Carried into Plan 0B" section, mark items 1–10 resolved with the task that closed each, and leave 11 for this step.

`docs/ARCHITECTURE.md` and `docs/INFRASTRUCTURE.md` — carryover item **11**: both pin the production image to `node:22-bookworm-slim` while dev and CI run Node 24. Change both to `node:24-bookworm-slim` and add one sentence where the tag appears:

```markdown
The production image tag tracks the toolchain major pinned in `.nvmrc` (24), and
is pinned by digest in the Dockerfile that Plan 0D writes — the tag here names
the major, the digest there names the bytes.
```

`CONTRIBUTING.md` — update the definition of done: `pnpm verify` now includes `build`, and any change touching `packages/database` or `apps/api` also requires `pnpm test:integration` locally.

- [ ] **Step 6: Format, verify, and confirm the tree is clean**

```bash
pnpm format
pnpm verify
git status --short
```

Expected: exit 0 from `pnpm verify`; `git status` shows only the intended documentation changes. In particular `apps/api/openapi/openapi.json` must **not** appear — if it does, the `.prettierignore` entry from Task 12b Step 1 is missing.

- [ ] **Step 7: Commit, push, and confirm CI is green**

```bash
git add -A
git commit -m "docs: reconcile documentation with Plan 0B-1 deliverables"
git push -u origin feat/phase-0b1-persistence-and-runtimes
gh pr create --fill --title "Phase 0B-1 — persistence and the API runtime"
gh run watch
```

Expected: `verify`, `integration` and `openapi` all succeed.

---

## Definition of done for Plan 0B-1

- `pnpm verify` passes on a clean clone: `rm -rf node_modules && pnpm install --frozen-lockfile && pnpm verify`.
- `pnpm test:integration` passes with Docker running, and fails with a readable `DockerUnavailableError` without it.
- CI is green on the pull request across `verify`, `integration` and `openapi`.
- `@metrika/contracts` resolves from a real `node` process by bare specifier, proven by a subprocess test rather than by a bundler.
- Every one of the three blocking carryover items is closed, each with a mutation step that turned a test red: the contracts build (Task 1), `nest.json`/`next.json` (Task 2), and `composite` no longer emitting into a Next app's source tree (Task 2).
- Tenant isolation holds when the application-level check is bypassed: the RLS suite proves it for the app role, for the table owner, on read, on update and on insert.
- The application database role is asserted to be neither a superuser nor `BYPASSRLS`.
- The workspace graph is acyclic: `packages/testing` declares no dependency on `packages/database`, and `pnpm build` completes without `Cyclic dependency detected`.
- One Postgres container serves a whole Vitest run, verified by `docker ps` during a real run rather than asserted in a comment.
- Every Prisma CLI invocation in the repository runs through the root `db:*` scripts, and running one from inside `packages/database` is demonstrated to fail.
- A `import type` on an injected provider fails `pnpm test:integration` — and only that.
- Every `DomainErrorCode` has an HTTP status, enforced by the type system in one direction and by a runtime test in the other. No known domain failure maps to 500.
- No stack trace crosses the HTTP boundary, proven by a fixture.
- `apps/api/openapi/openapi.json` declares `3.1.1` with populated schemas, is excluded from Prettier so the formatter and the emitter cannot fight over it, and CI fails if it is stale.
- `pnpm --filter @metrika/api openapi:emit` succeeds with no database reachable, proven by running it with the local stack down.
- ADR-0019 records the ts-rest spike outcome with evidence; ADR-0009's status line points to it and its body is untouched.
- Response validation is genuinely on for every route, both halves of it: `metrikaDto()` is the only `createZodDto` call site in `apps/api` — enforced by lint, because the compiler does not enforce it — and `ZodSerializerInterceptor` is registered globally in `AppModule`. Deleting either one turns `apps/api/test/health.integration.test.ts` red, the interceptor because `/health/ready` then leaks `latencyMs` that its schema is supposed to remove.
- No `any`, no `@ts-ignore`, no unjustified suppression.
- No commit contains AI attribution.
- Documentation states what exists rather than what is planned.

---

## The rest of Phase 0B

0B-1 deliberately stops where the server-side vertical slice is complete and independently runnable. The remainder splits into two sub-plans, in this order and for these reasons.

**Plan 0B-2 — Web runtime and the typed client.** `apps/web` (Next.js App Router on `next.json`, Tailwind, shadcn init, `config/env.ts`, root layout, `next-intl` with `es-CO`) · `packages/api-client` (orval generating the TanStack Query client from `apps/api/openapi/openapi.json`) · `packages/ui` primitives · the `react` and `next` ESLint profiles · the Tailwind Prettier plugin · a Playwright scaffold hitting `/health/live` through the browser. **Second because it consumes 0B-1's outputs**: `next.json` exists and is fixture-tested, and the OpenAPI document exists and is CI-diffed, so orval has something real to generate from. It also carries the single unverified leg of the ADR-0019 spike — orval was version-checked but never run — and that leg should be proven while the surface is one health endpoint rather than forty. Two things to expect: Next 16.3.0 auto-writes `AGENTS.md` and `CLAUDE.md` into the app directory on first `dev`/`build` unless `agentRules: false` is set, which needs a decision given the root `CLAUDE.md`; and `apps/web`'s tsconfig must supply its own `include`/`exclude`, because any `extends` key permanently disables Next's tsconfig auto-repair.

**Plan 0B-3 — Python workers and durable workflows.** `apps/workers` uv workspace with `metrika_core` (pydantic-settings, S3 client, structlog, Temporal base) and the geometry/slicer entrypoint stubs · `ruff` + `mypy --strict` (ROADMAP 0.4's remaining half) · Temporal SDK on both sides, `apps/api/src/workflows` with the `workflows` determinism ESLint profile · `temporal` and `temporal-ui` in compose · `withTemporal()` in `packages/testing` wrapping `TestWorkflowEnvironment.createTimeSkipping()` · `contracts:emit` (JSON Schema → pydantic, CI-diffed). **Third because it depends on both**: workflow code lives in `apps/api` and needs its build and its tsconfig, and `contracts:emit` needs the contracts build from Task 1. Nothing in 0B-1 or 0B-2 depends on it, so it can slip without blocking anything. Four probe findings must be carried in verbatim: `apps/workers/pyproject.toml` needs `[tool.uv] package = false`; every sync must be `uv sync --all-packages --frozen`, because a bare `uv sync` at a virtual workspace root **exits 0 with an empty venv**; `allowBuilds` must gain `@swc/core` and `protobufjs` before the Temporal SDK is added; and `manifold3d` needs explicit `cast()` at its boundary, since `ignore_missing_imports` alone does not silence `no-any-return` under `--strict`.

Plans **0C** (OpenTelemetry, Pino/structlog redaction, correlation across all three runtimes — ROADMAP 0.11) and **0D** (Terraform `shared`, gitleaks, Dependabot, digest-pinned production images — ROADMAP 0.14) keep the scope Plan 0A assigned them. 0C cannot start before 0B-3, because propagation across three runtimes cannot be proven until all three exist; 0D depends on nothing and can run in parallel with either.
