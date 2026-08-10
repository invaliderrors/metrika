import { featureBoundary, serverActionBoundary, webBoundary } from '../src/index.js';

// The order apps/web/eslint.config.js uses, and it is load-bearing: the two
// later profiles re-declare `webBoundary`'s rule entries for the files they
// cover, because flat config replaces a rule's options rather than merging
// them. Reversed, `webBoundary` wins for every file and the other two zones
// silently disappear. See the block comment above `webBoundary` in
// src/boundaries.js, and the composition tests in web-boundaries.test.ts.
//
// Bound to an annotated name rather than `export default [...]`: web-boundaries.test.ts
// imports this file as a module, and an inferred default export is TS2883
// ("cannot be named without a reference to 'RulesConfig'") under `composite`.
/** @type {import('eslint').Linter.Config[]} */
const config = [...webBoundary, ...serverActionBoundary, ...featureBoundary];

export default config;
