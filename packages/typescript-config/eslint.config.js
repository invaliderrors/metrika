import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

// Deliberately NOT built on @metrika/eslint-config's typeChecked(), even
// though that would normally be the shared way to do this: eslint-config
// already depends on @metrika/typescript-config (its fixture tests compile
// against packages/eslint-config/test/tsconfig.json, which extends
// ./base.json). A dependency back in this direction would make the two
// packages a cycle, which Turbo's `dependsOn: ["^typecheck"]` refuses to
// schedule at all ("Cyclic dependency detected"). `tseslint.configs.recommended`
// (not `strictTypeChecked`) is also not type-aware, so this needs no
// `parserOptions.project` and stays self-contained.
export default tseslint.config(
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'no-console': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // Re-declared rather than inherited: this config cannot import
      // @metrika/eslint-config's `base` without creating a package cycle (see
      // the comment above), and `process.env` is a repo-wide invariant, not an
      // eslint-config-package concern. `base` itself carries only this one
      // rule beyond `no-console`/`eqeqeq`, both already declared above — what
      // genuinely cannot come along is `typeChecked()`'s much larger
      // type-aware rule set (all of `strictTypeChecked`, plus
      // `consistent-type-imports`, `consistent-type-exports`,
      // `promise-function-async`, `strict-boolean-expressions`, and more):
      // those need a type-aware program this config deliberately does not
      // build, and that gap is accepted.
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Read configuration from config/env.ts only',
        },
      ],
    },
  },
  prettier,
  // test/fixtures/**: deliberately invalid, one strict-flag violation each —
  // linting them would just report the violation they exist to demonstrate.
  {
    ignores: [
      'test/fixtures/**',
      'test/web-fixtures/**',
      'test/nest-fixtures/**',
      'test/next-fixtures/**',
      'test/.tmp-nest-out/**',
    ],
  },
);
