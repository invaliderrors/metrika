# ADR-0037 — the `pg` driver adapter moved configuration out of the connection URL

**Status:** Accepted · **Date:** 2026-08-12 · **Scopes part of**
[ADR-0005](./0005-prisma.md). ADR-0005's decision — Prisma as the ORM, confined
to the persistence layer — is unchanged. What this records is where Prisma's
configuration lives after the 6.19.3 → 7.9.1 upgrade, because a driver adapter
moved four things out of places this repository had written them down.

> **Every claim below is labelled MEASURED, INHERITED or INFERENCE.** MEASURED
> means run against this tree at 7.9.1 during this upgrade. INHERITED means it
> came from the upgrade spike, on a machine that no longer exists in this state,
> and cannot be reproduced here — 6.19.3 is not in `pnpm-lock.yaml` and no
> workspace package resolves to it. INFERENCE means reasoned, not run. The
> previous plan shipped three ADRs carrying a false statement, and all three had
> the same shape: a sentence that reads like a consequence of something
> genuinely measured, sitting beside claims that were.

## Context

Prisma 7 requires a driver adapter for PostgreSQL. `datasources: { db: { url } }`
is gone from `PrismaClientOptions`, `url` is no longer accepted in a `datasource`
block, and Migrate's configuration moved to `prisma.config.ts`. The upgrade
landed across five commits on `chore/prisma-7`, beginning with `13bf289`
(`prisma.config.ts`, still on 6.19.3) and `59680e3` (the version bump).

The decision worth recording is not "upgrade to Prisma 7". It is that the
adapter relocated configuration which this repository had spelled out in
connection URLs, and that **most of those relocations are silent**: no error, no
warning, no red test, nothing from `tsc` or ESLint. A URL still parses. The
process still starts. Only the behaviour differs.

## What moved

### 1. `?schema=` in the connection URL is inert

**MEASURED**, `packages/database/test/adapter.integration.test.ts`, on every
integration run: a client built from a URL naming `definitely_not_a_real_schema`
resolves `healthCheck.findUnique` against `public` and returns the row. The test
first asserts, against `pg_namespace`, that no schema by that name exists — so
"the schema is absent" is a measurement and not an assumption.

The schema now belongs to the adapter's second argument:
`new PrismaPg({ connectionString }, { schema })`. The same file's second test
proves that spelling reaches a real schema, by **content in both directions**:
`public` and a fixture-created `metrika_adapter_probe` hold different rows in
identically shaped tables, and each client sees exactly one of them.

**MEASURED, and the sharpest detail in this document:**
`@prisma/adapter-pg@7.9.1` implements `schema` as
`getConnectionInfo().schemaName` (`dist/index.mjs:719`). It **qualifies generated
SQL and never sets `search_path`**. Measured against one container: with a
nonexistent schema supplied, `` $queryRaw`SELECT 1` `` resolves whether the
schema is honoured or ignored, while `healthCheck.findUnique()` resolves when it
is ignored and throws `P2021` when it is honoured. A `$queryRaw`-based tripwire
is therefore **structurally incapable** of detecting a regression here. The first
version of that fixture was built exactly that way and could not go red; commit
`9a0f882` rebuilt both tests on model delegates and added a positive control
that demonstrates the red state on every run.

**INHERITED:** on 6.19.3 the same URL made the query fail, i.e. `?schema=` was
honoured. Not reproducible from this tree.

### 2. `?connection_limit=` is inert, and the default ceiling fell

**MEASURED**, `packages/database/test/pool.integration.test.ts`, on every
integration run. Twenty-four parallel 300 ms queries with a separate observer
client sampling `pg_stat_activity` every 10 ms and keeping the peak; the ceiling
is the only thing that can stop all twenty-four from running at once, so the peak
**is** the ceiling. Three measurements, and the file asserts their relationships
rather than any absolute number:

