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
      // `no-restricted-imports` only inspects static `import`/`export ... from`
      // declarations — it has no visibility into a dynamic `import()` call,
      // whose target is an arbitrary expression, not an import specifier. A
      // `return import('node:crypto')` inside packages/contracts/src lints
      // clean under the rule above alone. Catch it as a syntax pattern
      // instead: an ImportExpression whose argument is a string literal that
      // is not exactly "zod" and does not start with "./" or "../" — the
      // same two exceptions as the static-import rule above, checked the
      // same way. A non-literal argument (e.g. `import(someModuleName)`) is
      // not matched here: its target cannot be checked statically at all,
      // and no code in this repo needs one, static or dynamic.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "ImportExpression[source.type='Literal']:not([source.value='zod']):not([source.value=/^\\.{1,2}\\//])",
          message:
            'packages/contracts may import only "zod" and relative modules — see docs/ARCHITECTURE.md §7 (dynamic import())',
        },
      ],
    },
  },
];
