import { next, typeChecked } from '@metrika/eslint-config';

// Bound to a name rather than `export default [...]` directly. MEASURED:
// `eslint-config-next` enables `import/no-anonymous-default-export`, which
// reports an anonymous array literal as a WARNING on this very file. `pnpm
// verify` runs `turbo run lint` with no `--max-warnings` and would stay green;
// CI runs `pnpm lint -- --max-warnings=0` and would not. Same locally-invisible
// shape as the ordering hazard documented below. apps/api's config can and does
// export the array directly — it never loads eslint-config-next, so the rule
// is not enabled there.
const config = [
  // ORDER IS LOAD-BEARING, and `next()` alone is not enough.
  //
  // `next()` composes `react()`, which starts from `js.configs.recommended`
  // rather than this repo's `base`. On its own it resolves 156 rules against a
  // .tsx file; `nest()` — what apps/api gets — resolves 123, and 55 of those
  // are ABSENT under `next()` alone. Not just the type-aware set:
  // `no-restricted-properties` (the CLAUDE.md process.env ban),
  // `no-console` and `eqeqeq` are all OFF, and
  // `reportUnusedDisableDirectives` drops from error to warn. MEASURED.
  // Composing `typeChecked()` restores all 55 and takes the total to 210.
  //
  // `next()` FIRST. `eslint-config-next/typescript` sets
  // `@typescript-eslint/no-unused-vars: 'warn'` — severity only, so ESLint 10
  // preserves typeChecked()'s `^_` ignore patterns either way — but putting it
  // last still downgrades that rule and `no-unused-expressions` from error to
  // warn, and re-enables `no-unexpected-multiline` against
  // eslint-config-prettier. The downgrade is INVISIBLE LOCALLY: `pnpm verify`
  // runs `turbo run lint` with no `--max-warnings`, while CI passes
  // `--max-warnings=0`. See the ordering fixture in packages/eslint-config.
  ...next({
    // Must equal the `react` pin in this package.json. `eslint-config-next`
    // sets 'detect', whose code path calls an ESLint 9 API that ESLint 10
    // removed — ESLint exits 2 before linting a single file. See ADR-0021.
    reactVersion: '19.2.8',
  }),
  ...typeChecked({ tsconfigRootDir: import.meta.dirname, project: './tsconfig.json' }),
  {
    // The one sanctioned process.env reader, per CLAUDE.md. Everything else in
    // the app takes configuration through the exports of this module.
    //
    // This exemption is only meaningful because `typeChecked()` above turns
    // `no-restricted-properties` ON. Under `next()` alone the rule is off for
    // the whole app and this block would exempt nothing while reading as
    // enforcement — which is worse than having no exemption at all.
    files: ['src/config/env.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  { ignores: ['.next/**', 'coverage/**', 'playwright-report/**'] },
];

export default config;
