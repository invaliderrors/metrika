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
 *
 * Also owns `no-restricted-syntax`, the same rule key `contractsBoundary`
 * owns above. Flat config replaces a rule's options per key rather than
 * merging them, so composing `rawSqlBan` after `contractsBoundary` in the
 * same consumer's config (unreachable today — nothing imports both) would
 * silently drop whichever one applied first. If that composition is ever
 * needed, it has to keep both rule-sets under one `no-restricted-syntax`
 * entry rather than two config objects.
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

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * apps/web — three zones, and one hazard shared by all of them
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Flat config REPLACES a rule's options wholesale when a later config object
 * names the same rule id AND supplies options; it merges nothing. (Supplying a
 * bare severity is the other case — that one preserves the earlier options, which
 * is how `eslint-config-next/typescript` leaves `typeChecked()`'s `no-unused-vars`
 * patterns alone. Both directions measured in this repo.)
 *
 * The three profiles below collide on exactly that, twice over:
 *
 *   `no-restricted-imports` — owned by `webBoundary` and by `featureBoundary`
 *   `no-restricted-syntax`  — owned by `webBoundary` and by `serverActionBoundary`
 *
 * and every one of them matches files under `src/`, so the collisions are real
 * rather than theoretical. The precedent is already in this file: `rawSqlBan`
 * carries a comment saying that if it ever had to be composed alongside
 * `contractsBoundary`, both rule-sets would have to live under ONE
 * `no-restricted-syntax` entry rather than two config objects. This is that
 * situation, so that is what these do.
 *
 * The resolution: the shared entries are hoisted to the constants below, and
 * whichever profile wins the merge for a given file carries the full union for
 * that file. Concretely — `featureBoundary` matches only `src/features/**`, so
 * it wins `no-restricted-imports` there and must carry the package bans too;
 * `serverActionBoundary` matches everything except the sanctioned server-action
 * paths, so it wins `no-restricted-syntax` there and must carry the dynamic
 * import ban too.
 *
 * COMPOSITION ORDER: `webBoundary` first, then the other two. It is the one that
 * can be dropped from the merge without a hole, because the other two re-declare
 * its entries for the files they cover. Reversed, `webBoundary` would win for
 * every file and both of the other zones would silently vanish — no error, no
 * warning, a green build with two missing controls.
 *
 * The `describe('the three profiles composed together')` block in
 * test/web-boundaries.test.ts is what holds this together. The per-profile tests
 * cannot: each of them lints a file only one profile's glob matches, so each
 * passes whether or not its neighbour survived the merge.
 */

/**
 * `apps/web` is presentation only, per CLAUDE.md. `@metrika/database` is a
 * Prisma client and `@metrika/pricing-engine` is the pricing kernel; a price
 * computed in the browser is a second source of truth for the number the
 * customer is asked to agree to, and the reproducibility property depends on
 * there being exactly one. `@prisma/client` is named alongside them because
 * ADR-0005 confines it to apps/api/src/infrastructure/persistence — reaching it
 * directly rather than through `@metrika/database` is the same leak wearing a
 * different name, and `prismaImportBoundary` is scoped to apps/api's layout so
 * nothing was stopping it here.
 */
const forbiddenWebPackageMessage =
  'apps/web is presentation only — data access and pricing happen server-side, behind the API. See CLAUDE.md (Boundaries) and ADR-0005.';

/**
 * ONE list, three derivations. Each forbidden package has to be expressed in
 * three different notations — a `paths` entry, a `patterns` glob group, and an
 * esquery attribute regex — and a package present in two of the three is a hole
 * that nothing reports. That is not hypothetical: `@prisma/client` is on this
 * list precisely because it had been written into `prismaImportBoundary`'s
 * apps/api-scoped copy and nowhere else, so apps/web could reach it directly.
 *
 * Derived rather than duplicated, so adding a package here cannot leave a
 * notation behind. test/web-boundaries.test.ts imports this constant and runs
 * every case over it with `describe.each`, so a new entry is automatically
 * covered in all four positions (bare, subpath, dynamic, inside src/features)
 * — and asserts the list's contents besides, so quietly deleting an entry is
 * also red.
 *
 * Exported for that test only; `src/index.js` does not re-export it, because it
 * is an implementation detail of these three profiles rather than something a
 * consuming package composes.
 */
export const FORBIDDEN_WEB_PACKAGES = [
  '@metrika/database',
  '@metrika/pricing-engine',
  '@prisma/client',
];

const forbiddenWebPackagePaths = FORBIDDEN_WEB_PACKAGES.map((name) => ({
  name,
  message: forbiddenWebPackageMessage,
}));

/**
 * Subpath imports (`@metrika/database/client`) are invisible to `paths`, which
 * only ever matches a bare specifier — the same split `prismaImportBoundary`
 * makes above, and the same reason its fixture asserts a count of 2.
 */
