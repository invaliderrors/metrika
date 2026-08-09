import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, '..');

/**
 * Resolution is checked in a REAL `node` subprocess, deliberately not through
 * Vitest's resolver. Vite rewrites bare specifiers with its own algorithm, so a
 * broken `exports` map can still "work" under Vitest while `node dist/main.js` —
 * which is exactly how apps/api runs in production — fails at startup.
 *
 * Node self-references a package by its own name when the package declares
 * `exports`. The parent URL for `node -e` is the process cwd, so running with
 * cwd inside packages/contracts makes `import '@metrika/contracts'` go through
 * this package's own exports map.
 */
async function resolveInNode(source: string): Promise<string> {
  const { stdout } = await run('node', ['--input-type=module', '-e', source], {
    cwd: packageRoot,
  });
  return stdout.trim();
}

describe('@metrika/contracts package exports', () => {
  it('emits a runtime entry point', () => {
    expect(existsSync(path.join(packageRoot, 'dist/index.js'))).toBe(true);
  });

  it('emits declarations beside the runtime entry point', () => {
    expect(existsSync(path.join(packageRoot, 'dist/index.d.ts'))).toBe(true);
  });

  it('does not ship tests in dist', () => {
    expect(existsSync(path.join(packageRoot, 'dist/test'))).toBe(false);
  });

  it('is importable by bare specifier from a real node process', async () => {
    const output = await resolveInNode(
      "import { money } from '@metrika/contracts'; console.log(money(1n, 'COP').amountMinor);",
    );
    expect(output).toBe('1');
  });

  it('produces the same canonical digest from the built artefact as from source', async () => {
    // Identical to the literal asserted in hashing.test.ts against src/. If the
    // build step ever changes serialisation, the cache key changes with it.
    const output = await resolveInNode(
      "import { sha256Canonical } from '@metrika/contracts'; console.log(await sha256Canonical({ a: 1 }));",
    );
    expect(output).toBe('015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862');
  });
});
