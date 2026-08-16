import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, '..');
const testDir = import.meta.dirname;

/**
 * `tsc` is launched as `node <resolved tsc.js>` rather than `pnpm exec tsc`.
 *
 * `pnpm` on Windows is `pnpm.CMD`, and `execFile` cannot start a `.cmd` without
 * a shell — MEASURED on node 24.19.0, the call rejects with
 * `Error: spawn pnpm ENOENT`. `compile()` below deliberately swallows a non-zero
 * exit and returns whatever was printed, so on Windows that error arrived here
 * as an EMPTY STRING and every positive assertion in this file failed with a
 * message about a missing diagnostic rather than about a missing compiler.
 * Resolving the bin out of `package.json` needs no shell, no PATH lookup and no
 * `.cmd`, and is identical on POSIX.
 */
const tsc = (() => {
  const require = createRequire(import.meta.url);
  const manifest = require.resolve('typescript/package.json');
  const bin = (JSON.parse(readFileSync(manifest, 'utf8')) as { bin: Record<string, string> }).bin;
  return path.resolve(path.dirname(manifest), bin['tsc'] ?? '');
})();

/**
 * `compile()` swallows a non-zero exit and returns whatever tsc printed, which
 * is what lets a single call serve both the "must fail" and the "must succeed"
 * fixtures. The cost is that a NEGATIVE assertion on its output is vacuous: an
 * output of `error TS5058: The specified path does not exist`, or a `pnpm exec`
 * that never found `tsc`, or an `extends` that failed to resolve, all satisfy
 * `expect(output).not.toContain(...)`. Every assertion below therefore pins
 * something POSITIVE about the output first — the diagnostic count, or the
 * exact filename, or emptiness of the whole string.
 */
async function compile(project: string, useBuildMode: boolean): Promise<string> {
  const args = useBuildMode ? [tsc, '-b', project] : [tsc, '-p', project];
  try {
    const { stdout, stderr } = await run(process.execPath, args, { cwd: packageRoot });
    return `${stdout}${stderr}`;
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
}

describe('web-library.json', () => {
  it('rejects a DOM global — the package must stay browser-bundle-safe without DOM', async () => {
    const output = await compile('test/tsconfig.web-fixtures.json', false);
    expect(output).toContain('dom-global.ts');
    expect(output).toContain('TS2584');
  });

  it('accepts the WebWorker globals hashing.ts actually uses', async () => {
    const output = await compile('test/tsconfig.web-fixtures.json', false);
    const diagnostics = output.match(/error TS\d+/g) ?? [];

    // Exactly one diagnostic, and it must be the DOM one. A harness failure
    // (TS5058, a missing tsc, an unresolved `extends`) also yields one
    // diagnostic — which is why the filename is asserted too.
    expect(diagnostics).toHaveLength(1);
    expect(output).toContain('dom-global.ts');
    expect(output).toContain('TS2584');
    expect(output).not.toContain('worker-global.ts');
  });
});

describe('nest.json', () => {
  const outDir = path.join(testDir, '.tmp-nest-out');

  beforeAll(async () => {
    rmSync(outDir, { recursive: true, force: true });
    await compile('test/tsconfig.nest-fixtures.json', false);
  });

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it('compiles decorated classes with constructor injection under the full strict flag set', async () => {
    const output = await compile('test/tsconfig.nest-fixtures.json', false);
    expect(output.trim()).toBe('');
  });

  it('emits the constructor parameter type as design:paramtypes for a value import', () => {
    const emitted = readFileSync(path.join(outDir, 'value-import.controller.js'), 'utf8');
    expect(emitted).toContain('design:paramtypes');
    expect(emitted).toContain('WidgetService');
    // toContain('WidgetService') alone is satisfied by the surviving
    // `import { WidgetService } from './service.js';` line, not by the
    // metadata array — a `[Function]` emit with that import intact would
    // still pass it. Pin the array shape itself, the way the `import type`
    // sibling test below pins `[Function]`.
    expect(emitted).toMatch(/design:paramtypes",\s*\[WidgetService\]/);
  });

  it('erases the constructor parameter type for an `import type` — the DI footgun, captured', () => {
    const emitted = readFileSync(path.join(outDir, 'type-import.controller.js'), 'utf8');
    expect(emitted).toContain('design:paramtypes');
    // The binding is gone: Nest sees the global `Function` and throws
    // UnknownDependenciesException at boot. tsc reports nothing.
    expect(emitted).not.toContain('WidgetService');
    expect(emitted).toMatch(/design:paramtypes",\s*\[Function\]/);
  });

  it('resolves compilerOptions.types to ["node"], proving the extends chain runs through node.json', async () => {
    const { stdout } = await run(process.execPath, [tsc, '--showConfig', '-p', 'nest.json'], {
      cwd: packageRoot,
    });
    const resolved = JSON.parse(stdout) as { compilerOptions?: { types?: unknown } };
    // base.json declares no `types` field at all. If nest.json's `extends`
    // were swapped from ./node.json to ./base.json, this key would be
    // entirely absent from the resolved config, not merely a different
    // array — node.json is the one link in the chain that sets it, and
    // that is the whole reason nest.json extends node.json rather than
    // base.json directly.
    expect(resolved.compilerOptions?.types).toEqual(['node']);
  });
});

describe('next.json', () => {
  const fixtureDir = path.join(testDir, 'next-fixtures');

  afterAll(() => {
    rmSync(path.join(testDir, '.tmp-next-fixtures.tsbuildinfo'), { force: true });
  });

  it('type-checks a DOM-using module', async () => {
    const output = await compile('test/tsconfig.next-fixtures.json', true);
    // The whole output, not a substring search. An empty string is the only
    // clean result AND the only result that proves tsc actually ran the
    // project; `not.toContain('TS2584')` would pass on TS5058 too.
    expect(output.trim()).toBe('');
  });

  it('emits nothing next to the sources, so `tsc -b` cannot scatter .js into app/', async () => {
    await compile('test/tsconfig.next-fixtures.json', true);
    const emitted = readdirSync(fixtureDir).filter(
      (name) => name.endsWith('.js') || name.endsWith('.d.ts'),
    );
    expect(emitted).toEqual([]);
  });
});
