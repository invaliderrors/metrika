# Prisma 6.19.3 → 7.9.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `packages/database` and its consumers from Prisma 6.19.3 to 7.9.1 before Phase 1 adds six tenant models, an RLS extension and an audit table on top of the old major.

**Architecture:** Three commits, in a fixed order, because the middle one is only provable once the first has landed. First the configuration moves out of `schema.prisma` into `prisma.config.ts` while still on 6.19.3, where both versions accept it. Then the version bump, which forces a driver adapter and reshapes one error assertion. Then the `apps/api` fix for a lazy `$connect()` that stops the API failing fast at boot. Two further tasks pin the changes that no gate in this repository would otherwise catch, and one corrects the documents whose stated reasons the upgrade falsifies.

**Tech Stack:** Prisma 7.9.1, `@prisma/adapter-pg` 7.9.1, PostgreSQL 16, Vitest, Testcontainers, Turborepo, pnpm.

## Global Constraints

- **Pins, exact:** `prisma` `7.9.1` (devDependency), `@prisma/client` `7.9.1` (dependency), `@prisma/adapter-pg` `7.9.1` (dependency). No carets. `@prisma/adapter-pg` vendors `pg` and `@types/pg` as real dependencies — do **not** add either separately.
- **Stay on the `prisma-client-js` generator.** It works on 7.9.1 with no deprecation warning, output still lands in `node_modules/.prisma/client`, and `import { PrismaClient } from '@prisma/client'` is unchanged — which keeps `prismaImportBoundary` a live control needing no edit. Moving to the new `prisma-client` generator is a separate decision with its own costs (10 checked-in `.ts` files, `.prettierignore` entries, a module-scope write to `globalThis.__dirname`); it is **out of scope** and must not be attempted here.
- `@prisma/client` and `@metrika/database` may be imported only from `apps/api/src/infrastructure/persistence/**`. `$queryRawUnsafe` and `$executeRawUnsafe` are banned everywhere, persistence included.
- **`packages/testing` must not depend on `packages/database`, in either dependency block.** The edge runs one way. This upgrade requires **no change to `packages/testing` at all** — if you find yourself editing it, stop and report.
- No `any`. `@ts-ignore` is banned; `@ts-expect-error` and `eslint-disable` require a `-- <justification>` or CI fails.
- Every Prisma CLI call goes through the root `db:*` scripts (`scripts/prisma.mjs`). Do not run a bare `pnpm exec prisma` from inside `packages/database`.
- **Do not run `pnpm db:reset`, `prisma migrate reset`, `prisma db push --force-reset` or `prisma db push --accept-data-loss`.** Prisma 7 refuses all four under an AI agent by design, and the repository owner has chosen to run the reset check personally. Do not set `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`.
- Conventional commits scoped by package. **No `Co-Authored-By` trailer and no AI attribution of any kind.**
- Documentation ships in the same commit as the code it describes.
- ADRs are immutable. Supersede or scope with a new one; never edit an existing one beyond a status line.

## Gates

`pnpm verify` exit 0 · `pnpm test:integration` exit 0 (Docker required) · both CI suppression greps at `.github/workflows/ci.yml` run **verbatim**, exit 0, re-run immediately before each commit · `pnpm --filter @metrika/api openapi:emit` and `pnpm contracts:emit` produce no diff.

**One deliberate exception, at exactly one commit.** Task 2 lands the version bump, and `apps/api`'s integration suite is red between that commit and Task 3's — the lazy `$connect()` is a consequence of the bump and its fix belongs in `apps/api`, not `packages/database`. At Task 2's commit the gate is `pnpm verify` plus `packages/database`'s integration suite; `turbo run test:integration --filter=@metrika/api` is expected to fail, must be named in the commit body, and must be green again at Task 3. Nowhere else in this plan is a red gate acceptable.

**`pnpm verify` is not the whole gate.** CI additionally runs two suppression greps that `verify` does not. A task in the previous plan reported exit 0 and was still CI-red on that step.

## What this plan already knows, measured

Every claim below came from a spike that installed 7.9.1 and ran it. Do not re-derive them; do not trust them past the point where your own measurement disagrees — if it does, say so.

