import tseslint from 'typescript-eslint';
import { PROCESS_ENV_RESTRICTION } from './base.js';
import { RAW_SQL_SELECTORS } from './boundaries.js';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * apps/api/src/workflows — the determinism gate
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Temporal reconstructs a workflow's state by RE-EXECUTING its code against the
 * recorded history. Every expression that can answer differently on the second
 * run — the clock, randomness, the environment, the filesystem, a network call
 * — produces a workflow that passes every test today and fails on REPLAY after
 * a deploy. That is the worst failure shape in this system: it surfaces long
 * after the change that caused it, in code nobody is currently looking at, and
 * it takes the durable-execution guarantee down with it. Side effects belong in
 * activities, whose results are recorded once and replayed from history.
 *
 * ARCHITECTURE.md §23 names this profile as the enforcement — "Determinism is
 * enforced by lint … a dedicated ESLint zone bans those imports and globals in
 * that directory" — and CLAUDE.md states the rule it enforces: no `Date`, no
 * `Math.random`, no `crypto`, no `node:*`, no infrastructure imports.
 *
 * TAKES NO OPTIONS, and lands as a plain array rather than a `workflows(...)`
 * factory. Not one rule here is type-aware, so `parserOptions.project` would
 * buy a full TypeScript program for zero additional findings and cost something
 * real: with a project set, typescript-eslint fails with a FATAL PARSE ERROR on
 * any file that program does not contain. `react` carries the same reasoning at
 * length, and every boundary profile in `boundaries.js` is a plain array for the
 * same reason. Type-aware rules reach this directory the way they reach every
 * other one — by the consumer composing `nest({ tsconfigRootDir, project })`
 * alongside, which apps/api already does.
 *
 * SCOPED TO `src/workflows/**`, hardcoded, exactly as `prismaImportBoundary`
 * hardcodes `src/infrastructure/persistence/**`: `files` is relative to the
 * consuming package's `eslint.config.js`, so this is written for apps/api's
 * layout. A second consumer with a different layout composes its own scope
 * rather than widening this one.
 *
 * `.ts` only, and no exclusion for tests: apps/api's suites live in `test/`,
 * not beside the code (see its `vitest.config.ts`, `include: ['test/**\/*.test.ts']`).
 * A workflow test written under `src/workflows/` would be judged by the
 * allowlist below and rejected for importing `vitest` — correctly, because it
 * is in the wrong directory.
 *
 * COMPOSED LAST in apps/api, and it owns three rule ids that earlier profiles
 * also own. Flat config REPLACES a rule's options wholesale when a later entry
 * names the same id and supplies options; it merges nothing. So for every file
 * under `src/workflows/**` the entries below are the ONLY ones that run, and
 * anything not carried here is silently gone — no error, no warning, a green
 * build with a missing control. Measured in this repository twice before this
 * profile existed. The three collisions and their resolutions:
 *
 *   `no-restricted-properties`  `base` owns the process.env ban → carried in,
 *                               from the shared `PROCESS_ENV_RESTRICTION`.
 *   `no-restricted-syntax`      `rawSqlBan` owns the $queryRawUnsafe selectors
 *                               → carried in, from the shared constant.
 *   `no-restricted-imports`     `prismaImportBoundary` owns the Prisma denylist
 *                               → SUBSUMED rather than carried: the allowlist
 *                               below admits three packages and relative paths,
 *                               so `@prisma/client` and `@metrika/database` are
 *                               reported by it. Carried as well, they would be
 *                               reported twice for one import, which makes the
 *                               composition counts in the test suite say
 *                               nothing. `test/workflows.test.ts` asserts the
 *                               Prisma import is still reported here.
 */