| client                                  | peak backends      | assertion                       |
| --------------------------------------- | ------------------ | ------------------------------- |
| plain URL                               | 10 on this machine | `> 3` — real concurrency exists |
| URL + `?connection_limit=3`             | equal to baseline  | the parameter is **inert**      |
| `maxPoolConnections: 3` via the adapter | exactly 3          | the ceiling **moved**, not gone |

The first row is what makes the second worth anything: an apparatus measuring
nothing reports 0/0/0, and `0 === 0` reads as a passing finding about Prisma
while actually being a passing finding about a broken probe.

**MEASURED:** absent a ceiling, 7.9.1 uses `pg.Pool`'s own default `max`, which
is 10 on this machine. The fixture deliberately does not assert `10` —
`pg.Pool`'s default is not ours to pin.

**INHERITED:** 6.19.3 measured `{"noLimit":17,"connectionLimit3":3}` — it
honoured the URL parameter exactly and defaulted to `num_cpus * 2 + 1` on an
8-core spike host.

**The headline "17 → 10" is therefore two claims of different quality**, and the
difference matters: that 7.9.1 defaults to `pg.Pool`'s `max` is re-measured on
every run; that 6.19.3 defaulted to 17 is inherited and host-specific.
**INFERENCE**, from the formula rather than from a run: because 6's default
scaled with core count and 7's does not scale at all, the drop is larger on
bigger hosts — a 16-core production box would have been 33 and is now 10.

**MEASURED:** nothing sets a ceiling today.
`apps/api/src/infrastructure/persistence/prisma.service.ts:16` passes only
`databaseUrl`, and it is the sole non-test caller of `createPrismaClient` in the
repository. The API runs on `pg.Pool`'s default. That is stated so the number is
a decision someone can revisit rather than an accident nobody chose.

### 3. `$connect()` no longer opens a backend

**MEASURED** (Task 3, and re-provable at any time by deleting one line):
`apps/api/test/boot.integration.test.ts` went red on the version bump with
`expected 0 to be greater than or equal to 1`, and green once `onModuleInit`
followed `$connect()` with `` await this.client.$queryRaw`SELECT 1` ``. Deleting
that line turns the suite red again with a byte-identical failure signature.

**INHERITED**, the spike's backend counts by `application_name`:

```
prisma 7.9.1 : {"before":0,"afterConnect":0,"afterQuery":1,"afterDisconnect":0}
prisma 6.19.3: {"before":0,"afterConnect":1,"afterQuery":1,"afterDisconnect":0}
```

`afterQuery: 1` on both rules out an `application_name` explanation for the
7.9.1 row.

The consequence is larger than the failing test. **Fail-fast at boot is now
something this repository does, not a property of the client.** A wrong
`DATABASE_URL`, a firewalled database or bad credentials no longer surface while
the process is starting; without that round trip they surface on the first
request that touches Postgres, after the process has already reported itself
healthy. The line looks redundant next to `$connect()` and is not.

### 4. `P2002` lost `meta.target`, and `P2025`'s `meta` changed shape

**MEASURED on this tree**, 7.9.1 against a live container, by a throwaway probe
written for this ADR and deleted after it ran: a duplicate primary key on
`HealthCheck`, and an `update` against an id that does not exist.

```
code: 'P2002'
meta: {
  modelName: 'HealthCheck',
  driverAdapterError: DriverAdapterError: UniqueConstraintViolation {
    cause: {
      originalCode: '23505',
      originalMessage: 'duplicate key value violates unique constraint "HealthCheck_pkey"',
      kind: 'UniqueConstraintViolation',
      constraint: { fields: [ 'id' ] }
    }
  }
}
meta.target: undefined
```

```
code: 'P2025'
meta: { modelName: 'HealthCheck', operation: 'an update' }
```

