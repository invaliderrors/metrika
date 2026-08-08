import { contractsBoundary, typeChecked } from '@metrika/eslint-config';

export default [
  ...typeChecked({ tsconfigRootDir: import.meta.dirname, project: './tsconfig.json' }),
  // Scoped to src/**, not the whole package: tests legitimately import `vitest`
  // and `fast-check`, and vitest.config.ts imports `vitest/config`. The boundary
  // protects what ships, not what tests it.
  ...contractsBoundary.map((c) => ({ ...c, files: ['src/**/*.ts'] })),
  // dist/ and coverage/ are gitignored, but ESLint's flat config does not read
  // .gitignore, so they need an explicit ignore. vitest.config.ts is part of
  // tsconfig.json's `include`, and eslint.config.js is linted by `base`'s
  // non-type-aware rules only (typeChecked's type-aware rule set is scoped to
  // **/*.ts and **/*.tsx) — neither needs to be ignored.
  { ignores: ['dist/**', 'coverage/**'] },
];