/**
 * ONE list, TWO notations: a `no-restricted-imports` regex for static imports,
 * and an esquery attribute regex for `import()`. A package present in one but
 * not the other is a hole nothing reports — the failure that put `@prisma/client`
 * on `FORBIDDEN_WEB_PACKAGES`. Both are derived below so adding an entry cannot
 * leave a notation behind, and `test/workflows.test.ts` asserts the list itself
 * so that emptying it is red rather than quietly all-green.
 *
 * AN ALLOWLIST, not a denylist, and that is the whole point. "No `node:*` and no
 * `@prisma/client`" leaves `fastify`, `ioredis`, `@aws-sdk/*`, `pino` and every
 * future dependency reachable from workflow code, each of them a side effect
 * that replay cannot reproduce. Three packages are safe inside the sandbox:
 * the workflow SDK, the Temporal package it shares with the activity side
 * (`ApplicationFailure` and friends live there), and `@metrika/contracts`,
 * which imports nothing but zod and is the vocabulary the activity signatures
 * are written in. Everything else is reached through an activity.
 *
 * Widening this is a deliberate edit with a reviewer attached, which is the
 * correct shape for this decision — unlike a denylist, where the same widening
 * happens by default and silently.
 */
export const WORKFLOW_ALLOWED_PACKAGES = [
  '@temporalio/workflow',
  '@temporalio/common',
  '@metrika/contracts',
];

const importMessage =
  'apps/api/src/workflows may import only @temporalio/workflow, @temporalio/common, @metrika/contracts and relative modules. Everything else is a side effect replay cannot reproduce — call it from an activity. See docs/ARCHITECTURE.md §23.';

/**
 * `(?:$|/)` so a subpath of an allowed package (`@temporalio/workflow/lib/...`)
 * is allowed too, while a package that merely starts with an allowed name is
 * not. The relative-path branch matches `boundaries.js`: `\.{1,2}/` covers `./`
 * and `../` and nothing else.
 */
const allowedImportRegex = `^(?!(?:${WORKFLOW_ALLOWED_PACKAGES.join('|')})(?:$|/)|\\.{1,2}/).*`;

/**
 * Only `/` needs escaping for an esquery regex literal — it terminates the
 * literal — and no allowed package name contains another metacharacter.
 */
const allowedEsqueryAlternation = WORKFLOW_ALLOWED_PACKAGES.map((name) =>
  name.replaceAll('/', '\\/'),
).join('|');

/**
 * `no-restricted-imports` only ever inspects static import DECLARATIONS, so the
 * allowlist above is worth nothing against `await import('node:fs')`. TWO
 * selectors, for the reason `contractsBoundary` and `webBoundary` both spell
 * out: a template-literal specifier is a `TemplateLiteral`, not a `Literal`, so
 * a single selector narrowed to `[source.type='Literal']` lints
 * ``import(`node:fs`)`` completely clean. That hole was found in this repo, not
 * hypothesised.
 *
 * The second selector bans every non-literal specifier outright rather than
 * pattern-matching a template's static prefix, which would still be defeated by
 * ``import(`${pkg}/fs`)``. In workflow code that costs nothing: a specifier
 * computed at runtime is itself a determinism hazard, since the module graph a
 * replay loads has to be the one the original execution loaded.
 */
const dynamicImportSelectors = [
  {
    selector: `ImportExpression[source.type='Literal']:not([source.value=/^(?:${allowedEsqueryAlternation})($|\\/)/]):not([source.value=/^\\.{1,2}\\//])`,
    message: `${importMessage} (dynamic import())`,
  },
  {
    selector: "ImportExpression:not([source.type='Literal'])",
    message: `${importMessage} A dynamic import() here must use a plain string literal, so that both the boundary and the module graph a replay will load are decidable statically.`,
  },
];

