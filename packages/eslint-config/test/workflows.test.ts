import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import config from './eslint.workflows.config.js';
import composed from './eslint.workflows-composed.config.js';
import { WORKFLOW_ALLOWED_PACKAGES } from '../src/workflows.js';

const WORKFLOW_FILE = 'src/workflows/model-processing.workflow.ts';

async function lint(code: string, filePath = WORKFLOW_FILE): Promise<string[]> {
  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: config });
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => m.ruleId ?? '(fatal)');
}

async function lintComposed(code: string, filePath = WORKFLOW_FILE): Promise<string[]> {
  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: composed });
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => m.ruleId ?? '(fatal)');
}

/**
 * Temporal reconstructs a workflow's state by RE-EXECUTING its code against the
 * recorded history. Anything that can return a different answer on the second
 * run — the clock, randomness, the environment, the filesystem, a network call
 * — produces a workflow that passes every test today and fails on replay after
 * a deploy, which is the worst failure shape in this system: it surfaces long
 * after the change that caused it, on code nobody is looking at. Side effects
 * belong in activities, which are recorded once and replayed from history.
 *
 * ARCHITECTURE.md §23 names this profile as the enforcement: "Determinism is
 * enforced by lint … a dedicated ESLint zone bans those imports and globals in
 * that directory."
 */
describe('workflows — the clock, randomness and the environment', () => {
  it('rejects new Date()', async () => {
    expect(await lint(`export const startedAt = new Date();`)).toContain('no-restricted-globals');
  });

  it('rejects Date.now()', async () => {
    // Caught by the same entry as `new Date()`: `no-restricted-globals` reports
    // the REFERENCE to the global, so every spelling that reaches the clock
    // through `Date` is one rule entry rather than a list of member accesses to
    // keep in sync.
    expect(await lint(`export const t = Date.now();`)).toContain('no-restricted-globals');
  });

  it('rejects Math.random()', async () => {
    expect(await lint(`export const r = Math.random();`)).toContain('no-restricted-properties');
  });

  it('rejects crypto.randomUUID()', async () => {
    expect(await lint(`export const id = crypto.randomUUID();`)).toContain('no-restricted-globals');
  });

  it('rejects performance.now()', async () => {
    expect(await lint(`export const t = performance.now();`)).toContain('no-restricted-globals');
  });

  it('rejects reading the environment', async () => {
    expect(await lint(`export const url = process.env['TEMPORAL_ADDRESS'];`)).toContain(
      'no-restricted-globals',
    );
  });

  it('rejects require(), which would otherwise bypass the import allowlist', async () => {
    // `no-restricted-imports` and the ImportExpression selectors see `import`
    // and `import()` and nothing else. A CJS `require` is a third door into
    // the module system, and it is the one that needs no declaration at the top
    // of the file to be noticed in review.
    expect(await lint(`const fs = require('node:fs');`)).toContain('no-restricted-globals');
  });

  it('rejects reaching a banned global through globalThis', async () => {
    // `globalThis.Date` is not a reference to the global `Date`; it is a member
    // access on `globalThis`, so the entry that catches `new Date()` does not
    // see it at all. MEASURED before this entry existed: `new globalThis.Date()`
    // linted completely clean.
    expect(await lint(`export const d = new globalThis.Date();`)).toContain(
      'no-restricted-properties',
    );
  });

  it('ACCEPTS Math.max — the profile bans Math.random, not arithmetic', async () => {
    // The entire reason `Math` is restricted by PROPERTY rather than as a
    // global. A rule that bans the `Math` namespace breaks every piece of
    // arithmetic in the directory and gets switched off within a week, taking
    // the determinism gate with it.
    expect(await lint(`export const m = (a: number, b: number) => Math.max(a, b);`)).toEqual([]);
  });

  it('ACCEPTS a Date in type position', async () => {
    // MEASURED, and the reason `no-restricted-globals` is usable here at all:
    // it reports value references, not type references, so an activity result
    // typed as `Date` is not a false positive. Had it been one, this entry
    // would have had to be a set of syntax selectors instead.
    expect(await lint(`export interface Started { readonly at: Date }`)).toEqual([]);
  });
});

describe('workflows — the import allowlist', () => {
  it.each([
    ['a Node built-in', `import fs from 'node:fs';`],
    ['a Node built-in subpath', `import fs from 'node:fs/promises';`],
    ['@prisma/client', `import { PrismaClient } from '@prisma/client';`],
    ['@metrika/database', `import { db } from '@metrika/database';`],
    ['a @metrika/database subpath', `import { db } from '@metrika/database/client';`],
    ['the pricing kernel', `import { computePrice } from '@metrika/pricing-engine';`],
    ['a non-workflow Temporal entry point', `import { Client } from '@temporalio/client';`],
    ['the activity-side Temporal package', `import { Context } from '@temporalio/activity';`],
    ['an HTTP client', `import axios from 'axios';`],
  ])('rejects %s', async (_name, code) => {
    expect(await lint(code)).toContain('no-restricted-imports');
  });

  it.each([
    ['the workflow SDK', `import { proxyActivities } from '@temporalio/workflow';`],
    ['a workflow SDK subpath', `import { sleep } from '@temporalio/workflow/lib/workflow.js';`],
    ['the shared Temporal package', `import { ApplicationFailure } from '@temporalio/common';`],
    ['a type-only contracts import', `import type { Money } from '@metrika/contracts';`],
    ['a contracts subpath', `import { assertNever } from '@metrika/contracts/result';`],
    ['a sibling module', `import { compensate } from './compensation.js';`],
    ['a module one level up', `import type { Args } from '../shared/args.js';`],
  ])('ACCEPTS %s', async (_name, code) => {
    expect(await lint(code)).toEqual([]);
  });

  /**
   * The allowlist is expressed in two notations — a `no-restricted-imports`
   * regex and an esquery attribute regex on the dynamic-import selector — and a
   * package present in one but not the other is a hole nothing reports. Both
   * are derived from this constant, and this block is what proves the list
   * itself, so that emptying it (which would silently delete every `.each` case
   * above and leave a cheerful green run) is red.
   */
  it('is exactly the workflow-safe packages', () => {
    expect(WORKFLOW_ALLOWED_PACKAGES).toEqual([
      '@temporalio/workflow',
      '@temporalio/common',
      '@metrika/contracts',
    ]);
  });
});