**Survives verbatim, no action needed:** `Prisma.defineExtension` with `query.$allModels.$allOperations`; the whole soft-delete extension including the `HardDeleteForbiddenError` refusals and the physically-present-`undefined` fixture; `withDeleted(fn)` and its `AsyncLocalStorage` mechanism, including across the await into an interactive transaction; interactive `$transaction` and `withOrganizationContext`'s `SELECT set_config('app.current_org_id', $1, true)`; extensions applying **inside** both transaction forms; batch `$transaction([...])`; tagged `$queryRaw`/`$executeRaw` and `Prisma.sql`/`Prisma.join`; `$extends` still dropping `$on`/`$use`, so the `as unknown as PrismaClient` widening in `createPrismaClient` and its TS2742 justification are unaffected; every existing migration file and `migration_lock.toml`; the Testcontainers harness's `migrate deploy` mechanism; the `dist/` plus conditional `exports` layout; all four `Prisma.PrismaClient*Error` classes on the `Prisma` namespace.

**Changes loudly, one test each:** the `P2010` `meta` shape; the `apps/api` boot test.

**Changes silently — the reason Tasks 4 and 5 exist:** `?schema=` is inert; `?connection_limit=` is inert and the default pool drops 17 → 10; `P2002` loses `meta.target`.

---

## File Structure

| File                                                        | Responsibility                                                                                                                                                                       | Task |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| `packages/database/prisma.config.ts`                        | **New.** The only place Migrate learns its URL, schema path and migrations path. Discovered relative to cwd, which is why `scripts/prisma.mjs` runs its child in `packages/database` | 1    |
| `packages/database/tsconfig.json`                           | Add `prisma.config.ts` to `include` so the type-aware ESLint zone can parse it                                                                                                       | 1    |
| `packages/database/prisma/schema.prisma`                    | Remove `url` from the `datasource` block; the block itself stays                                                                                                                     | 2    |
| `packages/database/package.json`                            | The three pins                                                                                                                                                                       | 2    |
| `packages/database/src/client.ts`                           | Construct `PrismaPg` and pass it as `adapter`; pool sizing now lives here, not in the URL                                                                                            | 2    |
| `packages/database/test/rls.integration.test.ts`            | One `P2010` assertion reshaped                                                                                                                                                       | 2    |
| `apps/api/src/infrastructure/persistence/prisma.service.ts` | Force one real backend in `onModuleInit`, because `pg.Pool` is lazy                                                                                                                  | 3    |
| `packages/database/test/pool.integration.test.ts`           | **New.** Pins the pool ceiling, which no existing test observes                                                                                                                      | 4    |
| `packages/database/test/adapter.integration.test.ts`        | **New.** Pins that `?schema=` in a URL is not what selects the schema                                                                                                                | 4    |
| `docs/adr/0037-prisma-7-driver-adapter.md`                  | **New.** Records what moved out of the connection URL and what `P2002` handling must read                                                                                            | 5    |
| `scripts/prisma.mjs`                                        | Correct reason (1); the mechanism is unchanged and stays                                                                                                                             | 5    |
| `CLAUDE.md`, `docs/LOCAL_DEVELOPMENT.md`                    | Three now-unreachable error strings and one falsified justification                                                                                                                  | 5    |

---

### Task 1: `prisma.config.ts`, still on 6.19.3

Configuration moves first, on the old version, so that Task 2's bump is the only variable in its own diff. Prisma 6.19.3 already accepts this file; 7.9.1 requires it.

**Files:**

- Create: `packages/database/prisma.config.ts`
- Modify: `packages/database/tsconfig.json`

**Interfaces:**

- Consumes: nothing.
- Produces: a config file that Task 2 depends on existing. `defineConfig` and `env` come from `prisma/config`, re-exported by the `prisma` package itself — **no new dependency**.

- [ ] **Step 1: Write the config file exactly**

`packages/database/prisma.config.ts`:

```ts
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: env('DATABASE_ADMIN_URL') },
});
```

`DATABASE_ADMIN_URL` is the **owner** role, deliberately: Migrate needs DDL rights. The running API never reads it — it passes `DATABASE_URL` (the `metrika_app` role) to `createPrismaClient()` programmatically.

