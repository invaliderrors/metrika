import { typeChecked } from '@metrika/eslint-config';

export default [
  ...typeChecked({ tsconfigRootDir: import.meta.dirname, project: './tsconfig.json' }),
  {
    // The harnesses must read and write the ambient environment: to hand the
    // container's URL to `prisma migrate deploy`, and to publish the database
    // URLs and the Temporal address from globalSetup to the workers Vitest
    // forks afterwards. This is test infrastructure, not application
    // configuration, and these are the only readers in the package.
    files: ['src/database.ts', 'src/temporal.ts', 'src/global-setup.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  {
    // The self-test asserts on the variables globalSetup published.
    files: ['test/**/*.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  { ignores: ['dist/**'] },
];
