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
landed on `chore/prisma-7` across the five tasks of
[the upgrade plan](../superpowers/plans/2026-08-12-prisma-7-upgrade.md),
beginning with `13bf289` (`prisma.config.ts`, still on 6.19.3) and `59680e3`
(the version bump). It is deliberately not described here as a count of commits:
corrections and review rounds mean the tasks and the commits are not in
one-to-one correspondence, and an earlier draft of this sentence gave a number
that was wrong twice over.

The decision worth recording is not "upgrade to Prisma 7". It is that the
adapter relocated configuration which this repository had spelled out in
connection URLs, and that **most of those relocations are silent**: no error, no
warning, no red test, nothing from `tsc` or ESLint. A URL still parses. The
process still starts. Only the behaviour differs.

One relocation was the opposite of silent — it failed four of five CI jobs
outright — and was still invisible to every gate anyone ran locally, for a
different reason. That is §6a, and it was found by CI after this branch had been
reviewed and declared ready to merge.

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
integration run. Twenty-four simultaneous 300 ms queries, each reporting its own
`pg_backend_pid()`; the ceiling is the only thing that can stop the pool opening
one connection per query, so the size of the distinct set **is** the ceiling.
Three measurements, and the file asserts their relationships rather than any
absolute number:

| client                                  | distinct backends  | assertion                       |
| --------------------------------------- | ------------------ | ------------------------------- |
| plain URL                               | 10 on this machine | `> 3` — real concurrency exists |
| URL + `?connection_limit=3`             | equal to baseline  | the parameter is **inert**      |
| `maxPoolConnections: 3` via the adapter | exactly 3          | the ceiling **moved**, not gone |

The first row is what makes the second worth anything: an apparatus measuring
nothing reports 1/1/1, and `1 === 1` reads as a passing finding about Prisma
while actually being a passing finding about a broken probe.

**The observable was chosen, not inherited, and the first choice was wrong.**
Until the branch review this fixture polled `pg_stat_activity` from a separate
observer client and kept the highest sample. A sampler can only ever
**under-count**, and both findings above are equalities — so MEASURED, with the
poll loop delayed by 250/400/700 ms over 7 runs, it reported `{base: 4, url: 3,
opt: 3}`: **the URL parameter appearing to be honoured.** Not a flake, a false
positive shaped exactly like the Prisma regression this fixture exists to detect,
and no one-sided bound repairs it. Neither synthetic load at 35 nor the real root
gate at load 40-50 reproduced it — which is why the mechanism had to be forced
rather than waited for. The pid design measured 10/10/3 across all 22 runs of the
paired comparison, and 3 further runs on this machine at load 84.

What that costs, recorded in the fixture too: it counts connections the pool
**opened**, not backends simultaneously **active** — identical for `pg.Pool`,
which never exceeds `max` and reuses an idle connection before opening a new one,
but not the same concept, and `pg.Pool`'s `maxLifetimeSeconds` (default:
disabled) is what keeps recycling from inflating the count. It also gives up the
independent `pg_stat_activity` cross-check.

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

**MEASURED on this tree**, 7.9.1 against a live container — first by a throwaway
probe written for this ADR, and now re-measured on every integration run by
`packages/database/test/error-shape.integration.test.ts`: a duplicate primary key
on `HealthCheck`, and an `update` against an id that does not exist.

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

**MEASURED, and it is the trap in this section:** `cause` does not have one
shape, and **the Prisma error code is not what selects it**. The discriminator is
`cause.kind`.

| Prisma code | SQLSTATE | `cause.kind`                | `cause` keys                                                                         |
| ----------- | -------- | --------------------------- | ------------------------------------------------------------------------------------ |
| `P2010`     | `42501`  | `postgres`                  | `originalCode, originalMessage, kind, code, severity, message, detail, column, hint` |
| `P2010`     | `42P01`  | `TableDoesNotExist`         | `originalCode, originalMessage, kind, table`                                         |
| `P2010`     | `23505`  | `UniqueConstraintViolation` | `originalCode, originalMessage, kind, constraint: { fields }`                        |
| `P2002`     | `23505`  | `UniqueConstraintViolation` | `originalCode, originalMessage, kind, constraint: { fields }`                        |

All four measured on 7.9.1 against a live container during this upgrade. Read the
table by rows and then by columns, because both directions carry a warning:

- **`P2010` alone has three shapes.** Keying on the Prisma code tells you almost
  nothing about which fields are present. An earlier draft of this ADR gave
  `P2010`'s `cause` as `{ code, message }` — that is a strict _subset_ of the
  `42501` row only, and it is absent from the other two.
- **`originalCode`, `originalMessage` and `kind` are on all four.** They are the
  only fields that can be read without first establishing which case you are in.
