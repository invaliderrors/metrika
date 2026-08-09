import { ESLint } from 'eslint';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve(import.meta.dirname, '..');

describe('typescript-config local eslint config', () => {
  it('forbids process.env, matching the repo-wide invariant in @metrika/eslint-config base', async () => {
    const eslint = new ESLint({ cwd: packageRoot });
    const results = await eslint.lintText('export const level = process.env.LOG_LEVEL;\n', {
      // A path inside the package but not on disk: lintText applies the
      // resolved config regardless, and this path is outside every `ignores`
      // entry, so the rule set under test is the one that really runs.
      filePath: path.join(packageRoot, 'test/parity-probe.ts'),
    });
    const rules = (results[0]?.messages ?? []).map((m) => m.ruleId);
    expect(rules).toContain('no-restricted-properties');
  });
});
