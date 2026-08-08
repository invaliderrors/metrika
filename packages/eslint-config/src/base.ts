import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import importX from 'eslint-plugin-import-x';
import tseslint from 'typescript-eslint';

export const base = tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/out/**',
      '**/*.tsbuildinfo',
      '**/pnpm-lock.yaml',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      'import-x': importX,
    },
    rules: {
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'type'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'import-x/no-duplicates': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': ['error', 'always'],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='$queryRawUnsafe']",
          message: 'Use tagged-template $queryRaw',
        },
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'Banned — XSS risk',
        },
        {
          selector: 'TSEnumDeclaration',
          message: 'Use a string union or const object — enums break isolatedModules invariants',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Read configuration from config/env.ts only',
        },
      ],
    },
  },
  prettier,
);
