#!/usr/bin/env node
// How the three scripts beside this one launch a tool out of `node_modules`,
// and why none of them goes through the package manager to do it.
//
// All three used to spawn `pnpm exec <tool>`. On Windows that fails, and it
// fails in the worst available shape: `pnpm` there is `pnpm.CMD`, a batch
// shim, and since the fix for CVE-2024-27980 Node refuses to launch a `.cmd`
// without `shell: true`. MEASURED on node 24.19.0,
// `spawnSync('pnpm', ['-v'], { stdio: 'inherit' })` returns
// `{ status: null, error: ENOENT }` — and every caller here exited with
// `result.status ?? 1`. So `pnpm build`, `pnpm dev`, `pnpm test:unit`,
// `pnpm test:integration`, every `pnpm db:*` and `pnpm contracts:emit` exited 1
// having printed NOTHING AT ALL: no error, no name of the command that could
// not be found, no hint that the platform was the variable. A green CI (Linux)
// and a silent exit 1 on a developer machine is the pairing that makes this
// worth a file of its own rather than a flag at each call site.
//
// `shell: true` would fix the launch and buy a quoting bug in exchange: the
// arguments below include absolute paths (`--schema C:\…`), and under `cmd.exe`
// a path containing a space is two arguments.
//
// So skip the package manager. `pnpm exec` exists to put `node_modules/.bin` on
// PATH and pick the right entry; when that entry is a JS file — turbo's
// `bin/turbo` and prisma's `build/index.js` both are — Node can run it itself,
// and no PATH lookup, no shell and no `.cmd` shim is involved. That is the same
// mechanism `pnpm exec` would have reached, one layer down, and it behaves
// identically on POSIX.
//
// Resolution goes through the dependency's own `package.json#bin` rather than a
// hard-coded path, because pnpm's store puts the real directory under
// `node_modules/.pnpm/<name>@<version>_<hash>/node_modules/<name>` and that hash
// is not something any file here should try to spell. `from` is the package
// whose dependency it is: turbo is the root's, `prisma` is `@metrika/database`'s
// only, so there is no single resolution base that finds both.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * Absolute path to a dependency's bin entry, resolved from `from` (a directory
 * containing a `package.json` that can see the dependency).
 *
 * @param {string} packageName
 * @param {{ from: string, binName?: string }} options
 * @returns {string}
 */
export function resolveBin(packageName, { from, binName = packageName }) {
  const require = createRequire(path.join(from, 'package.json'));
  const manifestPath = require.resolve(`${packageName}/package.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binName];

  if (typeof entry !== 'string') {
    throw new Error(
      `${packageName} (resolved from ${from}) declares no "${binName}" bin entry, ` +
        'so there is nothing to run. Check the dependency is installed and not renamed.',
    );
  }

  return path.resolve(path.dirname(manifestPath), entry);
}

/**
 * Runs a dependency's bin entry under the current Node executable, inheriting
 * stdio. Returns the `spawnSync` result; callers decide what a non-zero status
 * means.
 *
 * @param {string} packageName
 * @param {readonly string[]} args
 * @param {{ from: string, binName?: string } & import('node:child_process').SpawnSyncOptions} options
 */
export function runBin(packageName, args, options) {
  const { from, binName, ...spawnOptions } = options;

  return spawnSync(process.execPath, [resolveBin(packageName, { from, binName }), ...args], {
    stdio: 'inherit',
    ...spawnOptions,
  });
}
