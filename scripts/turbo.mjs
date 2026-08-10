#!/usr/bin/env node
// The entry point for `pnpm build`, and the reason it is not a bare
// `turbo run build`.
//
// `next build` inlines every `NEXT_PUBLIC_` value into the browser bundle at
// BUILD time, and `apps/web/src/config/env.ts` parses them at module scope so a
// misconfigured deployment fails here rather than on a user's first render.
// Something therefore has to put the root `.env` into the environment before
// turbo spawns anything. Three measured facts decide how:
//
// 1. `next build` reads `apps/web/.env`, NOT the repository root's. The root
//    `.env` is this project's only environment file (see `.env.example`), so a
//    second one inside apps/web would be a second way to be wrong.
// 2. `node --env-file-if-exists=../../.env next build` does not work. Next
//    propagates its own exec argv into `NODE_OPTIONS` for its build workers,
//    and Node rejects `--env-file-if-exists` there. The flag has to sit on a
//    process that does not exec Next directly.
// 3. Turbo forwards the loaded variables to the task without an `env:`
//    declaration, because it infers `@metrika/web#build` as a `nextjs` task and
//    treats `NEXT_PUBLIC_*` as part of its hash. `turbo.json` declares the two
//    keys anyway — inference is upstream behaviour we do not control, and a
//    silently-dropped variable would be a cache hit against a bundle built with
//    a different value.
//
// So: the flag goes on THIS process, which only spawns turbo, and everything
// downstream inherits it through `process.env`. Real environment variables
// still win over the file, so CI — which sets them at the job level and has no
// `.env` — behaves identically. Same shape and the same reasoning as
// `scripts/prisma.mjs`.
//
// Generic in its arguments rather than hard-coded to `run build`, so a second
// task that needs the environment is one word in `package.json` rather than a
// second script here.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const result = spawnSync('pnpm', ['exec', 'turbo', ...process.argv.slice(2)], {
  cwd: repoRoot,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
