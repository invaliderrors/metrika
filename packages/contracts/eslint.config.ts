import { typeChecked, boundaries } from '@metrika/eslint-config';

export default [
  ...typeChecked,
  ...boundaries,
  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
];
