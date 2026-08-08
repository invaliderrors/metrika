import tseslint from 'typescript-eslint';

import { base } from './base.js';

/**
 * Loose config for one-off scripts (seed, emit, migration helpers).
 * Still no `any` and no unused vars — but console + process.env are fine.
 */
export const script = tseslint.config(...base, {
  rules: {
    'no-console': 'off',
    'no-restricted-properties': 'off',
  },
});
