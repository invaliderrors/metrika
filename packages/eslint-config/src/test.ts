import tseslint from 'typescript-eslint';
import vitest from 'eslint-plugin-vitest';

import { base } from './base.js';

export const test = tseslint.config(...base, {
  plugins: { vitest },
  rules: {
    ...vitest.configs.recommended.rules,
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unsafe-assignment': 'off',
    '@typescript-eslint/no-unsafe-member-access': 'off',
    '@typescript-eslint/no-unsafe-call': 'off',
    '@typescript-eslint/no-non-null-assertion': 'off',
    '@typescript-eslint/no-unnecessary-condition': 'off',
    '@typescript-eslint/unbound-method': 'off',
    'vitest/no-focused-tests': 'error',
    'vitest/no-disabled-tests': 'warn',
    'vitest/expect-expect': 'error',
    'vitest/prefer-to-be': 'error',
    'vitest/no-identical-title': 'error',
  },
});
