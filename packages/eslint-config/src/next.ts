import tseslint from 'typescript-eslint';

import { react } from './react.js';

export const next = tseslint.config(...react, {
  rules: {
    '@next/next/no-html-link-for-pages': 'off',
  },
});
