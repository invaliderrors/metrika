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
 * throws MODULE_NOT_FOUND unless `next` is in the dependency graph. `apps/web`
 * has it as a real dependency; this package carries it as a devDependency so
 * its own fixture can load the profile at all. Note the mechanism: the
 * devDependency here does NOT put `next` in
 * `packages/eslint-config/node_modules` for eslint-config-next's benefit —
 * eslint-config-next resolves it by walking up from its own directory in the
 * virtual store into `node_modules/.pnpm/node_modules`, pnpm's hoisted
 * fallback. Declaring it is what puts it in the store at all. This would break
 * under `hoist=false`.
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
 * Three layers here name the same rule ids: `react()`'s rules,
 * `eslint-config-next`'s block (which re-declares `react/*`, `react-hooks/*`
 * and six `jsx-a11y/*` rules, several at `warn` with its own options), and
 * `eslint-config-next/typescript`. Next's values win by design — it owns the
 * framework's rules.
 *
 * What that costs a consumer is narrower than "options are replaced", and the
 * difference matters. Measured on ESLint 10.8.0: a later entry supplying
 * severity ALONE (`'warn'` or `['warn']`) sets the severity and PRESERVES the
 * earlier entry's options; only `['warn', {}]` — severity plus options —
 * replaces them. `eslint-config-next/typescript` supplies a bare `'warn'`, so
 * composing this profile after `typeChecked()` does not drop its `^_` ignore
 * patterns; they survive intact. What it does is:
 *
 *   - downgrade `@typescript-eslint/no-unused-vars` from error to warn,
 *   - downgrade `@typescript-eslint/no-unused-expressions` the same way,
 *   - re-enable `no-unexpected-multiline`, which `eslint-config-prettier`
 *     turns off.
 *
 * A downgrade to `warn` is the dangerous one, because the two gates disagree:
 * `pnpm verify` runs `turbo run lint` with no `--max-warnings`, while CI runs
 * `pnpm lint -- --max-warnings=0`. The regression is green locally and red only
 * in CI. So: compose `typeChecked()` AFTER `next()`, never before.
 * test/react.test.ts pins the resolved severity in both orders.
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
