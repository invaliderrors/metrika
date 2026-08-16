#!/usr/bin/env node
// `next dev` and `next start` on the port `WEB_PORT` names, portably.
//
// apps/web spelled this inline for a while:
//
//   "start": "next start --port ${WEB_PORT:-3000}"
//
// That is POSIX parameter expansion, and the SHELL performs it. pnpm runs a
// script through `cmd.exe` on Windows, which does not, so `next` receives the
// literal text and refuses it — MEASURED, through
// `pnpm --filter @metrika/web test:e2e`, whose Playwright `webServer` runs
// `pnpm build && pnpm start`:
//
//   error: option '-p, --port <port>' argument '${WEB_PORT:-3000}' is invalid.
//   '${WEB_PORT:-3000}' is not a non-negative number.
//
// `pnpm dev` and `pnpm --filter @metrika/web dev` had the same defect and a
// quieter symptom, because `next dev` would have taken the bad value the same
// way. Nothing about the port is Windows-specific; only the expansion is.
//
// AT THE REPOSITORY ROOT, beside the other wrappers, rather than in
// `apps/web/scripts/`. Two reasons: `packages/database`'s `db:generate` already
// reaches out this way (`node ../../scripts/prisma.mjs generate`), and this
// directory is outside every package's ESLint program — a file under
// `apps/web/` reading `process.env` would need an exemption in
// `apps/web/eslint.config.js`, which today grants exactly two, both argued.
//
// IT DELIBERATELY DOES NOT LOAD `.env`. `apps/web/playwright.config.ts` builds
// the URL it polls from the same variable and cannot load that file — it must
// start with no environment at all. If this side read `.env` and that side did
// not, a `.env` naming a non-default port would produce a server on one port
// and a poller on another, which is a worse failure than the one this replaces.
// Both read the ambient environment; see `.env.example` on `WEB_PORT`.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveBin } from './run-bin.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webPackage = path.join(repoRoot, 'apps/web');

const [command, ...rest] = process.argv.slice(2);
if (command !== 'dev' && command !== 'start') {
  process.stderr.write(`Usage: node scripts/next.mjs <dev|start> [...args]\n`);
  process.exit(1);
}

// The default is repeated from `.env.example`, and from nowhere else — there is
// no import path from a dotenv file to here.
const port = process.env['WEB_PORT'] ?? '3000';

const result = spawnSync(
  process.execPath,
  [resolveBin('next', { from: webPackage }), command, '--port', port, ...rest],
  { cwd: webPackage, stdio: 'inherit' },
);

process.exit(result.status ?? 1);
