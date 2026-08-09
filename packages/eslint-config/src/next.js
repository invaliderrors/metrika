import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';
import { react } from './react.js';

/**
 * @param {import('eslint').Linter.Config} entry
 * @returns {import('eslint').Linter.Config}
 */
const withoutPluginRegistrations = (entry) => {
  // `delete` on a fresh shallow copy rather than `({ plugins, ...rest }) => rest`:
  // core `no-unused-vars` defaults `ignoreRestSiblings` to false, so the
  // omitted binding would be an error, and silencing it with a disable comment
  // would put a suppression in the middle of the one line that has to stay
  // obvious.
  const copy = { ...entry };
  delete copy.plugins;
  return copy;
};

/**
 * `react` plus Next's own rules and the App Router's constraints.
 *
 * Two entry points, measured by ADR-0021's spike: `eslint-config-next/flat`
 * does not exist and throws ERR_PACKAGE_PATH_NOT_EXPORTED. Both default-export
 * arrays of config objects.
 *
 * `eslint-config-next` also `require`s `next/dist/compiled/babel/eslint-parser`
 * without declaring `next` as a dependency or a peer, so importing this module
 * throws MODULE_NOT_FOUND unless `next` is installed somewhere pnpm can resolve
 * it from. `apps/web` has it as a real dependency; this package carries it as a
 * devDependency so its own fixture can load the profile at all.
 *
 * `react()`'s plugin registrations are stripped on the way in. ESLint 10 throws
 * `Cannot redefine plugin "jsx-a11y"` when two config objects that apply to the
 * same file register one plugin name with objects that are not `===`, and
 * `eslint-config-next` registers `react`, `react-hooks` and `jsx-a11y` itself.
 * It reaches jsx-a11y through a Babel `_interop_require_wildcard` helper that
 * constructs a fresh object, so no import form in react.js can produce a
 * matching identity — registering once, theirs, is the only composition ESLint
 * accepts. The rules still resolve, because both config objects apply to the
 * same `.tsx` file and ESLint resolves a rule's plugin from the merged config.
 * If a future `eslint-config-next` stops registering one of these names the
 * failure is loud (`Could not find plugin`), not silent.
 *
 * The `settings` block LAST is load-bearing, not cosmetic. `eslint-config-next`
 * sets `react.version: 'detect'`, and eslint-plugin-react's detect path calls
 * `context.getFilename()` — removed in ESLint 10 — so ESLint exits 2 before
 * linting anything. Overriding it after the shared config is what makes the
 * React rules run at all. The version string must track apps/web's react pin.
 * See ADR-0021 obligation 3, and the fixture in test/react.test.ts that proves
 * the rules still report rather than merely that the config loads.
 *
 * Flat config replaces a rule's options wholesale when a later entry names the
 * same rule id, and three layers here do: `react()`'s rules,
 * `eslint-config-next`'s block (which re-declares `react/*`, `react-hooks/*`
 * and six `jsx-a11y/*` rules, several at `warn` with its own options), and
 * `eslint-config-next/typescript` (which sets `@typescript-eslint/no-unused-vars`
 * to `warn`, discarding any options an earlier entry gave it). Next's values
 * win here by design — it owns the framework's rules. The consequence for
 * whoever composes this: put `typeChecked()` AFTER `next()`, never before, or
 * this profile silently downgrades `no-unused-vars` to a warning and drops its
 * `^_` ignore patterns.
 *
 * `reactVersion` must equal apps/web's `react` pin. It is required rather than
 * defaulted: a default would drift from package.json silently, which is the
 * exact failure obligation 3 exists to prevent.
 *
 * Annotated with `@type` rather than `@param`/`@returns` because the inferred
 * return type reaches into `@eslint/core`'s `RulesConfig` through
 * eslint-config-next's declarations, which `composite`'s declaration emit
 * rejects as unnameable (TS2883).
 *
 * @type {(options: { reactVersion: string }) => import('eslint').Linter.Config[]}
 */
export const next = ({ reactVersion }) => [
  ...react().map(withoutPluginRegistrations),
  ...coreWebVitals,
  ...typescript,
  { settings: { react: { version: reactVersion } } },
];
