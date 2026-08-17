import { ESLint } from 'eslint';
import path from 'node:path';
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

  it('forbids importing @metrika/database outside infrastructure/persistence', async () => {
    // The `paths` entry for @metrika/database, distinct from the @prisma/client
    // one above — deleting just this entry leaves @prisma/client covered and
    // this fixture would lint clean.
    expect(await lintWithPrismaBoundary('database-outside-persistence.ts')).toContain(
      'no-restricted-imports',
    );
  });

  it('forbids @prisma/client and @metrika/database subpath imports outside infrastructure/persistence', async () => {
    // The `patterns` group (`@prisma/client/*`, `@metrika/database/*`) is a
    // separate matcher from the bare-specifier `paths` entries above — a
    // subpath import like `@prisma/client/edge` is not caught by `paths` at
    // all. Asserting a count of 2, not a bare `toContain`, so deleting either
    // half of the `group` array (leaving the other) still goes red.
    const rules = await lintWithPrismaBoundary('prisma-subpath-imports.ts');
    expect(rules.filter((r) => r === 'no-restricted-imports')).toHaveLength(2);
  });

  it('forbids $queryRawUnsafe', async () => {
    expect(await lintWithPrismaBoundary('raw-unsafe-query.ts')).toContain('no-restricted-syntax');
  });

  it('forbids $executeRawUnsafe', async () => {
    // A separate selector from $queryRawUnsafe above — deleting just this one
    // leaves $queryRawUnsafe covered and this fixture would lint clean.
    expect(await lintWithPrismaBoundary('raw-unsafe-execute.ts')).toContain('no-restricted-syntax');
  });
});

describe('prisma boundary — ignores glob, exercised through an apps/api-shaped probe', () => {
  // fixtures/persistence-probe/ has its own eslint.config.js (`export default
  // [...prismaBoundary]`) at its root, exactly like a real consumer package's
  // eslint.config.js would. `ignores: ['src/infrastructure/persistence/**/*.ts']`
  // in prismaImportBoundary is resolved relative to THAT config file's
  // location, not to this test file's — which is also why the assertions
  // above lint fixtures/*.ts directly rather than through this probe: a flat
  // fixtures/ directory can never itself be "inside infrastructure/persistence".
  const probeRoot = path.join(import.meta.dirname, 'fixtures/persistence-probe');

  async function lintProbe(relativeFile: string): Promise<readonly string[]> {
    const eslint = new ESLint({ cwd: probeRoot, overrideConfigFile: 'eslint.config.js' });
    const [result] = await eslint.lintFiles([relativeFile]);
    return (result?.messages ?? []).map((m) => m.ruleId ?? 'unknown');
  }

  it('still forbids @prisma/client outside infrastructure/persistence in the probe', async () => {
    // The negative control: without it, an `ignores` glob broad enough to
    // swallow everything would satisfy the two tests below by finding
    // nothing anywhere.
    expect(await lintProbe('src/domain/order.ts')).toContain('no-restricted-imports');
  });

  it('allows @prisma/client inside infrastructure/persistence, including a nested subdirectory', async () => {
    const top = await lintProbe('src/infrastructure/persistence/repository.ts');
    const nested = await lintProbe('src/infrastructure/persistence/nested/repository.ts');
    expect(top.filter((r) => r === 'no-restricted-imports')).toHaveLength(0);
    expect(nested.filter((r) => r === 'no-restricted-imports')).toHaveLength(0);
  });

  it('still forbids $queryRawUnsafe and $executeRawUnsafe inside infrastructure/persistence — rawSqlBan is not scoped by the import ignores', async () => {
    const rules = await lintProbe('src/infrastructure/persistence/raw-queries.ts');
    expect(rules.filter((r) => r === 'no-restricted-syntax')).toHaveLength(2);
  });

  // ── ADR-0041: the second exempt zone, and the three ways it must NOT widen ──

  it('allows @metrika/database inside a module’s own infrastructure/ — the location ARCHITECTURE.md documents', async () => {
    const rules = await lintProbe('src/modules/users/infrastructure/repository.ts');
    expect(rules.filter((r) => r === 'no-restricted-imports')).toHaveLength(0);
  });

  it('still forbids it one segment outside that zone — `*` matches a single segment', async () => {
    // Without this, `src/modules/**/infrastructure/**` would pass the row above
    // while also exempting `src/modules/users/application/infrastructure/**`,
    // which is not a persistence zone and was never meant to be one.
    expect(await lintProbe('src/modules/users/application/service.ts')).toContain(
      'no-restricted-imports',
    );
  });

  it('forbids reaching branding.js from outside a persistence zone', async () => {
    // ADR-0018's guarantee is that a branded id cannot be minted from a bare
    // string wherever `brandUnsafe` is reachable, so the helper is confined to
    // the same zone as Prisma itself.
    expect(await lintProbe('src/modules/users/application/branding-reach.ts')).toContain(
      'no-restricted-imports',
    );
  });

  it('lets the branding TEST import branding.js while still banning the packages — the narrowing stayed narrow', async () => {
    // THE NEGATIVE CONTROL FOR THE EXEMPTION ITSELF. Flat config replaces a
    // rule's options wholesale, so a second config object naming
    // `no-restricted-imports` for this path drops every entry it does not
    // repeat. This fixture imports BOTH `branding.js` (must be allowed) and
    // `@metrika/database` (must still be rejected); asserting only the first
    // would pass just as well against an exemption that had silently deleted
    // the package bans.
    const rules = await lintProbe('test/branding.test.ts');
    expect(rules.filter((r) => r === 'no-restricted-imports')).toHaveLength(1);
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

  it('does not autofix a value-imported injected dependency into `import type`', async () => {
    // consistent-type-imports stays ON in nest(): typescript-eslint suppresses
    // it for a class-typed constructor parameter only when the RESOLVED
    // program has both experimentalDecorators and emitDecoratorMetadata, and
    // the file contains a decorator. `nest-app.module.ts` has neither an
    // import nor a constructor, so it can never exercise this — it only
    // proves the *.module.ts relaxation. widget.controller.ts is the fixture
    // that can actually fail: a decorated class with a real, value-imported
    // constructor dependency. `fix: true` computes what `pnpm lint:fix` would
    // write; ESLint only sets `result.output` when it would actually rewrite
    // something. If the suppression condition isn't met by the tsconfig this
    // config resolves against, `WidgetService` gets silently rewritten to
    // `import { type WidgetService }`, which erases `design:paramtypes` and
    // breaks NestJS DI at boot with no compiler or lint diagnostic either way.
    const eslint = new ESLint({
      cwd: import.meta.dirname,
      overrideConfigFile: 'eslint.nest.config.js',
      fix: true,
    });
    const [result] = await eslint.lintFiles(['fixtures/widget.controller.ts']);
    expect(result?.output).toBeUndefined();
  });
});
