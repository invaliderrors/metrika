import { typeChecked } from './src/index.js';

// The "lint" script invokes this file explicitly via `-c` rather than
// letting `eslint .` discover it. ESLint's flat config resolves the
// governing config per file by walking up from that file's own directory,
// and test/eslint.config.js sits closer to everything under test/
// (including test/fixtures/**) than this file does — so plain `eslint .`
// would silently use THAT config for the whole test/ subtree instead of
// this one, defeating both the ignores below and this file's own
// type-checked rules for test/rules.test.ts. `-c` pins one config for the
// entire run; test/eslint.config.js remains reachable on its own terms,
// through the ESLint instances rules.test.ts constructs programmatically.
export default [
  ...typeChecked({ tsconfigRootDir: import.meta.dirname, project: './tsconfig.json' }),
  // test/fixtures/**: exercised by test/rules.test.ts through its own nested
  // ESLint configs (see tsconfig.json's comment) — not part of this
  // program, and several are deliberately invalid or forbidden-import
  // fixtures that this config would otherwise choke on or wrongly flag.
  { ignores: ['test/fixtures/**'] },
];