- [ ] **Step 2: Run lint and watch it fail**

Run: `cd packages/database && pnpm exec eslint .`

Expected: FAIL with

```
Parsing error: "parserOptions.project" has been provided for @typescript-eslint/parser.
The file was not found in any of the provided project(s): prisma.config.ts
```

The zone is type-aware and `tsconfig.json`'s `include` does not name the new file.

- [ ] **Step 3: Add the file to `include`**

In `packages/database/tsconfig.json`, add `"prisma.config.ts"` to the `include` array. It sits alongside the `vitest.config.ts` entries already there, so this is the established pattern in this package, not a novelty.

- [ ] **Step 4: Verify both gates**

Run: `cd packages/database && pnpm exec eslint . ; echo ESLINT_EXIT=$?`
Expected: `ESLINT_EXIT=0`

Run: `cd packages/database && pnpm exec tsc -b --force ; echo TSC_EXIT=$?`
Expected: `TSC_EXIT=0`

- [ ] **Step 5: Prove the config is live on 6.19.3 before moving on**

Run from the repository root: `pnpm db:generate`

Expected: success. If it fails, the config file is wrong and Task 2 will be debugging two changes at once — fix it here.

- [ ] **Step 6: Full gate, then commit**

Run: `pnpm verify` — expected exit 0. Run both CI suppression greps verbatim — expected exit 0.

```bash
git add packages/database/prisma.config.ts packages/database/tsconfig.json
git commit -m "chore(database): move Migrate's configuration into prisma.config.ts"
```

---

### Task 2: The version bump

**Files:**

- Modify: `packages/database/package.json`, `packages/database/prisma/schema.prisma`, `packages/database/src/client.ts`, `packages/database/test/rls.integration.test.ts`

**Interfaces:**

- Consumes: `packages/database/prisma.config.ts` from Task 1.
- Produces: `createPrismaClient(config: DatabaseConfig): PrismaClient` — **signature unchanged**. Callers see nothing different. `DatabaseConfig` keeps its single `readonly databaseUrl: string` field.

- [ ] **Step 1: Bump the three pins**

In `packages/database/package.json`: `@prisma/client` → `7.9.1` in `dependencies`, `prisma` → `7.9.1` in `devDependencies`, and add `"@prisma/adapter-pg": "7.9.1"` to `dependencies`.

Then: `pnpm install`

Expect roughly +102 lockfile packages (1046 → 1135), mostly the CLI's `@prisma/studio-core` and `@prisma/dev`, which pull `react`/`react-dom` into this package's **dev** graph. No new `allowBuilds` entries are needed — verified from a scratch install. If `pnpm install` exits non-zero on an ignored build script, stop and report rather than adding an entry.

- [ ] **Step 2: Run generate and watch it fail on the schema**

Run: `pnpm db:generate`

Expected: FAIL with

```
Error code: P1012
error: The datasource property `url` is no longer supported in schema files.
```

- [ ] **Step 3: Delete the `url` line from the datasource block**

In `packages/database/prisma/schema.prisma`, remove the `url = env("DATABASE_ADMIN_URL")` line and the comment block explaining it — that explanation now belongs to `prisma.config.ts`. **Keep** `datasource db { provider = "postgresql" }`.

Run: `pnpm db:generate` — expected: success.

- [ ] **Step 4: Run typecheck and watch it fail on the constructor**

Run: `cd packages/database && pnpm exec tsc -b --force`

Expected: FAIL with

```
src/client.ts(29,5): error TS2353: Object literal may only specify known properties,
and 'datasources' does not exist in type 'PrismaClientOptions'.
```

- [ ] **Step 5: Install the driver adapter**

In `packages/database/src/client.ts`:

```diff
+import { PrismaPg } from '@prisma/adapter-pg';
 …
   const base = new PrismaClient({
-    datasources: { db: { url: config.databaseUrl } },
+    adapter: new PrismaPg({ connectionString: config.databaseUrl }),
   });
```

Leave the `as unknown as PrismaClient` widening and its comment exactly as they are — `$extends` still narrows the client the same way, and the TS2742 justification is unchanged.

Add this comment immediately above the `new PrismaPg(...)` line, because the fact is invisible at the call site and expensive to rediscover:

