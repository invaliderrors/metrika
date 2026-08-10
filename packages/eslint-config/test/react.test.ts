import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import reactConfig from './eslint.react.config.js';
import nextConfig from './eslint.next.config.js';
import nextThenTypeChecked from './eslint.next-typechecked.config.js';
import typeCheckedThenNext from './eslint.typechecked-next.config.js';

async function run(config: unknown, code: string, filename: string): Promise<string[]> {
  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: config as never });
  const [result] = await eslint.lintText(code, { filePath: filename });
  return (result?.messages ?? []).map((m) => m.ruleId ?? '(fatal)');
}

/**
 * The fully resolved entry for one rule in a composed config — severity and
 * options both. `calculateConfigForFile` runs ESLint's own config merge without
 * linting anything, which is what makes an ordering assertion cheap enough to
 * be worth having.
 *
 * ESLint types `calculateConfigForFile` as returning `any`. Taken as `unknown`
 * and narrowed by hand rather than cast: this package's dependency surface is
 * deliberately tiny, so there is no Zod here to parse it with.
 */
async function resolvedRule(config: unknown, ruleId: string): Promise<unknown> {
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: config as never,
    cwd: import.meta.dirname,
  });
  const resolved: unknown = await eslint.calculateConfigForFile('fixtures/clean.ts');
  if (typeof resolved !== 'object' || resolved === null || !('rules' in resolved)) {
    throw new Error('calculateConfigForFile returned a config with no rules');
  }
  const rules = resolved.rules;
  if (typeof rules !== 'object' || rules === null) {
    throw new Error('calculateConfigForFile returned a non-object rules map');
  }
  return (rules as Record<string, unknown>)[ruleId];
}

// `async` on both, though neither awaits: `@typescript-eslint/promise-function-async`
// is an error in this repo's own profile and these return a Promise.
const lint = async (code: string, filename: string) => run(reactConfig, code, filename);
const lintWithNext = async (code: string, filename: string) => run(nextConfig, code, filename);

describe('the react profile', () => {
  it('rejects a conditional hook call', async () => {
    const rules = await lint(
      `export function C({ on }: { on: boolean }) {
         if (on) { const [v] = React.useState(0); return <p>{v}</p>; }
         return null;
       }`,
      'src/C.tsx',
    );
    expect(rules).toContain('react-hooks/rules-of-hooks');
  });

  it('rejects an image without alt text', async () => {
    const rules = await lint(`export const C = () => <img src="/a.png" />;`, 'src/C.tsx');
    expect(rules).toContain('jsx-a11y/alt-text');
  });

  it('does not require React to be in scope — the automatic runtime is on', async () => {
    const rules = await lint(`export const C = () => <p>ok</p>;`, 'src/C.tsx');
    expect(rules).not.toContain('react/react-in-jsx-scope');
  });

  it('accepts a correct component', async () => {
    const rules = await lint(
      `export const C = ({ label }: { label: string }) => <button type="button">{label}</button>;`,
      'src/C.tsx',
    );
    expect(rules).toEqual([]);
  });
});

/**
 * ADR-0021 obligation 3. `eslint-config-next` depends on eslint-plugin-react,
 * whose peer range excludes ESLint 10 and which has not published in 16
 * months; its `settings.react.version: 'detect'` path calls
 * `context.getFilename()`, removed in ESLint 10. The `next` profile overrides
 * that setting, and this block is what proves the override left the rules
 * REPORTING rather than merely stopping the crash.
 *
 * The distinction is not hypothetical here. Plan 0A shipped a config where
 * TypeScript resolved outside typescript-eslint's peer range and every
 * type-aware rule silently stopped running, with no error and a green build.
 * A test asserting the config loads would have passed throughout.
 */
