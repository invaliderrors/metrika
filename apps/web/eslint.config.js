import {
  featureBoundary,
  next,
  serverActionBoundary,
  typeChecked,
  webBoundary,
} from '@metrika/eslint-config';

// Bound to a name rather than `export default [...]` directly. MEASURED:
// `eslint-config-next` enables `import/no-anonymous-default-export`, which
// reports an anonymous array literal as a WARNING on this very file. The root
// `lint` script is `turbo run lint -- --max-warnings=0` and CI's Lint step is a
// bare `pnpm lint`, so both gates run the same command and that warning fails
// both. It was locally invisible only while the flag lived in the workflow
// alone — see the ordering hazard documented below, which is the same shape.
// apps/api's config can and does export the array directly — it never loads
// eslint-config-next, so the rule is not enabled there.
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
  // eslint-config-prettier. That downgrade used to be invisible locally, while
  // `--max-warnings=0` lived only in CI's Lint step; the root `lint` script
  // carries the flag now and CI runs a bare `pnpm lint`, so both gates report
  // it. Order still matters, because `--max-warnings=0` only bites once some
  // file actually trips one of those rules, whereas the resolved severity is
  // wrong the moment these spreads are swapped. `test/eslint-order.test.ts`
  // asserts that severity directly; see also the ordering fixture in
  // packages/eslint-config.
  ...next({
    // Must equal the `react` pin in this package.json. `eslint-config-next`
    // sets 'detect', whose code path calls an ESLint 9 API that ESLint 10
    // removed — ESLint exits 2 before linting a single file. See ADR-0021.
    reactVersion: '19.2.8',
  }),
  ...typeChecked({ tsconfigRootDir: import.meta.dirname, project: './tsconfig.json' }),
  // The three boundary zones, and THIS ORDER IS LOAD-BEARING TOO — for a
  // different reason than the one above, which is about severity.
  //
  // Flat config replaces a rule's options wholesale when a later entry names the
  // same rule id and supplies options. All three collide: `webBoundary` and
  // `featureBoundary` both own `no-restricted-imports`, `webBoundary` and
  // `serverActionBoundary` both own `no-restricted-syntax`, and all three match
  // files under `src/`. The two later profiles re-declare `webBoundary`'s
  // entries for the files they cover, so this order loses nothing; reversed,
  // `webBoundary` would win everywhere and both other zones would vanish
  // silently. Neither `next()` nor `typeChecked()` sets either rule id —
  // MEASURED via calculateConfigForFile, both `undefined` before this block —
  // so nothing above is being clobbered by it.
  //
  // The composition tests live in packages/eslint-config
  // (test/web-boundaries.test.ts, `the three profiles composed together`).
  ...webBoundary,
  ...serverActionBoundary,
  ...featureBoundary,
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
  {
    // The Playwright config, and ONLY it. `process.env.CI` is what decides
    // `forbidOnly` and `reuseExistingServer`, and `WEB_PORT` is the port the
    // server under test binds — a literal 3000 there means a second project's
    // server on 3000 gets adopted and graded instead. This file cannot get
    // either of them
    // through `src/config/env.ts`: that module parses `clientEnv` at import, so
    // reading one runner flag through it would make `playwright test` refuse to
    // START unless the two NEXT_PUBLIC_ keys were exported into the shell —
    // when the entire point of `webServer.env` is that they are supplied to the
    // server under test instead.
    //
    // Scoped to the file rather than to a directory, deliberately. `e2e/**`
    // stays under the ban: a spec reading the ambient environment is how an
    // assertion starts depending on the machine it runs on, and everything the
    // suite needs is either in the config above it or in the shipped catalogue.
    // apps/api's `test/support.ts` exemption is the precedent for both the
    // mechanism and the narrowness.
    files: ['playwright.config.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  { ignores: ['.next/**', 'coverage/**', 'playwright-report/**', 'test-results/**'] },
];

export default config;
