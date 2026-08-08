import { typeChecked } from '@metrika/eslint-config';

export default [
  ...typeChecked,
  {
    files: ['prisma/seed.ts', 'scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
      'no-restricted-properties': 'off',
    },
  },
];