describe('the next profile, against ADR-0021 obligation 3', () => {
  it('does not exit non-zero merely by loading', async () => {
    await expect(lintWithNext(`export const C = () => <p>ok</p>;`, 'src/C.tsx')).resolves.toEqual(
      [],
    );
  });

  it('still reports react/display-name — the rule whose detect path crashes', async () => {
    // Named specifically: this is the rule that throws under ESLint 10 without
    // the settings override, so it is the one whose silence would mean the
    // workaround masked the problem instead of fixing it.
    //
    // A `memo()` wrapper, not a component declared inside another component.
    // Measured against eslint-plugin-react@7.37.5: the inner-component form
    // reports `react-hooks/static-components` and NOT `react/display-name`,
    // because the inner component is bound to a named variable and the rule
    // infers a display name from it. An anonymous argument to `memo` has no
    // name to infer, which is the case the rule exists for.
    const rules = await lintWithNext(
      `import { memo } from 'react';
       export const C = memo(() => <p>x</p>);`,
      'src/C.tsx',
    );
    expect(rules).toContain('react/display-name');
  });

  it('still reports react/jsx-key', async () => {
    const rules = await lintWithNext(
      `export const C = () => <>{[1, 2].map((n) => <li>{n}</li>)}</>;`,
      'src/C.tsx',
    );
    expect(rules).toContain('react/jsx-key');
  });

  it('reports @next/next/no-img-element — proof eslint-config-next contributes rules', async () => {
    // The two assertions above prove eslint-plugin-react is live, but not that
    // eslint-config-next is: `react/display-name` and `react/jsx-key` are both
    // in react()'s own layer, so emptying every rule set eslint-config-next
    // contributes leaves them green while `@next/next/*` silently stops
    // reporting. That is a real regression shape — a future version moving its
    // rules to a different export would produce it — so the Next plugin gets
    // its own named rule. `alt` is present deliberately: this must fail on the
    // Next rule, not on jsx-a11y/alt-text.
    const rules = await lintWithNext(
      `export const C = () => <img src="/a.png" alt="a" />;`,
      'src/C.tsx',
    );
    expect(rules).toContain('@next/next/no-img-element');
  });
});

/**
 * The composition-order hazard, measured rather than asserted in a comment —
 * the comment that previously stood in for this test was wrong about the
 * mechanism, which is the argument for the test.
 *
 * `eslint-config-next/typescript` sets `@typescript-eslint/no-unused-vars` and
 * `@typescript-eslint/no-unused-expressions` to a bare `'warn'`. On ESLint
 * 10.8.0 a later entry supplying severity ALONE preserves the earlier entry's
 * options (a later `['warn', {}]` is what replaces them), so `typeChecked()`'s
 * `^_` ignore patterns survive either order. What does not survive is the
 * severity: composed last, `next()` downgrades both rules from error to warn.
 *
 * That used to be invisible where it is introduced: `pnpm verify` ran
 * `turbo run lint` with no `--max-warnings` while CI passed
 * `--max-warnings=0`, so a rule silently downgraded to `warn` was green locally
 * and red only in CI. The root `lint` script carries `--max-warnings=0` itself
 * now and CI's Lint step is a bare `pnpm lint`, so the two gates agree. The
 * downgrade still only surfaces once some file trips one of these rules, which
 * is why this test reads the resolved severity instead of linting anything.
 */
describe('composing next() with typeChecked()', () => {
  const rule = '@typescript-eslint/no-unused-vars';
  const options = {
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrorsIgnorePattern: '^_',
  };

  it('keeps no-unused-vars an error in the sanctioned order — next() first', async () => {
    expect(await resolvedRule(nextThenTypeChecked, rule)).toEqual([2, options]);
  });

  it('downgrades it to a warning in the reverse order, options intact — the hazard', async () => {
    // Two jobs. It is the negative control: without it, a `next()` that
    // contributed no rules at all would satisfy the assertion above by never
    // touching the severity. And asserting the OPTIONS survive is what pins the
    // mechanism — the comment this test replaced claimed the `^_` patterns were
    // dropped, and they are not.
    expect(await resolvedRule(typeCheckedThenNext, rule)).toEqual([1, options]);
  });
});

/**
 * R20. `packages/eslint-config` declares eslint-plugin-react, -react-hooks and
 * -jsx-a11y directly because src/react.js imports them by name and pnpm's
 * isolated node_modules makes a transitive import impossible. That is only
 * harmless while the declared pin and eslint-config-next's range resolve to the
 * SAME physical copy — measured true today, but nothing enforces it: forcing a
 * divergence (eslint-plugin-react@7.36.1 against its `^7.37.0`) produces two
 * store entries, and because next() strips react()'s plugin registrations,
 * every `react/*` rule implementation under next() would then come from
 * eslint-config-next's copy while the manifest pin kept lint-ing under react().
 * See docs/adr/0023-eslint-plugin-resolution.md.
 */
describe('plugin resolution, against ADR-0023', () => {
  it.each(['eslint-plugin-react', 'eslint-plugin-react-hooks', 'eslint-plugin-jsx-a11y'])(
    'resolves %s to the same physical copy eslint-config-next loads',
    (plugin) => {
      const packageRoot = path.resolve(import.meta.dirname, '..');
      const fromThisPackage = createRequire(path.join(packageRoot, 'package.json'));
      const configNextRoot = path.resolve(
        path.dirname(fromThisPackage.resolve('eslint-config-next/core-web-vitals')),
        '..',
      );
      const fromConfigNext = createRequire(path.join(configNextRoot, 'package.json'));

      expect(fs.realpathSync(fromThisPackage.resolve(plugin))).toBe(
        fs.realpathSync(fromConfigNext.resolve(plugin)),
      );
    },
  );
});
