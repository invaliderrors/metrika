import tseslint from 'typescript-eslint';

import { typeChecked } from './type-checked.js';

export const nest = tseslint.config(...typeChecked, {
  rules: {
    '@typescript-eslint/explicit-member-accessibility': [
      'error',
      { accessibility: 'explicit', overrides: { constructors: 'no-public' } },
    ],
    '@typescript-eslint/no-parameter-properties': 'off',
  },
});