/** @type {import('eslint').Linter.Config[]} */
export const workflows = [
  {
    files: ['src/workflows/**/*.ts'],
    // Set directly, with no `parserOptions`, so this profile works standalone
    // rather than depending on being composed after `typeChecked()` — which is
    // what test/eslint.workflows.config.js exercises. Composed after `nest()`
    // in the real app, flat config merges `languageOptions` per key, so
    // `typeChecked()`'s `parserOptions.project` survives untouched because this
    // object never sets `parserOptions`. Same reasoning as `boundaries.js`.
    languageOptions: { parser: tseslint.parser },
    rules: {
      /**
       * The globals, banned by NAME rather than by member access, because
       * `no-restricted-globals` reports the reference itself: one entry for
       * `Date` covers `new Date()`, `Date.now()`, `Date.parse()` and
       * `const D = Date` without a list of spellings to keep in sync.
       *
       * MEASURED, and the reason this rule is usable here at all: it reports
       * VALUE references and not type references, so `readonly at: Date` on an
       * activity's result type is not a false positive. Had it been one, this
       * would have had to be a set of syntax selectors instead — and a
       * determinism gate that rejects a type annotation is a gate that gets
       * switched off.
       */
      'no-restricted-globals': [
        'error',
        {
          name: 'Date',
          message:
            'The wall clock differs on every replay. Use workflow.now(), sleep() or the timer APIs from @temporalio/workflow — see docs/ARCHITECTURE.md §23.',
        },
        {
          name: 'crypto',
          message:
            'Randomness is not reproducible on replay. Use uuid4() from @temporalio/workflow, or generate the value in an activity — see docs/ARCHITECTURE.md §23.',
        },
        {
          name: 'performance',
          message:
            'performance.now() is a clock, and the clock differs on every replay. Use the timing APIs from @temporalio/workflow — see docs/ARCHITECTURE.md §23.',
        },
        {
          name: 'process',
          message:
            'Workflow code has no environment: the process that replays it is not the one that started it. Pass configuration in as a workflow argument, or read it in an activity.',
        },
        {
          // The third door into the module system, and the one that needs no
          // declaration at the top of the file to be missed in review.
          // `no-restricted-imports` sees `import`, the selectors above see
          // `import()`, and neither sees this.
          name: 'require',
          message:
            'Workflow code is ESM and its imports are checked statically; require() bypasses the import allowlist entirely.',
        },
      ],

      'no-restricted-properties': [
        'error',
        {
          // By PROPERTY, never as a global. Banning the `Math` namespace would
          // reject `Math.max`, `Math.ceil` and every other piece of arithmetic
          // in the directory, and a gate that rejects arithmetic is switched
          // off within a week — taking the determinism rules with it.
          object: 'Math',
          property: 'random',
          message:
            'Randomness is not reproducible on replay. Use uuid4() from @temporalio/workflow, or generate the value in an activity — see docs/ARCHITECTURE.md §23.',
        },
        {
          // `globalThis.Date` is a member access on `globalThis`, not a
          // reference to the global `Date`, so `no-restricted-globals` does not
          // see it at all. MEASURED: `new globalThis.Date()` linted clean
          // before this entry existed. Object-only, so it covers every banned
          // global reached that way rather than one name at a time; workflow
          // code has no legitimate use for `globalThis` in any case.
          object: 'globalThis',
          message:
            'Reach globals directly rather than through globalThis, so the determinism rules can see them — see docs/ARCHITECTURE.md §23.',
        },
        // Carried from `base`, whose entry this one replaces for every file in
        // the zone. See the composition note in the header.
        PROCESS_ENV_RESTRICTION,
      ],

      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // Anything that is not an allowed package, a subpath of one, or a
              // relative path. A `paths`/`group` denylist cannot express this:
              // the set being excluded is every package that exists.
              regex: allowedImportRegex,
              message: importMessage,
            },
          ],
        },
      ],

      'no-restricted-syntax': [
        'error',
        ...dynamicImportSelectors,
        // Carried from `rawSqlBan`, whose entry this one replaces for every
        // file in the zone. Workflow code should not be reaching a database at
        // all — the allowlist above sees to that — but the carry is what makes
        // the ban's disappearance impossible rather than merely unlikely.
        ...RAW_SQL_SELECTORS,
      ],
    },
  },
];
