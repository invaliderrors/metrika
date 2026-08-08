import { typeChecked } from '@metrika/eslint-config';

export default [
  ...typeChecked({ tsconfigRootDir: import.meta.dirname, project: './tsconfig.json' }),
  // eslint.config.js and vitest.config.ts sit outside tsconfig.json's `include`
  // (`src/**/*.ts`, `test/**/*.ts`), so they have no membership in the type-checked
  // project and typescript-eslint's type-aware rules cannot get parser services for
  // them. Excluding them from lint here is narrower than widening the tsconfig
  // project to cover tooling config files.
  { ignores: ['dist/**', 'coverage/**', 'eslint.config.js', 'vitest.config.ts'] },
];
