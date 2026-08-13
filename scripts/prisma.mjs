#!/usr/bin/env node
// The ONLY entry point to the Prisma CLI in this repository.
//
// Two problems it solves, both of which produce confusing failures otherwise:
//
// 1. Prisma 7 does no dotenv loading AT ALL — not beside the schema, not in
//    the cwd, not anywhere. (Prisma 6 looked beside the schema and in the cwd,
//    which already never reached the repository root; 7 removed the search
//    rather than widening it.) The root `.env` is the only environment file
//    this project has, so Node's `--env-file-if-exists` in the npm script is
//    now the ONLY thing that puts it into process.env, and it runs before this
//    file does. Real environment variables always win over dotenv — so CI,
//    which sets DATABASE_ADMIN_URL directly and has no `.env` at all, behaves
//    identically. Without it, `prisma.config.ts`'s `env('DATABASE_ADMIN_URL')`
//    fails before any database is contacted. Measured on 7.9.1, from
//    packages/database with the variable unset:
//
//      Failed to load config file "…/packages/database" as a
//      TypeScript/JavaScript module. Error: PrismaConfigEnvError: Cannot
//      resolve environment variable: DATABASE_ADMIN_URL.
//
//    See ADR-0037.
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
//
//    On Prisma 7 this cwd is load-bearing a SECOND time, and this one is not
//    about pnpm: `prisma.config.ts` is discovered RELATIVE TO CWD, and
//    `--schema` does not find it. Measured on 7.9.1, `prisma validate` both
//    ways with DATABASE_ADMIN_URL unset:
//
//      cwd=repo root, --schema packages/database/prisma/schema.prisma
//        → "The schema … is valid" — the config file was never loaded
//      cwd=packages/database, --schema prisma/schema.prisma
//        → PrismaConfigEnvError — the config file WAS loaded
//
//    So a future "simplification" that drops the cwd and keeps `--schema`
//    would run Migrate with no datasource URL and no migrations path at all.
//    See ADR-0037.
//
//    `--env-file-if-exists` is also what MASKED a real defect for the whole of
//    this upgrade, so it is worth knowing which half of this does what. It
//    loads the root `.env` INSIDE this child process — downstream of Turbo,
//    which runs in strict env mode and strips any variable no task declares.
//    So on a developer machine the variable arrives via `.env` whether or not
//    `turbo.json` declares it, and on CI, which has no `.env`, it arrives only
//    if `turbo.json` declares it. `pnpm verify` was green locally while four of
//    five CI jobs failed. `turbo.json` now declares it on both `db:generate`
//    and `build`, and `packages/database/test/turbo-env.test.ts` fails if a
//    future `env()` call is added without doing the same.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const databasePackage = path.join(repoRoot, 'packages/database');
const schema = path.join(databasePackage, 'prisma/schema.prisma');

const result = spawnSync('pnpm', ['exec', 'prisma', ...process.argv.slice(2), '--schema', schema], {
  cwd: databasePackage,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
