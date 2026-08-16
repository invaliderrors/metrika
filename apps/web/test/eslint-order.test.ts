import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { z } from 'zod';

// A filesystem path, not a URL. `new ESLint({ cwd })` takes a path, and
// `WEB_ROOT.pathname` on Windows is `/C:/Users/…/apps/web`, which ESLint
// resolves against the drive root — MEASURED, every assertion here failed with
// `Error: Could not find config file.` on a tree whose config file is present.
const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));

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
async function resolvedConfig(file = 'src/app/page.tsx'): Promise<Record<string, unknown>> {
  const eslint = new ESLint({ cwd: WEB_ROOT });
  const config: unknown = await eslint.calculateConfigForFile(file);
  if (typeof config !== 'object' || config === null) {
    throw new Error('calculateConfigForFile did not return a config object');
  }
  return config as Record<string, unknown>;
}

/**
 * `Array.isArray` narrows `unknown` to `any[]`, which is an unsafe return the
 * moment the array is handed back rather than immediately indexed. This guard
 * lands on `unknown[]` instead, so the elements stay unknown until Zod parses
 * them — no cast, and nothing to justify to the linter.
 */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

async function resolvedRule(ruleId: string, file?: string): Promise<unknown[]> {
  const rules: unknown = (await resolvedConfig(file))['rules'];
  if (typeof rules !== 'object' || rules === null) {
    throw new Error('calculateConfigForFile returned a non-object rules map');
  }
  const entry = (rules as Record<string, unknown>)[ruleId];
  if (!isUnknownArray(entry)) {
    throw new Error(`${ruleId} did not resolve to a rule entry — it resolved to ${String(entry)}`);
  }
  return entry;
}

async function resolvedSeverity(ruleId: string): Promise<unknown> {
  return (await resolvedRule(ruleId))[0];
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

const RestrictedImportOptions = z.object({
  paths: z.array(z.object({ name: z.string() })),
  patterns: z.array(
    z.object({ group: z.array(z.string()).optional(), regex: z.string().optional() }),
  ),
});
const RestrictedSyntaxOptions = z.array(z.object({ selector: z.string() }));

/**
 * The three boundary zones, asserted on THIS config rather than on the fixture
 * config in packages/eslint-config.
 *
 * The fixtures there prove the rules reject what they should. They cannot prove
 * this file still enables them: all three profiles collide on rule ids —
 * `webBoundary`/`featureBoundary` on `no-restricted-imports`,
 * `webBoundary`/`serverActionBoundary` on `no-restricted-syntax` — and flat
 * config REPLACES a rule's options wholesale when a later entry supplies
 * options. Reorder the three spreads in `eslint.config.js`, or delete one, and
 * the fixture suite stays green while apps/web quietly loses a control. That
 * exact failure has happened in this repo: a second `no-restricted-imports`
 * block in apps/api silently dropped the earlier `@prisma/client` ban, with no
 * error and no warning.
 *
 * Read off `calculateConfigForFile`, which runs ESLint's own merge without
 * linting anything, so these assert the merged OUTCOME rather than the source
 * order — a future refactor that reaches the same outcome differently stays
 * green, and one that does not goes red. Zod because a resolved config is
 * external data (`calculateConfigForFile` is typed `any`).
 */
describe('apps/web boundary zones survive the flat-config merge', () => {
  it('bans the server-only packages everywhere in the app', async () => {
    const [, options] = await resolvedRule('no-restricted-imports');
    const names = RestrictedImportOptions.parse(options).paths.map((p) => p.name);

    expect(names).toContain('@metrika/database');
    expect(names).toContain('@metrika/pricing-engine');
  });

  it("carries BOTH the dynamic-import selectors and the 'use server' selector on an app file", async () => {
    const [, ...options] = await resolvedRule('no-restricted-syntax');
    const selectors = RestrictedSyntaxOptions.parse(options).map((o) => o.selector);

    // Two ImportExpression selectors, not one: a template-literal specifier is
    // a TemplateLiteral rather than a Literal, so the literal-only selector
    // lints `import(`@metrika/database`)` clean on its own.
    expect(selectors.filter((s) => s.startsWith('ImportExpression'))).toHaveLength(2);
    expect(selectors.some((s) => s.includes("'use server'"))).toBe(true);
  });

  it("keeps the dynamic-import ban inside a sanctioned actions.ts, and drops only 'use server'", async () => {
    const [, ...options] = await resolvedRule(
      'no-restricted-syntax',
      'src/app/settings/actions.ts',
    );
    const selectors = RestrictedSyntaxOptions.parse(options).map((o) => o.selector);

    // The ADR-0015 exemption is expressed as a non-match, not as
    // `'no-restricted-syntax': 'off'`. Written the other way it would take the
    // dynamic-import ban down with it, in the one kind of file that runs on the
    // server and can reach the database.
    expect(selectors.filter((s) => s.startsWith('ImportExpression'))).toHaveLength(2);
    expect(selectors.some((s) => s.includes("'use server'"))).toBe(false);
  });

  it('carries BOTH the package ban and the cross-feature ban inside src/features', async () => {
    // The clobber assertion proper. `featureBoundary` wins the merge here
    // because it is composed last and matches src/features/**, so its entry has
    // to re-declare the package bans — and it is src/features/** where nearly
    // all of this app eventually lives.
    const [, options] = await resolvedRule(
      'no-restricted-imports',
      'src/features/models/components/ModelCard.tsx',
    );
    const parsed = RestrictedImportOptions.parse(options);

    expect(parsed.paths.map((p) => p.name)).toContain('@metrika/database');
    expect(parsed.patterns.some((p) => p.regex !== undefined)).toBe(true);
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
    const rawManifest: unknown = JSON.parse(readFileSync(join(WEB_ROOT, 'package.json'), 'utf8'));
    const manifest = Manifest.parse(rawManifest);

    expect(settings.react.version).toBe(manifest.dependencies.react);
  });
});