const forbiddenWebPackagePatterns = [
  {
    group: FORBIDDEN_WEB_PACKAGES.map((name) => `${name}/*`),
    message: forbiddenWebPackageMessage,
  },
];

/**
 * `no-restricted-imports` only inspects static import declarations, so the ban
 * above is worth nothing against `await import('@metrika/database')`. TWO
 * selectors, for the reason spelled out on `contractsBoundary`: a template
 * literal specifier is a `TemplateLiteral`, not a `Literal`, so a single
 * selector narrowed to `[source.type='Literal']` lints
 * ``import(`@metrika/database`)`` completely clean. That hole was found in this
 * repo, not hypothesised.
 *
 * The second selector bans every non-literal specifier outright rather than
 * trying to pattern-match a template's static prefix, which would still be
 * defeated by ``import(`${pkg}/database`)``. That costs apps/web nothing:
 * src/i18n/request.ts already writes one literal `import()` per locale instead
 * of the template form, and documents that the template form cannot pass this
 * repo's lint anyway — a template-literal specifier resolves to `any`, and
 * `.default` off an `any` is `no-unsafe-member-access`.
 *
 * The alternation is built from `FORBIDDEN_WEB_PACKAGES` rather than written
 * out, so this notation cannot drift from the other two. Only `/` needs
 * escaping — it terminates esquery's regex literal — and no package name here
 * contains another regex metacharacter.
 */
const forbiddenDynamicImportAlternation = FORBIDDEN_WEB_PACKAGES.map((name) =>
  name.replaceAll('/', '\\/'),
).join('|');

const forbiddenDynamicImportSelectors = [
  {
    selector: `ImportExpression[source.type='Literal'][source.value=/^(${forbiddenDynamicImportAlternation})($|\\/)/]`,
    message: `${forbiddenWebPackageMessage} (dynamic import())`,
  },
  {
    selector: "ImportExpression:not([source.type='Literal'])",
    message: `${forbiddenWebPackageMessage} A dynamic import() here must use a plain string literal so the boundary can be checked statically.`,
  },
];

/**
 * The package ban, applied to every file in apps/web.
 *
 * `languageOptions.parser` is set directly, with no `project`, so this profile
 * works standalone rather than depending on being composed after
 * `typeChecked()` — which is exactly what test/eslint.web-boundaries.config.js
 * exercises. Composed after `typeChecked()` in the real app, flat config merges
 * `languageOptions` per key, so `parserOptions.project` survives untouched
 * because this object never sets `parserOptions`. Same reasoning as
 * `contractsBoundary`.
 *
 * Annotated, unlike the three boundaries above it. `test/web-boundaries.test.ts`
 * imports this profile as a MODULE and hands it to `new ESLint({ overrideConfig })`,
 * where the older fixtures hand ESLint a config path and never type it. Without
 * the annotation TS widens `['error', ...selectors]` to an array rather than a
 * tuple, and the call site is a TS2322 about `[Severity, ...unknown[]]` that says
 * nothing about what is actually wrong. The alternative — `config as never` at
 * the call site, as test/react.test.ts does — would silence any future genuine
 * shape error along with it.
 */
/** @type {import('eslint').Linter.Config[]} */
export const webBoundary = [
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: { parser: tseslint.parser },
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: forbiddenWebPackagePaths, patterns: forbiddenWebPackagePatterns },
      ],
      'no-restricted-syntax': ['error', ...forbiddenDynamicImportSelectors],
    },
  },
];

/**
 * ADR-0015 closes the list of Server Action uses at three — cookie and session
 * mutations, the SSE relay, and Vercel-side form posts — and names the
 * enforcement: "a lint rule flags `'use server'` outside
 * `apps/web/src/app/**\/actions.ts` and `apps/web/src/lib/session/**`". These
 * two globs are that sentence; they are not a stylistic choice and widening
 * them is an ADR change, not a config change.
 *
 * Scoped by NOT MATCHING the sanctioned paths rather than by turning the rule
 * off inside them. The distinction is load-bearing: `rules: {
 * 'no-restricted-syntax': 'off' }` would take the dynamic-import ban down with
 * it, in the one kind of file that runs on the server and can reach the
 * database. Not matching hands the rule back to `webBoundary` intact.
 */
/** @type {import('eslint').Linter.Config[]} */
export const serverActionBoundary = [
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['src/app/**/actions.ts', 'src/lib/session/**'],
    languageOptions: { parser: tseslint.parser },
    rules: {
      'no-restricted-syntax': [
        'error',
        // Carried from `webBoundary` because this entry replaces its options
        // for every file this profile matches. See the block comment above.
        ...forbiddenDynamicImportSelectors,
        {
          // The directive as the parser sees it: a string-literal
          // ExpressionStatement. Matching the Literal rather than the statement
          // reports at the directive itself, and catches the inline
          // function-body form as well as the file-level one — both create a
          // Server Action.
          selector: "ExpressionStatement > Literal[value='use server']",
          message:
            'Server Actions are limited to src/app/**/actions.ts and src/lib/session/** — domain mutations go through the API. See ADR-0015.',
        },
      ],
    },
  },
];

