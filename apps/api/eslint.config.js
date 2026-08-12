import { nest, prismaBoundary, workflows } from '@metrika/eslint-config';

export default [
  ...nest({ tsconfigRootDir: import.meta.dirname, project: './tsconfig.json' }),
  ...prismaBoundary,
  // The Temporal determinism gate, scoped to src/workflows/** by the profile
  // itself. AFTER `prismaBoundary` deliberately: it owns `no-restricted-imports`
  // and `no-restricted-syntax` for the files it matches, and flat config gives
  // those ids to the LAST entry that supplies options. Reversed, the zone would
  // lose both halves for every workflow file with no error and no warning.
  // It carries what it displaces — `base`'s process.env ban and `rawSqlBan`'s
  // selectors — and subsumes the Prisma denylist under its own import
  // allowlist; see the header of packages/eslint-config/src/workflows.js and
  // the composition cases in that package's test/workflows.test.ts.
  ...workflows,
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
    // `test/fixtures/**.mjs` is a PROCESS, not a module: the telemetry suite
    // spawns it to run the built application under plain `node`, because
    // require-in-the-middle — which every OpenTelemetry instrumentation patches
    // through — does not intercept module loading under Vitest. The shared
    // profiles give Node globals to `.ts` files only (`type-checked` scopes
    // itself to `**/*.ts`), so without this the fixture's `process`,
    // `setImmediate` and `fetch` are `no-undef` errors.
    //
    // Named INDIVIDUALLY rather than pulling in a globals package: these three
    // are what a spawned entry point needs, and a fixture reaching for a fourth
    // should have to say so here. `process` is `readonly`, so the
    // `no-restricted-properties` ban on `process.env` above still applies —
    // the fixture takes its one argument from `process.argv` for that reason.
    files: ['test/fixtures/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', setImmediate: 'readonly', fetch: 'readonly' },
    },
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
