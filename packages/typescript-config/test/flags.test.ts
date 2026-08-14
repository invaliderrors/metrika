import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, '..');

/** See the note on `tsc` in `configs.test.ts` — `pnpm exec` is not portable. */
const tsc = (() => {
  const require = createRequire(import.meta.url);
  const manifest = require.resolve('typescript/package.json');
  const bin = (JSON.parse(readFileSync(manifest, 'utf8')) as { bin: Record<string, string> }).bin;
  return path.resolve(path.dirname(manifest), bin['tsc'] ?? '');
})();

async function compileFixtures(): Promise<string> {
  try {
    await run(process.execPath, [tsc, '-p', 'test/tsconfig.fixtures.json', '--noEmit'], {
      cwd: packageRoot,
    });
    return '';
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
}

describe('base tsconfig strict flags', () => {
  it.each([
    ['noUncheckedIndexedAccess', 'unchecked-index.ts', 'TS18048'],
    ['exactOptionalPropertyTypes', 'exact-optional.ts', 'TS2375'],
    ['noImplicitReturns', 'implicit-returns.ts', 'TS7030'],
  ])('%s rejects its fixture', async (_flag, file, code) => {
    const output = await compileFixtures();
    expect(output).toContain(file);
    expect(output).toContain(code);
  });
});
