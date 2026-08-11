import { base, prismaBoundary, workflows } from '../src/index.js';

// `apps/api/eslint.config.js`'s order, reduced to the three parts that collide.
//
// Flat config REPLACES a rule's options wholesale when a later entry names the
// same rule id and supplies options. `workflows` is last and it owns all three
// of the colliding ids:
//
//   `no-restricted-properties` — `base` owns it (the process.env ban)
//   `no-restricted-imports`    — `prismaImportBoundary` owns it
//   `no-restricted-syntax`     — `rawSqlBan` owns it
//
// and every one of them matches `src/workflows/**`, so the collisions are real
// rather than theoretical. The composition cases in `workflows.test.ts` are the
// only place that can see them: every per-profile case lints a file that only
// one profile's rules speak to, so each passes whether or not its neighbour
// survived the merge.
//
// `nest()` is what apps/api actually composes first, not `base` — but `nest()`
// resolves to `typeChecked()`, which sets `parserOptions.project`, and with a
// project set typescript-eslint fails with a fatal parse error on any file the
// program does not contain. Every case here lints a virtual path through
// `lintText`, so no such file exists. `base` is the part of that chain that
// owns a colliding rule, which is the part these cases are about.
//
// `no-undef` is the one thing that has to be turned back off to make the
// substitution faithful: `base` is `js.configs.recommended`, which enables it,
// and the real app gets it switched off for TypeScript files from
// `strictTypeChecked`'s `eslintRecommended` block — which arrives with
// `typeChecked()` and therefore not here. Left on, every `Date` and `crypto`
// fixture below would carry an extra `no-undef` message that says nothing about
// this profile.
/** @type {import('eslint').Linter.Config[]} */
const config = [
  ...base,
  { files: ['**/*.ts'], rules: { 'no-undef': 'off' } },
  ...prismaBoundary,
  ...workflows,
];

export default config;
