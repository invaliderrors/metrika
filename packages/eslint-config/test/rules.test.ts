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
