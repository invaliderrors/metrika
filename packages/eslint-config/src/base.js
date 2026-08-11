import js from '@eslint/js';
import prettier from 'eslint-config-prettier';

/**
 * Exported so a narrower profile that also owns `no-restricted-properties` can
 * carry it rather than re-type it.
 *
 * Flat config REPLACES a rule's options wholesale when a later config object
 * names the same rule id and supplies options — it merges nothing. `workflows`
 * sets `no-restricted-properties` for `src/workflows/**` and is composed after
 * this profile, so without carrying this entry it would silently switch the
 * environment ban off for exactly the directory that must never read the
 * environment. Shared as a constant rather than duplicated so the two copies
 * cannot drift; `test/workflows.test.ts` asserts it survives the merge.
 */
export const PROCESS_ENV_RESTRICTION = {
  object: 'process',
  property: 'env',
  message: 'Read configuration from config/env.ts only',
};

/** @type {import('eslint').Linter.Config[]} */
export const base = [
  js.configs.recommended,
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'no-console': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-properties': ['error', PROCESS_ENV_RESTRICTION],
    },
  },
  prettier,
];
