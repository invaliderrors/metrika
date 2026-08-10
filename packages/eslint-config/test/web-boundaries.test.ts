import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import config from './eslint.web-boundaries.config.js';

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
