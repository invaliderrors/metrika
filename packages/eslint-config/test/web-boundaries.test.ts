import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import config from './eslint.web-boundaries.config.js';
import { FORBIDDEN_WEB_PACKAGES } from '../src/boundaries.js';

async function lint(code: string, filePath: string): Promise<string[]> {
  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: config });
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => m.ruleId ?? '(fatal)');
}

describe('webBoundary', () => {
  it('rejects importing @metrika/database', async () => {
    const rules = await lint(`import { x } from '@metrika/database';`, 'src/app/page.tsx');
    expect(rules).toContain('no-restricted-imports');
  });

  it('rejects importing @metrika/pricing-engine', async () => {
    const rules = await lint(`import { p } from '@metrika/pricing-engine';`, 'src/app/page.tsx');
    expect(rules).toContain('no-restricted-imports');
  });

  it('rejects a dynamic import of a forbidden package', async () => {
    const rules = await lint(`await import('@metrika/database');`, 'src/app/page.tsx');
    expect(rules).toContain('no-restricted-syntax');
  });

  it('rejects a dynamic import written with a template literal', async () => {
    // A TemplateLiteral is not a Literal node, so the selector that catches
    // the line above does not catch this one. Two selectors, or a hole.
    const rules = await lint('await import(`@metrika/database`);', 'src/app/page.tsx');
    expect(rules).toContain('no-restricted-syntax');
  });

  it('accepts @metrika/contracts', async () => {
    const rules = await lint(
      `import type { Money } from '@metrika/contracts';`,
      'src/app/page.tsx',
    );
    expect(rules).toEqual([]);
  });
});

describe('serverActionBoundary', () => {
  it("rejects 'use server' outside the two sanctioned locations", async () => {
    const rules = await lint(`'use server';\nexport async function f() {}`, 'src/app/thing.ts');
    expect(rules).toContain('no-restricted-syntax');
  });

  it("accepts 'use server' in an actions.ts file", async () => {
    const rules = await lint(
      `'use server';\nexport async function setLocale() {}`,
      'src/app/settings/actions.ts',
    );
    expect(rules).toEqual([]);
  });

  it("accepts 'use server' under src/lib/session", async () => {
    const rules = await lint(
      `'use server';\nexport async function f() {}`,
      'src/lib/session/cookie.ts',
    );
    expect(rules).toEqual([]);
  });
});

describe('featureBoundary', () => {
  it('rejects a deep import into another feature', async () => {
    const rules = await lint(
      `import { X } from '../../quotes/components/QuoteCard';`,
      'src/features/models/components/ModelCard.tsx',
    );
    expect(rules).toContain('no-restricted-imports');
  });

  it("accepts another feature's public surface", async () => {
    const rules = await lint(
      `import { QuoteCard } from '../../quotes';`,
      'src/features/models/components/ModelCard.tsx',
    );
    expect(rules).toEqual([]);
  });

  it('accepts a deep import within the SAME feature', async () => {
    const rules = await lint(
      `import { useModel } from '../hooks/use-model';`,
      'src/features/models/components/ModelCard.tsx',
    );
    expect(rules).toEqual([]);
  });
});

