import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, '..');

/**
 * `@metrika/eslint-config`'s `nest()` profile suppresses
 * `consistent-type-imports`'s rewrite of a decorated class's
 * value-imported constructor dependency ONLY when the resolved tsconfig
 * has both `experimentalDecorators` and `emitDecoratorMetadata` set to
 * true (see packages/eslint-config/src/nest.js and CLAUDE.md). That
 * mechanism is gated once, permanently, for the shared profile itself in
 * packages/eslint-config/test/rules.test.ts — but nothing pins that THIS
 * package's own tsconfig.json actually resolves to those flags. Swap the
 * `extends` to something that doesn't set `emitDecoratorMetadata`, or
 * override either flag locally, and `tsc`, `eslint` and `pnpm verify` all
 * stay green right up until `eslint --fix` erases a constructor
 * dependency's value import — a defect the boot-integration test (9b)
 * only catches after the fact, and only when Docker is running. This test
 * is the cheap, Docker-free pin that catches it inside `pnpm verify`
 * itself, before any autofix runs.
 */
describe('tsconfig.json — DI suppression preconditions', () => {
  it('resolves experimentalDecorators and emitDecoratorMetadata to true', async () => {
    const { stdout } = await run('pnpm', ['exec', 'tsc', '--showConfig', '-p', 'tsconfig.json'], {
      cwd: packageRoot,
    });
    const resolved = JSON.parse(stdout) as {
      compilerOptions?: { experimentalDecorators?: unknown; emitDecoratorMetadata?: unknown };
    };
    expect(resolved.compilerOptions?.experimentalDecorators).toBe(true);
    expect(resolved.compilerOptions?.emitDecoratorMetadata).toBe(true);
  });
});