```ts
// A driver adapter is mandatory on Prisma 7. Two things that used to live in
// the connection URL now live here and are silently ignored there: `?schema=`
// (spell it `new PrismaPg(url, { schema })`) and `?connection_limit=` (pass
// pg.Pool options, or a pg.Pool). See ADR-0037.
```

Run: `cd packages/database && pnpm exec tsc -b --force` — expected: exit 0.

- [ ] **Step 6: Run the integration suite and watch one assertion fail**

Run: `cd packages/database && pnpm test:integration`

Expected: FAIL on one `P2010` assertion in `test/rls.integration.test.ts`.

- [ ] **Step 7: Reshape that one assertion**

```diff
     ).rejects.toMatchObject({
       code: 'P2010',
-      meta: { code: '42501', message: 'ERROR: permission denied for table _prisma_migrations' },
+      meta: {
+        driverAdapterError: {
+          cause: { code: '42501', message: 'permission denied for table _prisma_migrations' },
+        },
+      },
     });
```

Note the message no longer carries the `ERROR: ` prefix. `packages/database/src/errors.ts` needs **no** change — it holds only `HardDeleteForbiddenError`, which is ours.

- [ ] **Step 8: Verify the whole database package**

Run: `cd packages/database && pnpm test:integration`
Expected: **4 files, 24 tests, all passing.**

The spike reported "37/37" — that was 24 real tests plus a 13-test throwaway probe it wrote for the gaps the suite does not cover, then destroyed. Only the 24 are in the tree. If you see 37, something is generating files that should not exist.

- [ ] **Step 9: Commit**

Run `pnpm verify` and both CI greps verbatim. `apps/api`'s integration suite will still be red at this point — that is Task 3, and it is expected. Note it in the commit body rather than fixing it here.

```bash
git add packages/database/package.json packages/database/prisma/schema.prisma \
        packages/database/src/client.ts packages/database/test/rls.integration.test.ts pnpm-lock.yaml
git commit -m "chore(database): upgrade to Prisma 7.9.1 behind the pg driver adapter"
```

---

### Task 3: The API stops failing fast at boot

**Files:**

- Modify: `apps/api/src/infrastructure/persistence/prisma.service.ts`

**Interfaces:**

- Consumes: `createPrismaClient` from Task 2, unchanged.
- Produces: nothing new.

`pg.Pool` is lazy, so `$connect()` no longer opens a backend. Measured, counting backends in `pg_stat_activity` by `application_name`:

```
prisma 7.9.1 : {"before":0,"afterConnect":0,"afterQuery":1,"afterDisconnect":0}
prisma 6.19.3: {"before":0,"afterConnect":1,"afterQuery":1,"afterDisconnect":0}
```

`afterQuery: 1` on both rules out an `application_name` explanation. The consequence is larger than the failing test: a wrong `DATABASE_URL`, a firewalled database or bad credentials no longer surface at boot — they surface on the first request that touches Postgres, after the process has reported itself healthy.

- [ ] **Step 1: Run the boot test and read the failure**

Run: `turbo run test:integration --filter=@metrika/api`

Expected: FAIL with

```
FAIL apps/api > application boot > connects in onModuleInit and releases the pool in onModuleDestroy
AssertionError: expected 0 to be greater than or equal to 1
```

- [ ] **Step 2: Force one real backend**

In `apps/api/src/infrastructure/persistence/prisma.service.ts`:

```ts
async onModuleInit(): Promise<void> {
  await this.client.$connect();
  // pg.Pool is lazy on Prisma 7, so $connect() alone opens no backend and the
  // process would report itself healthy with an unreachable database. One
  // round trip restores fail-fast at boot. See ADR-0037.
  await this.client.$queryRaw`SELECT 1`;
}
```

Use the tagged template. `$queryRawUnsafe` is banned repository-wide.

- [ ] **Step 3: Verify**

Run: `turbo run test:integration --filter=@metrika/api`
Expected: `Test Files 9 passed (9)`, `Tests 108 passed (108)`

- [ ] **Step 4: Prove the guard is real, not decorative**

Delete the `$queryRaw` line, re-run the boot test, and confirm it goes red again. Restore it. Record both results in your report.

