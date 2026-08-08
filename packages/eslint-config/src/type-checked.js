import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import { base } from './base.js';

/**
 * @param {{ tsconfigRootDir: string, project?: string | string[] }} options
 * @returns {import('eslint').Linter.Config[]}
 */
export function typeChecked(options) {
  return tseslint.config(
    ...base,
    {
      // `strictTypeChecked` is spread in via `extends` rather than directly, so that
      // typescript-eslint's config helper applies this object's `files` restriction to
      // it too. Spreading it in bare (as `...tseslint.configs.strictTypeChecked`) applies
      // its type-aware rules to every file ESLint lints, including plain `.js` files like
      // `eslint.config.js` — which then crash because they have no membership in the
      // type-checked project the `parserOptions.project` below points at.
      files: ['**/*.ts', '**/*.tsx'],
      extends: [tseslint.configs.strictTypeChecked],
      languageOptions: {
        parserOptions: {
          projectService: options.project === undefined,
          project: options.project,
          tsconfigRootDir: options.tsconfigRootDir,
        },
      },
      rules: {
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/no-misused-promises': 'error',
        '@typescript-eslint/switch-exhaustiveness-check': 'error',
        '@typescript-eslint/consistent-type-imports': [
          'error',
          { fixStyle: 'inline-type-imports' },
        ],
        '@typescript-eslint/consistent-type-exports': 'error',
        '@typescript-eslint/no-non-null-assertion': 'error',
        '@typescript-eslint/promise-function-async': 'error',
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
        ],
        '@typescript-eslint/strict-boolean-expressions': [
          'error',
          {
            allowNullableBoolean: true,
            allowNullableString: true,
            allowNullableObject: true,
            allowNumber: false,
            allowString: false,
          },
        ],
        // Documented exceptions — see docs/TYPESCRIPT_AND_TOOLING.md §3
        '@typescript-eslint/require-await': 'off',
        '@typescript-eslint/explicit-function-return-type': 'off',
        '@typescript-eslint/explicit-module-boundary-types': 'off',
      },
    },
    // `base` already ends with `prettier`, but `strictTypeChecked` and the override
    // above are spread in after it, which pushes it out of the last slot in the array
    // this function actually returns. Re-append it here so "prettier is last" is
    // structural for `typeChecked()`'s output, not just true inside `base` by luck.
    prettier,
  );
}
