import { nest, prismaBoundary } from '@metrika/eslint-config';

export default [
  ...nest({ tsconfigRootDir: import.meta.dirname, project: './tsconfig.json' }),
  ...prismaBoundary,
  {
    // The one sanctioned process.env reader, per CLAUDE.md. Everything else in
    // the app takes configuration through EnvService.
    files: ['src/config/env.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  {
    // Integration tests must inject the Testcontainers URL into the ambient
    // environment before the app boots — that is what makes them exercise the
    // real bootstrap rather than a hand-built module graph. Scoped to exactly
    // the files that do that (the shared boot fixture and the *.integration.test.ts
    // suites themselves), not every file under test/**: a unit test reading
    // process.env directly would defeat the reason parseEnv() takes a `source`
    // argument instead of reading the ambient environment itself.
    files: ['test/support.ts', 'test/**/*.integration.test.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  { ignores: ['dist/**', 'coverage/**', 'openapi/**'] },
];
