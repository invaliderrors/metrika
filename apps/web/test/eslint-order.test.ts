import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

/**
 * The resolved severity of one rule in this package's real, on-disk
 * `eslint.config.js`.
 *
 * ESLint types `calculateConfigForFile` as returning `any` — verified in
 * `eslint@10.8.0`'s `lib/types/index.d.ts`. Taken as `unknown` and narrowed by
 * hand rather than written as `config.rules?.[id]?.[0]`, which is four
 * `no-unsafe-*` errors under this repo's `strictTypeChecked` profile. Same
 * shape, and the same reasoning, as `resolvedRule` in
 * `packages/eslint-config/test/react.test.ts`.
 *
 * Narrowing to `unknown` and throwing on a shape mismatch matters beyond
 * satisfying the linter: if ESLint ever stops returning a `rules` map, this
 * fails loudly instead of quietly comparing `undefined` against `2`.
 */
async function resolvedSeverity(ruleId: string): Promise<unknown> {
  const eslint = new ESLint({ cwd: new URL('..', import.meta.url).pathname });
  const config: unknown = await eslint.calculateConfigForFile('src/app/page.tsx');
  if (typeof config !== 'object' || config === null || !('rules' in config)) {
    throw new Error('calculateConfigForFile returned a config with no rules');
  }
  const rules: unknown = config.rules;
  if (typeof rules !== 'object' || rules === null) {
    throw new Error('calculateConfigForFile returned a non-object rules map');
  }
  const entry = (rules as Record<string, unknown>)[ruleId];
  if (!Array.isArray(entry)) {
    throw new Error(`${ruleId} did not resolve to a rule entry — it resolved to ${String(entry)}`);
  }
  return entry[0];
}

/**
 * `next()` must come BEFORE `typeChecked()`. Reversed, `eslint-config-next`'s
 * bare `'warn'` for these two rules wins on severity and they drop from error
 * to warning — which `pnpm verify` cannot see, because it runs `turbo run lint`
 * with no `--max-warnings`, while CI passes `--max-warnings=0`. The failure
 * would therefore be invisible locally and red only in CI.
 *
 * Resolved config, not a lint run: this asserts the property directly rather
 * than hoping some file happens to trip the rule.
 *
 * `packages/eslint-config` pins the same property against its own fixtures, but
 * never reads this file. And the Step 5b `process.env` probe cannot cover it
 * either: `no-restricted-properties` is not among the three rules that differ
 * between the two orders, so it resolves identically whichever way round the
 * composition is written.
 */
describe('apps/web eslint composition', () => {
  it('keeps no-unused-vars an error, which reversing the order would not', async () => {
    expect(await resolvedSeverity('@typescript-eslint/no-unused-vars')).toBe(2);
  });

  it('keeps no-unused-expressions an error', async () => {
    expect(await resolvedSeverity('@typescript-eslint/no-unused-expressions')).toBe(2);
  });
});
