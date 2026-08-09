import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

async function lintFixture(file: string): Promise<readonly string[]> {
  const eslint = new ESLint({ cwd: import.meta.dirname });
  const [result] = await eslint.lintFiles([`fixtures/${file}`]);
  return (result?.messages ?? []).map((m) => m.ruleId ?? 'unknown');
}

describe('eslint-config typeChecked', () => {
  it.each([
    ['explicit-any.ts', '@typescript-eslint/no-explicit-any'],
    ['floating-promise.ts', '@typescript-eslint/no-floating-promises'],
    ['non-exhaustive-switch.ts', '@typescript-eslint/switch-exhaustiveness-check'],
  ])('%s triggers %s', async (file, rule) => {
    expect(await lintFixture(file)).toContain(rule);
  });

  it('clean.ts produces no findings', async () => {
    expect(await lintFixture('clean.ts')).toEqual([]);
  });
});

describe('contracts boundary', () => {
  it('forbids node built-ins inside contracts', async () => {
    const eslint = new ESLint({
      cwd: import.meta.dirname,
      overrideConfigFile: 'eslint.boundaries.config.js',
    });
    const [result] = await eslint.lintFiles(['fixtures/contracts-forbidden-import.ts']);
    const rules = (result?.messages ?? []).map((m) => m.ruleId);
    expect(rules).toContain('no-restricted-imports');
  });

  it('forbids node built-ins reached through a dynamic import()', async () => {
    // no-restricted-imports only inspects static import/export declarations;
    // this fixture uses `await import('node:crypto')` specifically to prove
    // the separate no-restricted-syntax rule catches what that one cannot.
    const eslint = new ESLint({
      cwd: import.meta.dirname,
      overrideConfigFile: 'eslint.boundaries.config.js',
    });
    const [result] = await eslint.lintFiles(['fixtures/contracts-forbidden-dynamic-import.ts']);
    const rules = (result?.messages ?? []).map((m) => m.ruleId);
    expect(rules).toContain('no-restricted-syntax');
  });
});

describe('contracts boundary — dynamic imports and Node ambients', () => {
  async function lintWithBoundary(file: string): Promise<readonly string[]> {
    const eslint = new ESLint({
      cwd: import.meta.dirname,
      overrideConfigFile: 'eslint.boundaries.config.js',
    });
    const [result] = await eslint.lintFiles([`fixtures/${file}`]);
    return (result?.messages ?? []).map((m) => m.ruleId ?? 'unknown');
  }

  it('forbids a template-literal dynamic import', async () => {
    expect(await lintWithBoundary('contracts-template-import.ts')).toContain(
      'no-restricted-syntax',
    );
  });

  it('forbids Node ambient globals', async () => {
    const rules = await lintWithBoundary('contracts-node-global.ts');
    expect(rules.filter((r) => r === 'no-restricted-globals')).toHaveLength(2);
  });
});

describe('prisma boundary', () => {
  async function lintWithPrismaBoundary(file: string): Promise<readonly string[]> {
    const eslint = new ESLint({
      cwd: import.meta.dirname,
      overrideConfigFile: 'eslint.prisma.config.js',
    });
    const [result] = await eslint.lintFiles([`fixtures/${file}`]);
    return (result?.messages ?? []).map((m) => m.ruleId ?? 'unknown');
  }

  it('forbids importing @prisma/client outside infrastructure/persistence', async () => {
    expect(await lintWithPrismaBoundary('prisma-outside-persistence.ts')).toContain(
      'no-restricted-imports',
    );
  });

  it('forbids $queryRawUnsafe anywhere, persistence included', async () => {
    expect(await lintWithPrismaBoundary('raw-unsafe-query.ts')).toContain('no-restricted-syntax');
  });
});

describe('nest profile', () => {
  async function lintWithNest(file: string): Promise<readonly string[]> {
    const eslint = new ESLint({
      cwd: import.meta.dirname,
      overrideConfigFile: 'eslint.nest.config.js',
    });
    const [result] = await eslint.lintFiles([`fixtures/${file}`]);
    return (result?.messages ?? []).map((m) => m.ruleId ?? 'unknown');
  }

  it('accepts a decorator-only module class', async () => {
    expect(await lintWithNest('nest-app.module.ts')).toEqual([]);
  });

  it('still reports a genuinely pointless class outside a module file', async () => {
    // The companion assertion. Without it, a `nest()` that returned `[]` — or
    // one whose typeChecked() half never resolved a program — would satisfy
    // the test above by finding nothing at all.
    expect(await lintWithNest('extraneous-class.ts')).toContain(
      '@typescript-eslint/no-extraneous-class',
    );
  });
});