`meta.target` — the field pre-7 code reads to learn _which_ constraint fired — is
`undefined`. The constraint's identity is now
`meta.driverAdapterError.cause.constraint.fields` (the field names) and
`meta.driverAdapterError.cause.originalMessage` (the constraint's own name).
`P2025` carries `{ modelName, operation }`.

**MEASURED:** `JSON.stringify(meta)` preserves all of it —
`driverAdapterError` is an `Error` whose `cause` is an own enumerable property —
so a structured log line does not silently drop the constraint.

**MEASURED, and it is a trap:** `cause` does not have one shape.

| code                           | `meta.driverAdapterError.cause`                       |
| ------------------------------ | ----------------------------------------------------- |
| `P2010` — raw query failed     | `{ code, message }`                                   |
| `P2002` — unique violation     | `{ originalCode, originalMessage, kind, constraint }` |
| `P2021` — table does not exist | `{ originalCode, originalMessage, kind }`             |

`P2010`'s shape is already pinned at
`packages/database/test/rls.integration.test.ts:249`; the other two rows are from
this upgrade's own runs. "Read `meta.driverAdapterError.cause`" is therefore not
one instruction — read the shape belonging to the code being handled.

**Limit of the P2002 measurement, stated rather than glossed:** one violation, on
a **primary key**. Whether a named `@@unique` composite reports `constraint`
identically is **UNVERIFIED** — no model in this schema has one yet.

**Nothing in this repository reads either error's `meta` today, and that is
precisely why this section exists.** `CLAUDE.md` requires that every async
operation be idempotent by a **database unique constraint, not an application
check**, so `P2002` handling arrives with the first outbox row, job or upload
dedupe in Phase 1. **MEASURED, from the shipped types:**
`PrismaClientKnownRequestError` declares `meta?: Record<string, unknown>`
(`@prisma/client-runtime-utils@7.9.1`), so reading `meta.target` is not a type
error — `tsc` cannot report that the field is gone, ESLint has nothing to say,
and there is no fixture anywhere asserting `P2002`'s shape. **Nothing in this
repository would catch getting it wrong.** Whoever writes that handler writes a
fixture with it.

### 5. `prisma-client-js` was kept

**MEASURED:** it works on 7.9.1 unchanged. `pnpm db:generate` reports
`✔ Generated Prisma Client (v7.9.1)`, the output still lands inside the
`@prisma/client` package, and `import { PrismaClient } from '@prisma/client'` is
untouched — which keeps the `prismaImportBoundary` ESLint rule a live control
needing no edit. `prisma generate` prints no deprecation warning.

**MEASURED, worth knowing anyway:** the 7.9.1 CLI's own generator picker labels
the two options `prisma-client` → "Prisma Client" and `prisma-client-js` →
"Legacy Prisma Client JS" (`prisma/build/cli.js`). "Legacy" is the CLI's word in
a scaffolding menu, not a warning emitted on any command we run.

**INHERITED**, from the upgrade plan's Global Constraints, which attribute it to
the spike and which this upgrade did not re-run: moving to the `prisma-client`
generator would cost roughly ten checked-in generated `.ts` files,
`.prettierignore` entries for them, and a module-scope write to
`globalThis.__dirname`. It was ruled out of scope for the upgrade. Recorded here
so the choice reads as a decision rather than an oversight — and so that a future
move is costed against this list rather than discovered.

### 6. Configuration lives in `prisma.config.ts`, found relative to cwd

**MEASURED:** Prisma 7 performs **no dotenv loading whatsoever** — not beside the
schema, not in the cwd, not at the repository root. The root `.env` reaches
Prisma only because every `db:*` script is
`node --env-file-if-exists=.env scripts/prisma.mjs …`. With
`DATABASE_ADMIN_URL` unset, from `packages/database`:

```
Failed to load config file ".../packages/database" as a TypeScript/JavaScript module.
Error: PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_ADMIN_URL.
```

That is `prisma.config.ts` resolving `env('DATABASE_ADMIN_URL')`, before any
database is contacted — a different subsystem from Prisma 6's
`Environment variable not found: DATABASE_ADMIN_URL`, which is **unreachable on
7**. `CLAUDE.md` and `docs/LOCAL_DEVELOPMENT.md` both quoted the old string and
are corrected in the same commit as this ADR.

**MEASURED, correcting a prediction made while planning this task:** the upgrade
plan expected `pnpm db:generate` to print
`Prisma config detected, skipping environment variable loading.` It does not. It
prints `Loaded Prisma config from prisma.config.ts.` That string exists **only**
in 6.19.3's CLI bundle and not in 7.9.1's: 6 skipped its dotenv search when a
config file was present and said so, whereas 7 has no search to skip. The
practical consequence is the same and the mechanism is not, which is the whole
reason this ADR labels its claims.

**MEASURED,** `prisma validate` run both ways with the variable unset:

| cwd                 | `--schema`                               | outcome                                         |
| ------------------- | ---------------------------------------- | ----------------------------------------------- |
| repository root     | `packages/database/prisma/schema.prisma` | "The schema … is valid" — **config not loaded** |
| `packages/database` | `prisma/schema.prisma`                   | `PrismaConfigEnvError` — **config loaded**      |

So `prisma.config.ts` is discovered **relative to cwd**, and `--schema` does not
find it. `scripts/prisma.mjs` already ran its child in `packages/database` for an
unrelated pnpm reason (a workspace package's bins are not linked into the root
`node_modules/.bin`); on Prisma 7 that cwd is load-bearing a second time, and
dropping it while keeping `--schema` would run Migrate with no datasource URL and
no migrations path at all. The same mechanism is what makes the Testcontainers
harness work unchanged: it runs `migrate deploy` with `cwd = packages/database`
and passes the URL through the child environment.

### 7. `pnpm db:reset` is unverified on 7.9.1

**MEASURED, statically, from `prisma@7.9.1/build/cli.js`:** the CLI ships an
AI-agent detector — `CLAUDECODE` identifies Claude Code, alongside entries for
Codex CLI, Gemini CLI, Qwen Code, Cursor, GitHub Copilot CLI, OpenCode, Cline,
Goose, Amp, Crush, Aider, Augment Code, Antigravity, Replit Agent and Devin — and
a consent check that throws unless `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`
is set. The bundle contains **exactly three** call sites of that check:
`db push --force-reset`, `db push --accept-data-loss`, and `migrate reset`. In
`migrate reset` the check runs **after** the `--force` early-out, so `--force`
does not bypass it — and `pnpm db:reset` is `prisma migrate reset --force`.

`migrate deploy`, `migrate dev`, `generate`, `migrate status` and `studio`
contain no such call site, and the ones this upgrade needed were run clean.

**`pnpm db:reset` has therefore not been run on 7.9.1.** The repository owner
runs that check personally; the consent variable was never set and none of the
four gated commands were attempted. **That is a decision taken deliberately, not
a gap that went unnoticed.**

What is unverified is narrow and worth naming precisely. **INFERENCE, labelled:**
`migrate reset` reads the same two `prisma.config.ts` fields — `datasource.url`
and `migrations.path` — that `migrate deploy` reads, and `migrate deploy` under
that config is exercised on every integration run by the Testcontainers harness,
whose `SELECT 1 FROM "HealthCheck"` probe only passes if migrations really ran.
So reset is expected to work. It has not been run.

**MEASURED:** `prisma studio`'s default port moved from **5555 to 51212**
(`var Unt=51212` in the 7.9.1 CLI bundle, whose own completion metadata
describes `51212` as "Default Studio port" and `5555` as a "Common custom port").
`docs/LOCAL_DEVELOPMENT.md` says so; Studio itself was not started.

### 8. The `?schema=public` sweep, and the three survivors

Commit `a5589bb` removed six inert `?schema=public` parameters, not the four the
upgrade plan named: `.env.example:147` and `:148`,
`docs/LOCAL_DEVELOPMENT.md:344` and `:345`, `.github/workflows/ci.yml:62` and
`:439`. Each of those three files carried a second occurrence the plan's line
references did not enumerate. Nothing broke — `public` is `pg`'s default
`search_path` — and both integration suites were re-run green after the removal
rather than assumed.

**Three occurrences remain, deliberately.** A reader grepping for `?schema=`
should find them explained here rather than conclude the sweep was careless:

1. **`packages/testing/src/database.ts:58`** — `urlFor()` appends
   `?schema=public` to both URLs it builds. The upgrade plan forbade touching
   `packages/testing` at all, so this is a genuine follow-up rather than an
   oversight. It is inert, so it changes nothing today.
   `adapter.integration.test.ts` depends on it only in that its
   `searchParams.set` replaces rather than appends, and both of that test's URL
   assertions hold either way — so removing it later will not break the fixture.
2. **`apps/api/test/env.test.ts:5`** — a fixture string for `ConfigModule`'s Zod
   validation, not a connection string. Changing a validation fixture changes
   what is being validated.
3. **`apps/api/test/health.test.ts:15`** — `REFUSED_URL`, a deliberately
   unreachable address.

## Decision

1. **Configuration that used to live in the connection URL lives in `PrismaPg`'s
   options.** A `?schema=` or `?connection_limit=` anywhere in this repository is
   a parameter that looks load-bearing and is not, which is worse than an absent
   one. The schema is `new PrismaPg(url, { schema })`; the pool ceiling is
   `DatabaseConfig.maxPoolConnections`, which becomes `pg.Pool`'s `max`.

2. **Both are held by fixtures, not by comments.**
   `packages/database/test/adapter.integration.test.ts` and
   `packages/database/test/pool.integration.test.ts` go red if a future Prisma
   restores URL handling — which would be good news, and would mean every
   `?schema=` in the tree means something again.

3. **Any fixture for adapter-level schema selection queries through a model
   delegate.** `$queryRaw` cannot observe the setting at all, so a raw-SQL
   tripwire here is green by construction. This is written into both test files
   as well, at the top, where someone about to "simplify" one will see it.

4. **Fail-fast at boot is a deliberate round trip.** `PrismaService.onModuleInit`
   keeps its `` $queryRaw`SELECT 1` `` after `$connect()`, and
   `apps/api/test/boot.integration.test.ts` is what stops it being deleted as
   redundant.

5. **`P2002` handling, when it arrives, reads `meta.driverAdapterError.cause` and
   ships with a fixture asserting that shape.** `meta.target` is gone and nothing
   in this repository would tell you.

6. **`prisma-client-js` stays.** Moving generators is a separate decision with
   the costs listed in §5, not a step in an upgrade.

7. **Every Prisma CLI call keeps going through `scripts/prisma.mjs`**, whose two
   load-bearing behaviours are now `--env-file-if-exists` (Prisma 7 loads no
   `.env` at all) and `cwd = packages/database` (where `prisma.config.ts` is
   discovered). Both reasons are written into that file.

8. **`pnpm db:reset` is verified by the repository owner, not by an agent.** No
   agent sets `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` and no agent runs
   `migrate reset`, `db push --force-reset` or `db push --accept-data-loss`.

## Consequences

**Accepted:** a connection URL is no longer a complete description of how this
application talks to Postgres. Two settings that an operator could once change by
editing a string now require a code change and a deploy. That is a real loss of
operational flexibility, and it buys the thing that makes it worth paying — the
settings are now typed, reviewed, and covered by fixtures, instead of living in
an environment variable where a typo is silent.

**Accepted:** `apps/api` runs on `pg.Pool`'s default ceiling of 10 rather than
the ~17 it had before, and nobody has chosen 10. It is written down here so the
first connection-exhaustion incident starts from a known number rather than an
archaeology exercise.

**Gained:** three silent behaviour changes now have fixtures that run on every
integration pass, and one of those fixtures was found to be incapable of failing
before it was trusted. The measurement that caught it — that
`@prisma/adapter-pg` qualifies SQL rather than setting `search_path` — is the
kind of thing that is cheap to learn once and expensive to rediscover.

**Not verified, and listed rather than left implicit:** `pnpm db:reset` on
7.9.1; `P2002`'s `constraint` shape for a named `@@unique` composite rather than
a primary key; whether `prisma studio` starts (only its default port was read,
from the CLI bundle). Every 6.19.3 number in this document is inherited from the
upgrade spike and cannot be reproduced from this tree.