/**
 * Every notation the app can write, because the pattern got both ends of the
 * climb wrong before they were measured, and then missed two notations entirely.
 *
 * The climb out of a feature is as long as the IMPORTING file is deep, and the
 * public surface of a feature is `index.ts` at its ROOT — so the single-`../`
 * row below is the central violation, not an edge case: it is the one file
 * every other feature imports through. A `\.\./\.\./` pattern misses it while
 * catching every deep caller, which is the worst outcome available (the zone
 * looks enforced).
 *
 * THE TWO NOTATIONS THE RELATIVE-ONLY PATTERN MISSED, both measured against
 * these fixtures before the pattern was widened:
 *
 *   `@/features/quotes/components/QuoteCard`     the app's own alias, declared
 *                                                in apps/web's tsconfig.json and
 *                                                vitest.config.ts and already
 *                                                used for `@/lib/cn`
 *   `../../../features/quotes/components/…`      a file deep enough to climb
 *                                                past `src/features/`, where the
 *                                                segment after the climb is
 *                                                `features`, not the feature
 *                                                name
 *
 * The alias row that follows them is the deliberate cost, stated as a test
 * rather than left to be discovered: `no-restricted-imports` sees the specifier
 * and never the importing file, so it cannot tell `@/features/models/...` read
 * from inside `models` apart from the same text read from inside `quotes`. The
 * alias into ANY feature's internals is therefore reported, and a same-feature
 * import is written relatively — which the `accepts` block below requires
 * anyway.
 *
 * The `accepts` rows are the other half, and they are why the pattern is not
 * simply `../`. `[^/]+` matches `..`, so without the `(?!\.\.)` guard a
 * same-feature `../../hooks/use-model` backtracks into `../` + `..` + `/hooks/`
 * and is REJECTED — a false positive on ordinary intra-feature code, which is
 * how a boundary gets switched off within a week. The two `@/` rows there pin
 * the other direction: widening the pattern to the alias must not catch the
 * public surface or the app's ordinary non-feature imports.
 */
describe('featureBoundary — the climb depth', () => {
  it.each([
    ['src/features/models/index.ts', '../quotes/components/QuoteCard'],
    ['src/features/models/components/ModelCard.tsx', '../../quotes/components/QuoteCard'],
    ['src/features/models/components/a/b/C.tsx', '../../../../quotes/components/QuoteCard'],
    ['src/features/models/index.ts', '../quotes/hooks/use-quote'],
    ['src/features/models/components/ModelCard.tsx', '@/features/quotes/components/QuoteCard'],
    ['src/features/models/index.ts', '@/features/quotes/schemas/quote'],
    [
      'src/features/models/components/ModelCard.tsx',
      '../../../features/quotes/components/QuoteCard',
    ],
    // Same feature, alias form: reported on purpose. See the header.
    ['src/features/models/components/ModelCard.tsx', '@/features/models/hooks/use-model'],
  ])('rejects %s importing %s', async (file, specifier) => {
    const rules = await lint(`import { X } from '${specifier}';`, file);
    expect(rules).toContain('no-restricted-imports');
  });

  it.each([
    ['src/features/models/components/ModelCard.tsx', '../hooks/use-model'],
    ['src/features/models/components/nested/Deep.tsx', '../../hooks/use-model'],
    ['src/features/models/components/a/b/C.tsx', '../../../hooks/use-model'],
    ['src/features/models/hooks/use-model.ts', '../components/ModelCard'],
    ['src/features/models/components/ModelCard.tsx', '@/features/quotes'],
    ['src/features/models/components/ModelCard.tsx', '@/lib/cn'],
  ])('accepts %s importing %s', async (file, specifier) => {
    const rules = await lint(`import { X } from '${specifier}';`, file);
    expect(rules).toEqual([]);
  });
});

/**
 * Every forbidden package, in every notation it has to be written in.
 *
 * `paths`, the `patterns` glob group and the esquery attribute regex are three
 * different spellings of the same list, and a package present in two of the
 * three is a hole nothing reports — which is exactly how `@prisma/client` came
 * to be reachable from apps/web while `prismaImportBoundary` "covered" it.
 * `src/boundaries.js` derives all three from `FORBIDDEN_WEB_PACKAGES`; this
 * block is what proves the derivations actually reach the linter, and it runs
 * over the imported constant so a package added there is covered here without
 * anyone remembering to add a case.
 */
describe.each(FORBIDDEN_WEB_PACKAGES)('the %s ban', (pkg) => {
  it('rejects the bare specifier', async () => {
    expect(await lint(`import { x } from '${pkg}';`, 'src/app/page.tsx')).toContain(
      'no-restricted-imports',
    );
  });

  it('rejects a subpath import', async () => {
    expect(await lint(`import { x } from '${pkg}/edge';`, 'src/app/page.tsx')).toContain(
      'no-restricted-imports',
    );
  });

  it('rejects a dynamic import', async () => {
    expect(await lint(`await import('${pkg}');`, 'src/app/page.tsx')).toContain(
      'no-restricted-syntax',
    );
  });

  it('is still banned inside src/features, where featureBoundary wins the merge', async () => {
    const rules = await lint(
      `import { x } from '${pkg}';`,
      'src/features/models/components/ModelCard.tsx',
    );
    expect(rules).toEqual(['no-restricted-imports']);
  });
});

