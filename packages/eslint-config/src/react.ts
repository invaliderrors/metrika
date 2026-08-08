import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';

import { typeChecked } from './type-checked.js';

export const react = tseslint.config(...typeChecked, {
  plugins: {
    react,
    'react-hooks': reactHooks,
    'jsx-a11y': jsxA11y,
  },
  languageOptions: {
    parserOptions: {
      ecmaFeatures: { jsx: true },
    },
  },
  settings: {
    react: { version: 'detect' },
  },
  rules: {
    ...react.configs.recommended.rules,
    ...reactHooks.configs.recommended.rules,
    ...jsxA11y.configs.recommended.rules,
    'react/react-in-jsx-scope': 'off',
    'react/prop-types': 'off',
    'react/jsx-uses-react': 'off',
  },
});