A control whose removal changes nothing is not a control — and a mutation that silently fails to apply is indistinguishable from a fixture that does not catch, so confirm your edit actually landed before recording the result.

- [ ] **Step 5: Full gate, then commit**

```bash
git add apps/api/src/infrastructure/persistence/prisma.service.ts
git commit -m "fix(api): open a real backend at boot, which Prisma 7 no longer does"
```

---

### Task 4: Pin the two silent changes

Two behaviour changes produce no error, no warning and no red test. Both are production-relevant. Neither has a fixture anywhere in this repository, which is exactly why they need one.

**Files:**

- Create: `packages/database/test/pool.integration.test.ts`
- Create: `packages/database/test/adapter.integration.test.ts`

**Interfaces:**

- Consumes: `withDatabase` from `packages/database/test/support.ts`, and `createPrismaClient` from `src/client.ts`.
- Produces: nothing other tasks import.

Read `packages/database/test/support.ts` before writing either file — `withDatabase(fn)` is the Prisma-shaped wrapper, `startTestDatabase()` and `stopDatabase` are its siblings.

**Isolation is each suite's own job.** One Postgres container serves the whole run, `withOrganizationContext` **commits**, and rows written by a test survive it. Scope by organization id, use ids unique to your suite, and never assert `toEqual([])` over a shared table.

- [ ] **Step 1: Write the failing pool test**

The measured ceilings, 20 parallel 300 ms queries on an 8-core host:

```
prisma 7.9.1 : {"noLimit":10,"connectionLimit3":10}
prisma 6.19.3: {"noLimit":17,"connectionLimit3":3}
```

6.19.3 honoured `?connection_limit=3` exactly and defaulted to `num_cpus * 2 + 1`. 7.9.1 ignores the parameter and uses `pg.Pool`'s own `max: 10`.

Write `packages/database/test/pool.integration.test.ts` asserting the property that matters, **not** the number 10: that a `?connection_limit=` in the URL does **not** change the observed ceiling, and that a ceiling passed through `PrismaPg`'s options **does**. Count concurrent backends by querying `pg_stat_activity` while parallel sleeps are in flight.

Assert on the _relationship_, so the test does not turn red on a different-core-count CI runner:

```ts
expect(withUrlParameter).toBe(withoutUrlParameter); // the URL parameter is inert
expect(withAdapterOption).toBeLessThan(withoutUrlParameter); // the adapter option is not
```

- [ ] **Step 2: Run it, watch it fail**

Run: `cd packages/database && pnpm test:integration -- pool`
Expected: FAIL — the file asserts against an adapter option you have not passed yet.

- [ ] **Step 3: Make the ceiling configurable**

In `packages/database/src/client.ts`:

```ts
export interface DatabaseConfig {
  /**
   * The APPLICATION role's URL (metrika_app), never the owner's. The owner
   * bypasses nothing — FORCE ROW LEVEL SECURITY sees to that — but it holds
   * DDL rights the running process has no business having.
   */
  readonly databaseUrl: string;
  /**
   * Ceiling on concurrent backends. On Prisma 6 this was `?connection_limit=`
   * in the URL; on 7 that parameter is inert and this is the only spelling
   * that works. Absent means pg.Pool's own default of 10 — which is itself a
   * change from Prisma 6's `num_cpus * 2 + 1`. See ADR-0037.
   */
  readonly maxPoolConnections?: number;
}

export function createPrismaClient(config: DatabaseConfig): PrismaClient {
  const base = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: config.databaseUrl,
      ...(config.maxPoolConnections === undefined
        ? {}
        : { max: config.maxPoolConnections }),
    }),
  });

  return base.$extends(softDeleteExtension) as unknown as PrismaClient;
}
```

The conditional spread is not stylistic: `exactOptionalPropertyTypes` is on, so a plain `max: config.maxPoolConnections` would pass `undefined` through as a present key.

- [ ] **Step 4: Run it, watch it pass**

Run: `cd packages/database && pnpm test:integration -- pool` — expected: PASS.

- [ ] **Step 5: Write the schema test**

