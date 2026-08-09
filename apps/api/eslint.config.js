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
  {
    // `metrikaDto()` is a convention until something enforces it: `ZodResponse`
    // has overloads that accept a non-codec DTO and silently check the weaker
    // side (input<T> instead of output<T>), so `class Dto extends
    // createZodDto(S) {}` compiles clean and ships a branded-ID field
    // unvalidated. This rule is what makes the funnel the only way in.
    //
    // The `@typescript-eslint/` extension rule, not the core one, deliberately.
    // Flat config REPLACES a rule's options wholesale when a later entry names
    // the same rule: a second core `no-restricted-imports` block matching
    // src/**/*.ts would silently drop prismaImportBoundary's @prisma/client ban
    // for every file both blocks match. Verified — the Prisma finding
    // disappears with no error and no warning. The extension is a different
    // rule id, so the two coexist and both fire.
    files: ['src/**/*.ts'],
    ignores: ['src/shared/http/zod-dto.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'nestjs-zod',
              importNames: ['createZodDto'],
              message:
                'Use metrikaDto() from src/shared/http/zod-dto.ts — a bare createZodDto() DTO type-checks fine and ships unvalidated. See ADR-0019.',
            },
          ],
        },
      ],
    },
  },
  { ignores: ['dist/**', 'coverage/**', 'openapi/**'] },
];
