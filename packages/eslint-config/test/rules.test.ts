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