Every URL in this repository carries `?schema=public` — `.env.example:148`, `docs/LOCAL_DEVELOPMENT.md:345`, `.github/workflows/ci.yml:62`, and both URLs the Testcontainers harness builds. Nothing breaks today because `public` is `pg`'s default `search_path`. It breaks silently the first time a URL points at a non-public schema.

Measured:

```
prisma 7.9.1 : QUERY SUCCEEDED — ?schema= was IGNORED
prisma 6.19.3: QUERY FAILED     — ?schema= was honoured
```

Write `packages/database/test/adapter.integration.test.ts`. The first assertion is the tripwire: if a future Prisma restores URL handling, it goes red and someone reads the comment.

```ts
it('ignores ?schema= in the connection URL', async () => {
  await withDatabase(async (db) => {
    // A schema that does not exist. On Prisma 6 this made every query fail;
    // on 7 the parameter never reaches pg, so the query succeeds against
    // pg's default search_path instead. Red here means URL handling came
    // back and every ?schema= in the repo means something again.
    const url = `${applicationUrl}?schema=definitely_not_a_real_schema`;
    const probe = createPrismaClient({ databaseUrl: url });
    await expect(probe.$queryRaw`SELECT 1 AS one`).resolves.toEqual([{ one: 1 }]);
    await probe.$disconnect();
  });
});

it('selects a schema through the adapter, not the URL', async () => {
  // The correct spelling on Prisma 7. Assert that a real, non-public schema
  // is actually reached — a passing query alone would not distinguish this
  // from the parameter being ignored a second time.
});
```

Fill the second test in against a schema you create in the fixture. A test that cannot tell "the option worked" from "the option was ignored" measures nothing — that failure mode cost the previous plan nine findings.

- [ ] **Step 6: Run both, then commit**

Run: `cd packages/database && pnpm test:integration` — expected: all files pass.

```bash
git add packages/database/test/pool.integration.test.ts \
        packages/database/test/adapter.integration.test.ts packages/database/src/client.ts
git commit -m "test(database): pin the two Prisma 7 changes that are silent at every gate"
```

---

### Task 5: The documents the upgrade falsified

Three statements in this repository are now wrong, and one of them is wrong in the direction that would tempt someone to delete a load-bearing script.

**Files:**

- Create: `docs/adr/0037-prisma-7-driver-adapter.md`
- Modify: `scripts/prisma.mjs`, `CLAUDE.md`, `docs/LOCAL_DEVELOPMENT.md`

- [ ] **Step 1: Correct `scripts/prisma.mjs`'s stated reason**

Its reason (1) says "Prisma's dotenv search never reaches the repository root." That is now understated to the point of being wrong: **Prisma 7 performs no dotenv loading whatsoever.** Measured — a `.env` sitting both beside the schema and in the cwd is not read:

```
$ env -u DATABASE_ADMIN_URL pnpm exec prisma migrate deploy
Error: PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_ADMIN_URL.
```

Rewrite reason (1) to say that `--env-file-if-exists` is now the _only_ thing putting the root `.env` into the environment. **The script's mechanism is unchanged and correct — do not change the code.** Add to its reason (3) that running the child with `cwd = packages/database` is now load-bearing for a second reason: `prisma.config.ts` is discovered relative to cwd, and `--schema` alone does not find it.

- [ ] **Step 2: Correct the two unreachable error strings**

`docs/LOCAL_DEVELOPMENT.md:204` and its troubleshooting table at `:309` both quote `Environment variable not found: DATABASE_ADMIN_URL` verbatim. That string is unreachable on 7 — the failure is now `PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_ADMIN_URL`, reported by a different subsystem. Replace both with the text a developer will actually see.

While there: `prisma studio`'s default port moved from **5555 to 51212**. Correct it wherever it appears.

- [x] **Step 2b: the inert `?schema=public` URLs — ALREADY DONE in Task 4, do not redo**

This step was dispatched to Task 4 by mistake and executed there in commit `a5589bb`. It is recorded here rather than deleted, because two of its facts were wrong in this plan and the corrections matter to Step 4's ADR.

**This plan said four URLs. There are six** in the three in-scope files — `.env.example:147` and `:148`, `docs/LOCAL_DEVELOPMENT.md:344` and `:345`, `.github/workflows/ci.yml:62` and `:439`. The three unnamed siblings were found by the implementer, not by this plan. All six are removed.

