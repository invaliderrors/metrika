import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { z } from 'zod';

const WEB_ROOT = new URL('..', import.meta.url);

/**
 * The fully resolved config this package's real, on-disk `eslint.config.js`
 * produces for a `.tsx` file.
 *
 * ESLint types `calculateConfigForFile` as returning `any` — verified in
 * `eslint@10.8.0`'s `lib/types/index.d.ts`. Taken as `unknown` and narrowed by
 * hand rather than dotted into, which is four `no-unsafe-*` errors under this
 * repo's `strictTypeChecked` profile. Same shape, and the same reasoning, as
 * `resolvedRule` in `packages/eslint-config/test/react.test.ts`.
 *
 * Narrowing matters beyond satisfying the linter: if ESLint ever stops
 * returning this shape, every assertion below fails loudly instead of quietly
 * comparing `undefined` against the expected value.
 */
async function resolvedConfig(): Promise<Record<string, unknown>> {
  const eslint = new ESLint({ cwd: WEB_ROOT.pathname });
  const config: unknown = await eslint.calculateConfigForFile('src/app/page.tsx');
  if (typeof config !== 'object' || config === null) {
    throw new Error('calculateConfigForFile did not return a config object');
  }
  return config as Record<string, unknown>;
}

async function resolvedSeverity(ruleId: string): Promise<unknown> {
  const rules: unknown = (await resolvedConfig())['rules'];
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
 * to warning.
 *
 * That used to be invisible locally — `pnpm verify` ran `turbo run lint` with no
 * `--max-warnings` while CI passed `--max-warnings=0`. The root `lint` script
 * now carries `--max-warnings=0` itself, so the two agree and a downgrade is at
 * least loud. This test stays regardless: it asserts the property directly on
 * the resolved config rather than hoping some file happens to trip the rule,
 * and it names the mechanism for whoever reorders these spreads next.
 *
 * `packages/eslint-config` pins the same property against its own fixtures, but
 * never reads this file. And the `process.env` probe cannot cover it either:
 * `no-restricted-properties` is not among the three rules that differ between
 * the two orders, so it fires identically whichever way round the composition
 * is written — measured, by reversing the order and re-running the probe.
 */
describe('apps/web eslint composition', () => {
  it('keeps no-unused-vars an error, which reversing the order would not', async () => {
    expect(await resolvedSeverity('@typescript-eslint/no-unused-vars')).toBe(2);
  });

  it('keeps no-unused-expressions an error', async () => {
    expect(await resolvedSeverity('@typescript-eslint/no-unused-expressions')).toBe(2);
  });
});

const ReactSettings = z.object({ react: z.object({ version: z.string() }) });
const Manifest = z.object({ dependencies: z.object({ react: z.string() }) });

/**
 * ADR-0021 obligation 3 requires `settings.react.version` to be a literal equal
 * to this package's `react` pin — `'detect'` calls an ESLint 9 API that ESLint
 * 10 removed, and ESLint exits 2 before linting a single file.
 *
 * Those are two independent literals: `react` in `package.json` and
 * `reactVersion` in `eslint.config.js`. ADR-0021 says "the obligation-3 fixture
 * is what makes a drift between them visible". It does not. That fixture lives
 * in `packages/eslint-config`, hardcodes `19.2.8` itself, and never reads
 * `apps/web/package.json` — so it pins the profile's behaviour, not the
 * agreement between these two files. Nothing did, until this test.
 *
 * Drift here does NOT crash, which is what makes it worth a test. ESLint keeps
 * running and `eslint-plugin-react` keeps reporting; it just evaluates its
 * version-conditional logic against a React that is not the one being compiled.
 * That is the quiet failure mode, not the loud one — the same shape as Plan 0A
 * losing every type-aware rule with a green build.
 *
 * Read from disk rather than imported so that bumping either literal alone
 * turns this red. Parsed with Zod because a file read off disk is external data.
 */
describe('apps/web react version pins', () => {
  it('resolves settings.react.version equal to the react dependency in package.json', async () => {
    const settings = ReactSettings.parse((await resolvedConfig())['settings']);
    const rawManifest: unknown = JSON.parse(
      readFileSync(new URL('package.json', WEB_ROOT), 'utf8'),
    );
    const manifest = Manifest.parse(rawManifest);

    expect(settings.react.version).toBe(manifest.dependencies.react);
  });
});