- **The same database event produces two different Prisma codes.** A unique
  violation is `P2002` through a model delegate and `P2010` through
  `$executeRaw` — one row apart in the table, identical in `kind`.

**That last row is the one that lands on Phase 1.** `CLAUDE.md` requires every
async operation to be idempotent by a database unique constraint; the moment any
of that idempotency is claimed with raw SQL — a bulk insert, an outbox claim, an
`ON CONFLICT` written by hand — a handler keyed on `code === 'P2002'` stops
firing, with no error and no test to say so. **Key on `cause.kind`.**

**Held by a fixture, not by this document:**
`packages/database/test/error-shape.integration.test.ts` pins all of it — the
absent `meta.target`, the constraint identity under `cause`, and the
`P2002`/`P2010` pair for one and the same violation. Both of its consequential
assertions were verified by mutation (`P2010` → `P2002`, and the composite's
field list shortened) and go red.

**The composite case is no longer unverified.** An earlier draft of this section
marked it UNVERIFIED, because the only measurement behind it was a single-column
primary key and that cannot distinguish "`fields` lists every column" from
"`fields` happens to have one entry". MEASURED since, against a constraint named
the way Prisma names `@@unique([a, b])`: `constraint: { fields: ['a', 'b'] }` —
both columns, in declaration order, same shape. It is the third test in that
fixture.

**No production code reads either error's `meta` today, and that is precisely why
this section exists.** **MEASURED, from the shipped types:**
`PrismaClientKnownRequestError` declares `meta?: Record<string, unknown>`
(`@prisma/client-runtime-utils@7.9.1`), so reading `meta.target` is **not a type
error** — `tsc` cannot report that the field is gone and ESLint has nothing to
say. A handler that reads the pre-7 field compiles, lints, and returns
`undefined` at runtime for every violation it was written to catch.

That is what the fixture above now stands in the way of, and it is the only thing
that does. Whoever writes the Phase 1 handler extends it rather than trusting
this document: a claim without a fixture is an intention, and §4 was the section
of this ADR with the largest consequence and, until the branch review, nothing
holding it.

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

#### 6a. The consequence that broke CI: the variable became a build input

**This is the sharpest thing in this document, and it was discovered by CI after
the branch was declared ready to merge.** Four of five jobs failed —
`verify`, `web`, `openapi`, `integration`, exactly the four §6's `ci.yml` note
predicts — while `contracts`, which runs no build, passed.

**MEASURED**, and the two lines have to be read together:

```
verify  Build  DATABASE_ADMIN_URL: ***127.0.0.1:5432/metrika_ci
verify  Build  Error: PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_ADMIN_URL.
```

**The variable was set in the job environment and Prisma still could not resolve
it.** Turbo runs in **strict env mode** (`--dry=json` reports
`envMode: strict`), which filters each task's environment down to what that task
declares, and nothing declared this one. **MEASURED**, before the fix:
`@metrika/database#db:generate` reported
`{"specified":{"env":[],"passThroughEnv":null},"configured":[],"inferred":[]}`.

The variable had never needed declaring, because on Prisma 6 it was **resolved
lazily by the query engine** and `generate` never touched it. Moving the
datasource into `prisma.config.ts` made it **required at config load, by every
subcommand** — which turned a runtime connection detail into a _build input_,
and turbo had no way to know.

**Why no gate on this branch caught it.** `db:generate` runs as
`node --env-file-if-exists=.env scripts/prisma.mjs generate`, and that flag loads
the root `.env` **inside the child**, downstream of turbo's filtering. A machine
with a `.env` therefore cannot observe the bug at all, whatever it runs. CI has
no `.env`. Every gate on this branch — `pnpm verify` included, repeatedly, at
four different loads — ran on a machine with a `.env`.

**MEASURED, the fix, under reproduced CI conditions** (root `.env` removed,
variables supplied only through the environment):

| turbo.json                                | `turbo run db:generate` | `pnpm build`          |
| ----------------------------------------- | ----------------------- | --------------------- |
| nothing declared                          | **exit 1**              | **exit 1**, 3/5 tasks |
| declared on `db:generate` only            | exit 0                  | **exit 1** at `build` |
| declared on `db:generate` **and** `build` | exit 0                  | **exit 0**, 6/6 tasks |

The middle row is the part that is easy to get wrong and was not in the original
diagnosis: `packages/database`'s build script is `pnpm db:generate && tsc -b`, so
it runs generate **inline**, inside the `build` task's own filtered environment.
`dependsOn: ["db:generate"]` schedules the sibling task; it does not lend `build`
that task's environment.

