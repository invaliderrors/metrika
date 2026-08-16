#!/usr/bin/env node
// The entry point for the four root scripts that can end up running `next
// build` or `next dev` — `build`, `dev`, `test:unit`, `test:integration` — and
// the reason none of them is a bare `turbo run <task>`.
//
// `test:unit` and `test:integration` are on that list because turbo, not the
// script, decides: both declare `dependsOn: ["^build", "build"]`, so
// `@metrika/web#build` is scheduled by each of them. MEASURED, once
// `src/app/layout.tsx` began importing `clientEnv`: `turbo run test:unit` with
// no `.env` loaded re-ran the web build as a cache miss and died with the
// ZodError below, on a tree where `pnpm build` had just succeeded.
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
// second script here. Three more now are, which is what that sentence was for.
//
// Note the second gate, which this file cannot satisfy on its own: turbo runs
// in strict env mode, so putting a variable in turbo's environment is necessary
// and not sufficient — `turbo.json` has to declare it on the task as well.
// MEASURED: a task declaring no `env` at all still sees `NEXT_PUBLIC_*` (turbo
// infers those from the `nextjs` framework) but does NOT see `WEB_PORT`.
//
// Turbo is launched through `runBin` rather than `pnpm exec turbo`, for the
// reason in `run-bin.mjs`: the latter is a `.cmd` shim on Windows, which
// `spawnSync` cannot start, and this file's `?? 1` turned that into a silent
// exit 1 with no output on the four most-used scripts in the repository.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runBin } from './run-bin.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const result = runBin('turbo', process.argv.slice(2), { from: repoRoot, cwd: repoRoot });

process.exit(result.status ?? 1);
