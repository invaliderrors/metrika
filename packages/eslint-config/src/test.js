// Test-file scoping for later, non-type-safety concerns (vitest globals, the
// `eslint-plugin-vitest` rule set, etc.). It deliberately relaxes nothing today: the
// six `@typescript-eslint/no-unsafe-*` rules and `no-non-null-assertion` are errors
// everywhere, tests included, with no blanket exception — see the Global Constraints.
// A genuinely safe case in a specific test is a suppression comment with a mandatory
// `-- <justification>` at that line, not a repo-wide `off` nobody has to explain.
/** @type {import('eslint').Linter.Config[]} */
export const test = [
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/test/**/*.ts'],
    rules: {},
  },
];
