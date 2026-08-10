import js from '@eslint/js';
// Imported under `*Plugin` names so the exported profile can be called `react`
// without shadowing the plugin it is built from.
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import jsxA11yPlugin from 'eslint-plugin-jsx-a11y';
import tseslint from 'typescript-eslint';

/**
 * Framework-agnostic React rules. `next()` composes this; nothing here may
 * import or assume Next, so a future package (packages/ui) can take this
 * profile without dragging a framework in.
 *
 * Takes no tsconfig options, unlike `typeChecked()`/`nest()`, and that is
 * deliberate rather than an oversight. Not one rule this profile enables is
 * type-aware — `react`, `react-hooks` and `jsx-a11y` are all syntactic — so
 * `parserOptions.project` would buy a full TypeScript program build for zero
 * additional findings, and it would cost something real: with `project` set,
 * typescript-eslint fails with a *fatal parse error* on any file that program
 * does not contain, which is how a shared profile ends up rejecting a file it
 * was never meant to judge. `boundaries.js` sets `languageOptions.parser`
 * directly for the same reason: a profile has to work standalone rather than
 * only when composed after `typeChecked()`. Type-aware rules come from
 * composing `typeChecked({ tsconfigRootDir, project })` alongside this, exactly
 * as every other package in this repo gets them; flat config merges
 * `languageOptions.parserOptions` per key, so `typeChecked()`'s `project`
 * survives this object's `ecmaFeatures` and vice versa.
 *
 * It sets no `settings.react.version` either, which makes eslint-plugin-react
 * print "React version not specified" once per run. Leave it. The obvious fix
 * — `settings: { react: { version: 'detect' } }` — is the crash ADR-0021's
 * spike found: the detect path calls `context.getFilename()`, removed in ESLint
 * 10, and ESLint exits 2 having linted nothing. A profile that must stay
 * framework-agnostic has no React version to pin, so it takes the warning;
 * `next()` pins a literal. If a consumer wants the warning gone it appends
 * `{ settings: { react: { version: '<its own react pin>' } } }` — a literal,
 * never `'detect'`.
 *
 * @returns {import('eslint').Linter.Config[]}
 */
export const react = () => [
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      // Set directly, not inherited: ESLint's default parser (espree) cannot
      // parse TypeScript syntax at all, and this profile must be able to lint a
      // .tsx file on its own — see the note above.
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    // `next()` strips this key back out. ESLint 10 throws
    // `Cannot redefine plugin "<name>"` when two config objects that apply to
    // the same file register one plugin name with objects that are not `===`,
    // and `eslint-config-next` registers all three of these itself — reaching
    // eslint-plugin-jsx-a11y through a Babel `_interop_require_wildcard` helper
    // that builds a fresh object, an identity no import form here can
    // reproduce. See src/next.js.
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
      'jsx-a11y': jsxA11yPlugin,
    },
    rules: {
      // Accessor names verified against the pinned versions rather than
      // assumed — they have moved between majors. `eslint-plugin-react@7.37.5`
      // exposes its flat set at `configs.flat.recommended`
      // (`configs.recommended` is the eslintrc one);
      // `eslint-plugin-react-hooks@7.1.1` exposes `configs.recommended` as a
      // flat config already; `eslint-plugin-jsx-a11y@6.10.2` puts its flat sets
      // under `flatConfigs`, not `configs.flat`.
      ...reactPlugin.configs.flat.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,
      ...jsxA11yPlugin.flatConfigs.recommended.rules,

      // The automatic JSX runtime has been the default since React 17; these
      // two rules exist for the classic runtime and fire on every correct file
      // under the automatic one.
      'react/react-in-jsx-scope': 'off',
      'react/jsx-uses-react': 'off',

      // TypeScript checks props. prop-types would be a second, weaker source
      // of truth for the same thing.
      'react/prop-types': 'off',
    },
  },
];
