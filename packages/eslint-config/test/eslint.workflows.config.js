import { workflows } from '../src/index.js';

// The profile on its own, which is how `workflows.test.ts`'s per-rule cases
// exercise it: nothing else is composed in, so an `accepts` case asserting
// `toEqual([])` is asserting about THIS profile rather than about whatever
// else happened to be in the array.
//
// The trailing catch-all matches every `.ts` file without governing any of
// them. It exists so a file OUTSIDE `src/workflows/**` is still a file ESLint
// has a configuration for — that is what makes the "the zone is scoped" cases
// meaningful, because a clean result there has to mean "no rule fired" rather
// than "no config matched, so nothing ran".
//
// Bound to an annotated name rather than `export default [...]` for the same
// reason as test/eslint.web-boundaries.config.js: this file is imported as a
// MODULE by the test, and an inferred default export is TS2883 under
// `composite`.
/** @type {import('eslint').Linter.Config[]} */
const config = [...workflows, { files: ['**/*.ts'], rules: {} }];

export default config;
