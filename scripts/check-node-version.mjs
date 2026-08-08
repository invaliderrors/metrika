#!/usr/bin/env node
// Binding local Node-version guard, run as the root `preinstall` script.
//
// Why this exists: `engines.node` in package.json is advisory (pnpm only warns), and
// `.npmrc`'s `engine-strict=true` does not currently cause pnpm 11.20.0 to fail an
// install on a mismatched Node version (verified — see docs/ROADMAP.md Phase 0A task 4
// report). `.nvmrc` is only consulted by tools that opt in. This script is the one
// mechanism that actually fails a `pnpm install` run on the wrong Node major version.
//
// Zero dependencies deliberately: it runs via `preinstall`, before `pnpm install` has
// put anything in node_modules, so it can only rely on Node's own built-ins.
//
// `.nvmrc` is the source of truth for the required major version — do not hardcode a
// version number here. Bumping `.nvmrc` is the only edit a future Node upgrade needs.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nvmrcPath = path.join(repoRoot, '.nvmrc');

const wantedRaw = readFileSync(nvmrcPath, 'utf8').trim();
const wantedMajor = wantedRaw.split('.')[0];
const currentVersion = process.versions.node;
const currentMajor = currentVersion.split('.')[0];

if (wantedMajor !== currentMajor) {
  console.error(
    [
      '',
      `Node version mismatch: this repo requires Node ${wantedMajor}.x (see .nvmrc: ${wantedRaw}).`,
      `You are running Node ${currentVersion}.`,
      '',
      'Fix:',
      '  mise install   # installs the pinned Node version',
      '  mise use       # switches this shell to it',
      '  # or, with nvm:',
      '  nvm use',
      '',
    ].join('\n'),
  );
  process.exit(1);
}