/**
 * The companion to the block above: `describe.each` proves whatever is on the
 * list is enforced, and this proves what is on the list. Without it, emptying
 * `FORBIDDEN_WEB_PACKAGES` would delete every assertion above it and the suite
 * would report a cheerful all-green with zero cases run.
 */
describe('the forbidden package list', () => {
  it('is exactly the three server-only packages', () => {
    expect(FORBIDDEN_WEB_PACKAGES).toEqual([
      '@metrika/database',
      '@metrika/pricing-engine',
      '@prisma/client',
    ]);
  });
});

/**
 * The composition assertions, and the reason the three profiles are written the
 * way they are.
 *
 * Flat config REPLACES a rule's options wholesale when a later config object
 * names the same rule id and supplies options — it does not merge them. All
 * three profiles collide on that: `webBoundary` and `featureBoundary` both own
 * `no-restricted-imports`, and `webBoundary` and `serverActionBoundary` both own
 * `no-restricted-syntax`. Measured in this repo twice already: a second
 * `no-restricted-imports` block in apps/api silently dropped the earlier
 * `@prisma/client` ban with no error and no warning, and `rawSqlBan` carries a
 * comment about exactly this hazard against `contractsBoundary`.
 *
 * The `describe` blocks above cannot see it. Each of them exercises a file that
 * only one profile's `files` glob matches, so each passes whether or not the
 * other profile survived the merge. These do: one file, two violations, and a
 * COUNT rather than a `toContain`, so losing either half goes red.
 */
describe('the three profiles composed together', () => {
  it('reports a forbidden package AND a cross-feature deep import from one file', async () => {
    const rules = await lint(
      `import { PrismaClient } from '@metrika/database';\nimport { X } from '../../quotes/components/QuoteCard';\nexport const p = [PrismaClient, X];`,
      'src/features/models/components/probe.tsx',
    );
    expect(rules.filter((r) => r === 'no-restricted-imports')).toHaveLength(2);
  });

  it("reports a dynamic forbidden import AND a stray 'use server' from one file", async () => {
    const rules = await lint(
      `'use server';\nexport async function f() { await import('@metrika/database'); }`,
      'src/app/thing.ts',
    );
    expect(rules.filter((r) => r === 'no-restricted-syntax')).toHaveLength(2);
  });

  it('still bans a dynamic forbidden import inside a sanctioned server-action file', async () => {
    // `serverActionBoundary` exempts actions.ts by NOT matching it, which hands
    // `no-restricted-syntax` back to `webBoundary`. If that hand-off were
    // written as `rules: { 'no-restricted-syntax': 'off' }` instead, the
    // exemption would take the dynamic-import ban down with it — in the one
    // kind of file that runs on the server and can reach the database.
    const rules = await lint(
      `'use server';\nexport async function f() { await import('@metrika/database'); }`,
      'src/app/settings/actions.ts',
    );
    expect(rules).toEqual(['no-restricted-syntax']);
  });

  it('still bans a forbidden package import inside a feature file', async () => {
    // The mirror of the case above, for `no-restricted-imports`: inside
    // src/features/** it is `featureBoundary`'s entry that wins the merge, so
    // that entry has to carry the package bans as well as the cross-feature
    // patterns. Without this, every feature in the app — which is where nearly
    // all of the app eventually lives — could import the database freely.
    const rules = await lint(
      `import { p } from '@metrika/pricing-engine';`,
      'src/features/models/components/ModelCard.tsx',
    );
    expect(rules).toEqual(['no-restricted-imports']);
  });
});
