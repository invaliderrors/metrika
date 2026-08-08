import { nest, test as testProfile, boundaries } from '@metrika/eslint-config';

export default [
  ...nest,
  ...boundaries,
  {
    files: ['**/*.test.ts', 'test/**/*.ts'],
    ...testProfile[testProfile.length - 1],
  },
];