**Left in place deliberately, and each needs a line in the ADR:**

- `packages/testing/src/database.ts:58` — `urlFor` appends `?schema=public` to both URLs it builds. Excluded by the do-not-touch constraint on that package, so it is a genuine follow-up rather than an oversight.
- `apps/api/test/env.test.ts:5` and `apps/api/test/health.test.ts:15` — unit-test fixture strings, not real connection strings. This plan never enumerated them. They are harmless, but a reader grepping for `?schema=` should find them explained rather than assume the sweep missed them.

Nothing broke: `public` is `pg`'s default `search_path`, and the integration suites were re-run green after the change rather than assumed.

- [ ] **Step 3: Correct `CLAUDE.md`**

Its Commands section explains the root `db:*` scripts by saying a bare `pnpm exec prisma` inside `packages/database` "cannot find `DATABASE_ADMIN_URL`". Still true, different reason. Update it, and keep the conclusion — the scripts are more necessary now, not less.

- [ ] **Step 4: Write ADR-0037**

Record what moved and what it costs. The decision is _not_ "upgrade to Prisma 7" — it is what the driver adapter changed about where configuration lives.

Cover, each with the measurement beside it:

- **Two things left the connection URL silently.** `?schema=` is inert; `?connection_limit=` is inert and the default pool drops 17 → 10. Both now live in `PrismaPg`'s options. Name the fixtures from Task 4 that hold the line.
- **`$connect()` no longer opens a backend**, so fail-fast at boot is now a deliberate extra round trip rather than a property of the client. Name the boot test.
- **`P2002` lost `meta.target`.** The constraint identity now lives under `meta.driverAdapterError.cause`, and `P2025`'s `meta` changed shape too. Nothing reads either today — which is the point. `CLAUDE.md` requires that "every async operation is idempotent by a **database unique constraint**", so `P2002` handling is coming, and whatever reads it must read the new shape. **Nothing in this repository would catch getting that wrong.** State it here so the next implementer finds it.
- **Why `prisma-client-js` was kept** and what moving generators would cost, so that decision is recorded rather than re-litigated.
- State plainly that **`pnpm db:reset` is unverified on 7.9.1**: Prisma 7 refuses `migrate reset`, `db push --force-reset` and `db push --accept-data-loss` under an AI agent, keyed off the `CLAUDECODE` environment variable. `migrate deploy`, `migrate dev`, `generate`, `migrate status` and `studio` are ungated and were all measured clean. The repository owner runs the reset check personally.

Mark every claim with its measurement. Where something is inference rather than measurement, label it as inference — three ADRs in the previous plan carried a false statement, and each was a sentence that _sounded like_ a consequence of something measured.

- [ ] **Step 5: Full gate, then commit**

Run `pnpm verify`, `pnpm test:integration`, both CI greps verbatim, and the two emit gates.

```bash
git add docs/adr/0037-prisma-7-driver-adapter.md docs/adr/README.md \
        scripts/prisma.mjs CLAUDE.md docs/LOCAL_DEVELOPMENT.md
git commit -m "docs(database): record what the driver adapter moved out of the URL"
```

---

## Notes for the executing agent

**Verify each mutation applied _and_ completely** before recording its result. In the previous plan a `perl` substitution silently missed a line prettier had reflowed and read as a passing fixture; another replaced only the first of two call sites. State the apparatus any green result ran under.

**The clean-clone run is worth the time.** In both previous plans it surfaced something warm checkouts never showed. This upgrade changes a lockfile and a generator step, which is exactly the shape that hides in a warm `node_modules`.

**Do not touch `packages/testing`.** The harness works unchanged, and it works _because_ it runs `migrate deploy` with `cwd = packages/database` — where `prisma.config.ts` is now discovered — and passes the URL through the child environment where `env('DATABASE_ADMIN_URL')` reads it. Both halves are proven by the suite running green, including `assertDatabaseReachable`'s `SELECT 1 FROM "HealthCheck"` probe, which only passes if migrations really ran.

**If a measurement in this plan disagrees with what you observe, believe your measurement and report the difference.** These numbers came from one spike on one machine.