/**
 * ARCHITECTURE.md §8: a feature owns its components, hooks, schemas and
 * presentation logic, and cross-feature imports go through the feature's
 * `index.ts`. Without this, `features/` is a directory naming convention rather
 * than a boundary, and the first deep import into a neighbour's internals is
 * the one that makes the next twenty look normal.
 *
 * The regex matches a path that lands in a feature's internals
 * (`<feature>/components|hooks|schemas|lib/`) by either of the two spellings
 * this app can write: a relative path that climbs OUT of the current feature
 * (one or more `../`, optionally back down through `features/`), or the `@/`
 * alias `apps/web` declares in both `tsconfig.json` and `vitest.config.ts` and
 * already uses for `@/lib/cn`. Deliberately not a blanket ban on `../`:
 * `import { QuoteCard } from '../../quotes'` is the public surface and must stay
 * legal, and neither is a same-feature deep import like `../hooks/use-model`.
 * Both are asserted, because a boundary that also rejects legitimate imports
 * gets disabled within a week.
 *
 * THE ALIAS BRANCH COSTS ONE LEGITIMATE SPELLING, and it is stated here rather
 * than discovered: `no-restricted-imports` sees the specifier and never the
 * importing file, so `@/features/models/hooks/use-model` is indistinguishable
 * from `@/features/quotes/hooks/use-quote` — the rule cannot tell whose feature
 * `models` is. It therefore bans the alias into ANY feature's internals,
 * including your own, and the sanctioned form for reaching your own internals is
 * the relative one the `accepts` fixtures cover. That is a spelling requirement
 * with a legal alternative one character shorter, not a blocked import; the
 * message says so. The alternative — leaving the alias unmatched — was measured
 * and is worse: `@/features/beta/components/Thing` and
 * `../../../features/beta/components/Thing` both linted clean while
 * `../../beta/components/Thing` was reported, so the zone was enforced against
 * one notation of three.
 *
 * `@/` is anchored with `^` and requires the literal `features/` segment, so
 * `@/lib/cn`, `@/config/env` and `@/features/quotes` (the public surface) are
 * untouched. Without the anchor and the segment, a hypothetical
 * `@/hooks/components/x` would be reported by a rule that has no business
 * looking at it.
 *
 * Two details in the relative branch, both MEASURED against the path shapes in
 * test/web-boundaries.test.ts rather than reasoned about:
 *
 * `(\.\./)+` and not `\.\./\.\./`. The depth of the climb is a function of where
 * the IMPORTING file sits, not of how far away the target is: the public surface
 * of a feature is `index.ts` at the feature ROOT, so `src/features/models/index.ts`
 * reaching `../quotes/components/QuoteCard` needs exactly one `../`. A pattern
 * requiring two catches every deep caller and misses the one file every other
 * feature imports through — enforced-looking and unenforced.
 *
 * `(?!\.\.)` and not a bare `[^/]+`. `[^/]+` happily matches `..`, so with
 * backtracking `../../hooks/use-model` parses as
 * `../` + `..` + `/hooks/` — a FALSE POSITIVE on a same-feature deep import from
 * a nested component directory. (The two-`../` form had the same bug one level
 * further down, on `../../../hooks/use-model`.) The lookahead pins the segment
 * after the climb to a real directory name.
 *
 * `(?:features/)?` on the relative branch closes the third notation: a file deep
 * enough to climb past `src/features/` writes
 * `../../../features/quotes/components/QuoteCard`, where the segment after the
 * climb is `features` rather than the feature name. Optional, because the
 * shorter climbs do not pass through it.
 */
/** @type {import('eslint').Linter.Config[]} */
export const featureBoundary = [
  {
    files: ['src/features/**/*.ts', 'src/features/**/*.tsx'],
    languageOptions: { parser: tseslint.parser },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          // `paths` and the package `group` are carried from `webBoundary`
          // because this entry replaces its options for everything under
          // src/features/** — which is where nearly all of the app eventually
          // lives. See the block comment above.
          paths: forbiddenWebPackagePaths,
          patterns: [
            ...forbiddenWebPackagePatterns,
            {
              regex:
                '(?:^@/features/|(?:\\.\\./)+(?:features/)?)(?!\\.\\.)[^/]+/(?:components|hooks|schemas|lib)/',
              message:
                "Import another feature through its index.ts, not into its internals; reach your OWN feature's internals with a relative path rather than the @/ alias, which cannot be told apart from a neighbour's — see docs/ARCHITECTURE.md §8.",
            },
          ],
        },
      ],
    },
  },
];
