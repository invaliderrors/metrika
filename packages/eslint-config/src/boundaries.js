import tseslint from 'typescript-eslint';

/**
 * packages/contracts is the root of the dependency graph. Anything it imports
 * propagates to every consumer, including the browser bundle. Only zod is
 * permitted. See docs/ARCHITECTURE.md §7.
 */
export const contractsBoundary = [
  {
    files: ['**/*.ts'],
    // `no-restricted-imports` only needs syntactic parsing, not type information,
    // but ESLint's default parser (espree) cannot parse TypeScript syntax at all.
    // Set the parser directly (no `project`) so this config works standalone —
    // it must not depend on being composed after `typeChecked()`, which is what
    // the fixture test in test/eslint.boundaries.config.js exercises. When this
    // config *is* composed after `typeChecked()` (as in packages/contracts/eslint.config.js),
    // flat config merges `languageOptions` per-key, so `typeChecked()`'s
    // `parserOptions.project` is untouched since this object never sets `parserOptions`.
    languageOptions: {
      parser: tseslint.parser,
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // Anything that is not exactly "zod" and not a relative path.
              // A `group: ['*']` pattern would also match relative imports,
              // which would forbid the package from importing itself.
              regex: '^(?!zod$|\\.{1,2}/).*',
              message:
                'packages/contracts may import only "zod" and relative modules — see docs/ARCHITECTURE.md §7',
            },
          ],
        },
      ],
      // `no-restricted-imports` only inspects static import declarations. A
      // dynamic `import()` needs a syntax rule, and it needs TWO selectors:
      // the literal case, and everything else. The previous single selector
      // was narrowed to `[source.type='Literal']`, so `import(`node:crypto`)`
      // with backticks — a TemplateLiteral, not a Literal — lint clean.
      // `tsc` backstops Node built-ins with TS2307, but not an
      // already-installed, typed package reached through a template literal.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "ImportExpression[source.type='Literal']:not([source.value='zod']):not([source.value=/^\\.{1,2}\\//])",
          message:
            'packages/contracts may import only "zod" and relative modules — see docs/ARCHITECTURE.md §7 (dynamic import())',
        },
        {
          selector: "ImportExpression:not([source.type='Literal'])",
          message:
            'packages/contracts may import only "zod" and relative modules, and a dynamic import() here must use a plain string literal so the boundary can be checked statically — see docs/ARCHITECTURE.md §7',
        },
      ],
      // packages/contracts/tsconfig.json includes test/** and vitest.config.ts,
      // which pull @types/node's ambient declarations into the same program as
      // src/**. Only `tsc -b tsconfig.build.json` rejects a Node global in
      // src/, so the editor and the type-aware lint program both see it as
      // valid and CI is the first thing to complain. Catch it here, where it is
      // reported at the keystroke. Companion to the import rule above: that one
      // blocks `node:*` specifiers, this one blocks the ambients that need no
      // import at all.
      'no-restricted-globals': [
        'error',
        {
          name: '__dirname',
          message: 'packages/contracts must not use Node globals — see docs/ARCHITECTURE.md §7',
        },
        {
          name: '__filename',
          message: 'packages/contracts must not use Node globals — see docs/ARCHITECTURE.md §7',
        },
        {
          name: 'Buffer',
          message: 'packages/contracts must not use Node globals — use Uint8Array',
        },
        {
          name: 'process',
          message: 'packages/contracts must not use Node globals — see docs/ARCHITECTURE.md §7',
        },
        {
          name: 'require',
          message: 'packages/contracts is ESM-only — see docs/ARCHITECTURE.md §7',
        },
        { name: 'module', message: 'packages/contracts is ESM-only — see docs/ARCHITECTURE.md §7' },
        {
          name: 'global',
          message: 'packages/contracts must not use Node globals — use globalThis',
        },
      ],
    },
  },
];

/**
 * ADR-0005: `@prisma/client` may only be imported from
 * apps/api/src/infrastructure/persistence/**. Nothing else in the codebase
 * knows Prisma exists — that is the boundary that keeps the domain from being
 * shaped by the ORM. `@metrika/database` is restricted the same way: it
 * re-exports Prisma types, so letting it through would be the same leak
 * wearing a different name.
 *
 * `ignores` is relative to the consuming package's eslint.config.js, which is
 * why this is scoped for apps/api's layout. A second consumer with a different
 * layout composes its own `ignores` rather than widening this one.
 *
 * Exported as its own named config, NOT as element [0] of a combined array.
 * `packages/database` needs the raw-SQL half without the import half, and a
 * consumer that reached for it with `prismaBoundary.slice(1)` would silently
 * swap the two halves the day these objects are reordered — either forbidding
 * the persistence package from importing Prisma, or dropping the
 * `$queryRawUnsafe` ban from the one package most exposed to it. Neither
 * failure produces an error; both produce a green build with a missing control.
 */
export const prismaImportBoundary = [
  {
    files: ['**/*.ts'],
    ignores: ['src/infrastructure/persistence/**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@prisma/client',
              message:
                'Prisma access goes through apps/api/src/infrastructure/persistence — see ADR-0005',
            },
            {
              name: '@metrika/database',
              message:
                'Prisma access goes through apps/api/src/infrastructure/persistence — see ADR-0005',
            },
          ],
          patterns: [
            {
              group: ['@prisma/client/*', '@metrika/database/*'],
              message:
                'Prisma access goes through apps/api/src/infrastructure/persistence — see ADR-0005',
            },
          ],
        },
      ],
    },
  },
];

/**
 * Not scoped by `ignores`: the raw-unsafe methods are banned inside persistence
 * too. They interpolate their argument straight into SQL, and config injection
 * into a query is a real attack surface here. The tagged template forms
 * ($queryRaw / $executeRaw) parameterise; these do not.
 */
export const rawSqlBan = [
  {
    files: ['**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='$queryRawUnsafe']",
          message: 'Use the tagged-template $queryRaw — $queryRawUnsafe does not parameterise',
        },
        {
          selector: "CallExpression[callee.property.name='$executeRawUnsafe']",
          message: 'Use the tagged-template $executeRaw — $executeRawUnsafe does not parameterise',
        },
      ],
    },
  },
];

/** Both halves, the composition `apps/api` uses. */
export const prismaBoundary = [...prismaImportBoundary, ...rawSqlBan];
