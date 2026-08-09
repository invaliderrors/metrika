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

const result = spawnSync('pnpm', ['exec', 'prisma', ...process.argv.slice(2), '--schema', schema], {
  cwd: databasePackage,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
