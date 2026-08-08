import tseslint from 'typescript-eslint';

import { typeChecked } from './type-checked.js';

/**
 * Temporal workflow determinism guardrails.
 * Workflow code must be deterministic: no Date, Math.random, crypto, node:*, or I/O.
 */
export const workflows = tseslint.config(...typeChecked, {
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['node:*'],
            message: 'Workflow code must be deterministic — no node:* imports',
          },
          {
            group: ['**/infrastructure/**'],
            message: 'Workflow code must be deterministic — do I/O in activities',
          },
        ],
      },
    ],
    'no-restricted-globals': [
      'error',
      { name: 'Date', message: 'Use Temporal workflow time APIs — Date is non-deterministic' },
      {
        name: 'Math',
        message: 'Math.random is non-deterministic — inject randomness via activity',
      },
      {
        name: 'crypto',
        message: 'crypto is non-deterministic — do it in an activity',
      },
    ],
  },
});