**`passThroughEnv`, not `env`, and the distinction is not stylistic.**
`passThroughEnv` supplies a variable without entering the task's hash. Prisma
needs this variable to _resolve_; the client it emits is byte-identical whatever
the URL says, because it is a connection string and not a code-generator input.
Under `env`, a developer pointing `DATABASE_ADMIN_URL` at a different local
database would invalidate every build in the graph and rebuild artefacts that
cannot differ. `globalEnv` would be worse again — it participates in **every**
task's hash, including `lint` and `test:unit`, which never load Prisma's config.

**The guard is static, deliberately.**
`packages/database/test/turbo-env.test.ts` asserts that every `env('…')` in
`prisma.config.ts` is declared — as `env` or `passThroughEnv` — for every task
that runs a Prisma subcommand. A static check does not need a `.env` to be
absent, does not need CI, and fails the moment someone adds an `env()` call
without declaring it, which is when it is cheap. It carries its own positive
control (the extraction must find `DATABASE_ADMIN_URL`, so a regex that stopped
matching fails rather than passing vacuously) and was verified red by deleting
the `build` declaration.

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
   `?schema=` in the tree means something again. **A fixture guarding an
   equality does not sample.** Both of these were rebuilt during this branch
   because their first observable could not support the assertion resting on it:
   one could not go red, the other could go red falsely.

3. **Any fixture for adapter-level schema selection queries through a model
   delegate.** `$queryRaw` cannot observe the setting at all, so a raw-SQL
   tripwire here is green by construction. This is written into both test files
   as well, at the top, where someone about to "simplify" one will see it.

4. **Fail-fast at boot is a deliberate round trip.** `PrismaService.onModuleInit`
   keeps its `` $queryRaw`SELECT 1` `` after `$connect()`, and
   `apps/api/test/boot.integration.test.ts` is what stops it being deleted as
   redundant.

5. **Unique-violation handling keys on `meta.driverAdapterError.cause.kind`, not
   on the Prisma error code.** `meta.target` is gone, and the same violation is
   `P2002` from a model delegate and `P2010` from `$executeRaw` — so a handler
   keyed on the code silently ignores every violation raised by raw SQL, which
   is where idempotency claims tend to end up.
   `packages/database/test/error-shape.integration.test.ts` holds all of it;
   whoever writes the Phase 1 handler extends that file rather than trusting this
   one.

6. **`prisma-client-js` stays.** Moving generators is a separate decision with
   the costs listed in §5, not a step in an upgrade.

7. **Every Prisma CLI call keeps going through `scripts/prisma.mjs`**, whose two
   load-bearing behaviours are now `--env-file-if-exists` (Prisma 7 loads no
   `.env` at all) and `cwd = packages/database` (where `prisma.config.ts` is
   discovered). Both reasons are written into that file.

8. **`pnpm db:reset` is verified by the repository owner, not by an agent.** No
   agent sets `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` and no agent runs
   `migrate reset`, `db push --force-reset` or `db push --accept-data-loss`.

9. **Every variable `prisma.config.ts` resolves is declared in `turbo.json`, as
   `passThroughEnv`, on every task that runs a Prisma subcommand — `db:generate`
   and `build`.** `packages/database/test/turbo-env.test.ts` enforces it. The
   config move turned a runtime connection detail into a build input, and strict
   env mode means an undeclared input is a stripped one.

10. **A gate that only ever runs on a machine with a root `.env` cannot see this
    class of defect.** `--env-file-if-exists` loads `.env` downstream of turbo's
    filtering, so it masks any missing declaration. That is why the guard above
    is static rather than a "build with no `.env`" script: the check has to be
    one that a developer machine can actually fail.

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

**Gained:** four silent behaviour changes now have fixtures that run on every
integration pass, and **two of those fixtures were found to be untrustworthy
before they were trusted** — the schema tripwire could not go red at all, and the
pool fixture could go red for the wrong reason, reporting a Prisma regression
that had not happened. Both were caught by someone re-measuring rather than
reading, and the two findings behind them — that `@prisma/adapter-pg` qualifies
SQL rather than setting `search_path`, and that a sampler under an equality
assertion is a false-positive generator — are cheap to learn once and expensive
to rediscover.

**Learned the expensive way:** the config move made `DATABASE_ADMIN_URL` a build
input, and no local gate on this branch could observe it — not because the gates
were weak, but because `--env-file-if-exists` sits downstream of the mechanism
that was broken. Four of five CI jobs failed after a full branch review had
passed. The general lesson is worth more than the fix: **when a tool starts
resolving configuration earlier in its lifecycle, it may have become an input to
something that caches.** Ask what else now sees it.

**Not verified, and listed rather than left implicit:** `pnpm db:reset` on 7.9.1;
whether `prisma studio` starts (only its default port was read, from the CLI
bundle). Every 6.19.3 number in this document is inherited from the upgrade spike
and cannot be reproduced from this tree. The composite `@@unique` case was on
this list until the branch review and is now measured — see §4.
