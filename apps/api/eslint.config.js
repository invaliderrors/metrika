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
    // real bootstrap rather than a hand-built module graph.
    files: ['test/**/*.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  { ignores: ['dist/**', 'coverage/**', 'openapi/**'] },
];