describe('workflows — dynamic import()', () => {
  it('rejects a dynamic import of a forbidden module', async () => {
    expect(await lint(`export const load = () => import('node:fs');`)).toContain(
      'no-restricted-syntax',
    );
  });

  it('rejects a dynamic import written with a template literal', async () => {
    // A TemplateLiteral is not a Literal node, so the selector that catches the
    // case above does not catch this one. Two selectors, or a hole — the same
    // hole that was found, not hypothesised, in `contractsBoundary`.
    expect(await lint('export const load = () => import(`node:fs`);')).toContain(
      'no-restricted-syntax',
    );
  });

  it('rejects a dynamic import with a computed specifier', async () => {
    expect(await lint('export const load = (p: string) => import(p);')).toContain(
      'no-restricted-syntax',
    );
  });

  it('ACCEPTS a dynamic import of a relative module', async () => {
    expect(await lint(`export const load = () => import('./compensation.js');`)).toEqual([]);
  });

  it('ACCEPTS a dynamic import of the workflow SDK', async () => {
    expect(await lint(`export const load = () => import('@temporalio/workflow');`)).toEqual([]);
  });
});

describe('workflows — the zone is scoped to src/workflows', () => {
  it.each([
    'src/modules/quotes/application/create-quote.use-case.ts',
    'src/infrastructure/persistence/quote.repository.ts',
    'test/workflow.test.ts',
  ])('leaves %s alone', async (filePath) => {
    expect(
      await lint(
        `import fs from 'node:fs';\nexport const startedAt = new Date();\nexport const r = Math.random();`,
        filePath,
      ),
    ).toEqual([]);
  });

  it('covers a nested workflow module', async () => {
    expect(
      await lint(`export const t = Date.now();`, 'src/workflows/quote/steps/price.ts'),
    ).toContain('no-restricted-globals');
  });
});

/**
 * Composition, and the reason the profile carries rule entries it did not write.
 *
 * Flat config REPLACES a rule's options wholesale when a later entry names the
 * same rule id and supplies options. `workflows` is composed last in
 * `apps/api/eslint.config.js` and it owns three ids that earlier profiles also
 * own — so for every file under `src/workflows/**` its entry is the ONLY one
 * that runs, and anything it does not carry is silently gone. No error, no
 * warning, a green build with a missing control. Measured in this repository
 * twice before this profile existed.
 *
 * Counts rather than `toContain`, because losing one half of a pair is exactly
 * the failure being guarded against.
 */
describe('workflows — composed after base and prismaBoundary', () => {
  it("keeps base's process.env ban inside the zone", async () => {
    expect(await lintComposed(`export const url = process.env['DATABASE_URL'];`)).toContain(
      'no-restricted-properties',
    );
  });

  it('reports Math.random AND process.env from one file', async () => {
    const rules = await lintComposed(
      `export const r = Math.random();\nexport const url = process.env['DATABASE_URL'];`,
    );
    expect(rules.filter((r) => r === 'no-restricted-properties')).toHaveLength(2);
  });

  it('reports a Prisma import AND a Node built-in import from one file', async () => {
    const rules = await lintComposed(
      `import { PrismaClient } from '@prisma/client';\nimport fs from 'node:fs';\nexport const p = [PrismaClient, fs];`,
    );
    expect(rules.filter((r) => r === 'no-restricted-imports')).toHaveLength(2);
  });

  it("keeps rawSqlBan's selectors inside the zone, alongside the dynamic-import ban", async () => {
    const rules = await lintComposed(
      `export async function f(db: { $queryRawUnsafe: (s: string) => Promise<void> }) {\n  await db.$queryRawUnsafe('select 1');\n  await import('node:fs');\n}`,
    );
    expect(rules.filter((r) => r === 'no-restricted-syntax')).toHaveLength(2);
  });

  it('leaves the neighbouring zones intact outside src/workflows', async () => {
    // The mirror of the cases above: `workflows` must not have taken anything
    // away from the rest of the app on its way in. `@prisma/client` is still
    // `prismaImportBoundary`'s to report here, and the determinism rules must
    // not have leaked out of the directory they belong to.
    const rules = await lintComposed(
      `import { PrismaClient } from '@prisma/client';\nexport const startedAt = new Date();\nexport const p = PrismaClient;`,
      'src/modules/quotes/application/create-quote.use-case.ts',
    );
    expect(rules).toEqual(['no-restricted-imports']);
  });
});
