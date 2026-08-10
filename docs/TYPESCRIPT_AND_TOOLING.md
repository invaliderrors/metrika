# Metrika — TypeScript, ESLint & Tooling

> The type system and lint gates are the safety net that substitutes for code review on a solo-plus-agents team. They are deliberately stricter than a typical project.

---

## 1. TypeScript configuration

`packages/typescript-config/base.json`:

```jsonc
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",

    "strict": true,

    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true,
    "useUnknownInCatchVariables": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitReturns": true,
    "allowUnreachableCode": false,
    "allowUnusedLabels": false,

    "noUnusedLocals": false,        // ← ESLint instead; see below
    "noUnusedParameters": false,    // ← ESLint instead; see below

    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,

    "composite": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "incremental": true
  }
}
```

**TypeScript is pinned to 6.0.3, not the newest release.** `typescript-eslint@8.66.0` declares `peerDependencies.typescript: ">=4.8.4 <6.1.0"`, and npm currently tags TypeScript **7.0.2** (the Go-ported native compiler) as `latest` — which falls outside that range. Installing `latest` would silently disable every type-aware lint rule (`no-unsafe-*`, `no-floating-promises`, `switch-exhaustiveness-check`), and type-aware linting is this project's substitute for human code review on a solo-plus-agents team. 6.0.3 is the newest release inside typescript-eslint's supported range, so that is what is pinned. TS 6 makes `strict` default, defaults `types` to `[]` (which is why `node.json` lists `["node"]` explicitly), and removes the ES5/AMD/UMD/SystemJS targets, `--moduleResolution node`, `baseUrl` and `outFile` — none of which affect `base.json`, since it sets `module`/`moduleResolution` to `NodeNext` and `target` to `ES2023` explicitly. **Fallback: 5.9.3**, if a later phase finds Prisma, Nest or Next incompatible with 6.x.

### Every flag, and why

| Flag                                    | Decision                     | Reasoning                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `strict`                                | **on**                       | Baseline. Non-negotiable                                                                                                                                                                                                                                                                                                     |
| `noUncheckedIndexedAccess`              | **on**                       | The highest-value flag on this list. `arr[0]` becomes `T \| undefined`, which is the truth. Catches a real bug class around slice metrics arrays, trace lines and parsed CLI output. Friction is real; mitigate with `.at()`, destructuring and `for...of`                                                                   |
| `exactOptionalPropertyTypes`            | **on**                       | Distinguishes "absent" from "present and undefined" — meaningful for partial updates, where `{ name: undefined }` and `{}` must not mean the same thing. **Costs real friction with Prisma**, whose generated types do not model the distinction. Confined to `infrastructure/persistence` with the documented pattern below |
| `noImplicitOverride`                    | **on**                       | Cheap; prevents a silently-shadowed base method                                                                                                                                                                                                                                                                              |
| `noPropertyAccessFromIndexSignature`    | **on**                       | Forces `env['KEY']`, which is correct — and irrelevant in practice because raw `process.env` is banned everywhere but two files                                                                                                                                                                                              |
| `useUnknownInCatchVariables`            | **on**                       | Implied by `strict`; stated explicitly so it survives a future config edit                                                                                                                                                                                                                                                   |
| `noFallthroughCasesInSwitch`            | **on**                       | Pairs with `switch-exhaustiveness-check` on the discriminated unions this codebase is full of                                                                                                                                                                                                                                |
| `noImplicitReturns`                     | **on**                       | Cheap correctness                                                                                                                                                                                                                                                                                                            |
| `noUnusedLocals` / `noUnusedParameters` | **off in tsc, on in ESLint** | `tsc` errors on a variable you are halfway through using, which makes editing hostile and trains people to ignore red squiggles. ESLint autofixes and honours the `_` prefix for intentionally-unused parameters — which matters for interface implementations                                                               |
| `verbatimModuleSyntax`                  | **on**                       | Import elision becomes explicit; required for correct `import type` behaviour with decorators and for fast transpile-only builds                                                                                                                                                                                             |
| `isolatedModules`                       | **on**                       | Required by SWC/esbuild; prevents constructs that cannot be transpiled file-by-file                                                                                                                                                                                                                                          |
| `skipLibCheck`                          | **on**                       | Pragmatic. Third-party `.d.ts` errors are not actionable and block builds for no benefit                                                                                                                                                                                                                                     |
| `composite` / `declaration`             | **on**                       | Required for project references                                                                                                                                                                                                                                                                                              |

`moduleResolution` is `bundler` in `apps/web` (Next requirement) and `NodeNext` everywhere else.

### The `exactOptionalPropertyTypes` + Prisma pattern

The one place this flag hurts. The pattern, documented once and confined to the persistence layer:

```ts
// apps/api/src/infrastructure/persistence/model-version.repository.ts
const data: Prisma.ModelVersionUpdateInput = {
  state: next,
  ...(failureCode !== undefined && { failureCode }),        // conditional spread, not `failureCode`
  ...(failureDetail !== undefined && { failureDetail }),
};
```

Verbose, but it makes "do not touch this column" and "set this column to null" structurally different — which is exactly the distinction the flag exists to preserve, and exactly the distinction that silently corrupts data when it is lost.

---

## 2. Type discipline

### `any` is banned. Full stop.

Not "discouraged". `@typescript-eslint/no-explicit-any` is an error, the six `no-unsafe-*` rules are errors, and there is no approved exception. External data is `unknown` and is parsed:

```ts
// wrong
const payload = JSON.parse(body) as WebhookPayload;

// right
const parsed = WebhookPayload.safeParse(JSON.parse(body));
if (!parsed.success) return err({ code: 'VALIDATION_FAILED', issues: parsed.error.issues });
const payload = parsed.data;   // typed, and true
```

### Branded types

Defined once via Zod, in `packages/contracts`. `brandedUuid` validates against an explicit
regex rather than Zod's own `.uuid()`, deliberately: the schema uses UUIDv7 for
time-sortable primary keys, and Zod majors have differed on which UUID versions
`.uuid()` accepts. The regex accepts variants 1–8 (RFC 9562, which includes v7) and
rejects the nil UUID, which is never a valid identifier here:

```ts
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function brandedUuid<B extends string>(brand: B) {
  return z.string().regex(UUID_PATTERN, `must be a UUID (${brand})`).brand<B>();
}

export const UserId          = brandedUuid('UserId');
export const OrganizationId  = brandedUuid('OrganizationId');
export const ProjectId       = brandedUuid('ProjectId');
export const ModelId         = brandedUuid('ModelId');
export const ModelVersionId  = brandedUuid('ModelVersionId');
export const QuoteId         = brandedUuid('QuoteId');
export const OrderId         = brandedUuid('OrderId');
export const SliceJobId      = brandedUuid('SliceJobId');
export const PrintJobId      = brandedUuid('PrintJobId');
export const MaterialId      = brandedUuid('MaterialId');
export const PrinterProfileVersionId = brandedUuid('PrinterProfileVersionId');
export type  UserId = z.infer<typeof UserId>;   // ...etc

export const Millimeters       = z.number().finite().brand<'Millimeters'>();
export const CubicMillimeters  = z.number().nonnegative().finite().brand<'CubicMillimeters'>();
export const Grams             = z.number().nonnegative().finite().brand<'Grams'>();
export const Seconds           = z.number().nonnegative().finite().brand<'Seconds'>();
export const MinorUnits        = z.bigint().brand<'MinorUnits'>();
```

**Where branding is applied:** every entity ID, and the five physical quantities that flow into money. **Where it is not:** ordinary strings, emails, names, arbitrary numbers. Branding everything requires a units algebra (`add`, `mul`, `div` for every pair) and produces friction well beyond its value. Branding IDs and money-adjacent quantities catches the two mix-ups that actually cause damage: passing a `ProjectId` where a `ModelId` belongs, and passing grams where cubic millimetres belong.

Database strings become branded IDs at exactly one place:

```ts
// apps/api/src/infrastructure/persistence/branding.ts
// Lint-restricted: importable only from infrastructure/persistence/**
export function brandUnsafe<T extends string>(value: string): T {
  return value as T;
}
```

Parsing every ID out of the database would be wasteful. One named, lint-restricted, deliberately unattractive assertion in the mapping layer is the honest trade — and it is named `brandUnsafe` so nobody reaches for it casually.

### Discriminated unions and exhaustiveness

```ts
export function assertNever(value: never, context: string): never {
  throw new Error(`Unhandled case in ${context}: ${JSON.stringify(value)}`);
}

switch (fit.kind) {
  case 'FITS':                   return renderFits(fit);
  case 'FITS_ROTATED':           return renderRotated(fit);
  case 'REQUIRES_SEGMENTATION':  return renderSegmentation(fit);
  case 'EXCEEDS_ALL_PRINTERS':   return renderTooLarge(fit);
  default:                       return assertNever(fit, 'FitResult');
}
```

`switch-exhaustiveness-check` makes adding a union member a compile error at every site that must handle it. This is how the state machines, the fit results, the pricing components and the error codes stay correct as they grow.

### Typed errors, not exceptions, for expected failures

```ts
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
```

Used in the pure kernels (`pricing-engine`, policies, state transitions) where failures are expected, enumerable and part of the contract. NestJS services throw typed domain exceptions for transport-mapped failures — the exception filter is the one place that translates them. Both patterns coexist deliberately: `Result` where a caller must handle every case, exceptions where the failure propagates to the transport boundary unchanged.

---

## 3. ESLint

Flat config. `packages/eslint-config` exports composable profiles:

```js
// packages/eslint-config/src/index.js
export { base } from './base.js';
export { typeChecked } from './type-checked.js';
export { nest } from './nest.js';
export { react } from './react.js';
export { next } from './next.js';
export { test } from './test.js';
export {
  contractsBoundary,
  featureBoundary,
  prismaBoundary,
  prismaImportBoundary,
  rawSqlBan,
  serverActionBoundary,
  webBoundary,
} from './boundaries.js';
```

The package is JavaScript with JSDoc types, not TypeScript — a config package that had to be built before it could lint anything would have to be built before `pnpm lint` could run, which is a bootstrap problem with no upside.

The boundaries are **seven named exports, not one `boundaries` profile**, and that is deliberate: a consumer composes exactly the zones its own layout has. `prismaBoundary` is the two-half composition `apps/api` uses (`prismaImportBoundary` + `rawSqlBan`); `packages/database` needs the raw-SQL half without the import half, and reaching for it as `prismaBoundary.slice(1)` is precisely the silent swap the split exists to prevent. `webBoundary`, `serverActionBoundary` and `featureBoundary` are `apps/web`'s three zones and are composed in that order — see the block comment above `webBoundary` in `src/boundaries.js` for why the order is load-bearing.

A `workflows` profile (Temporal determinism, per the rule in CLAUDE.md) is **target state** and arrives with `apps/api/src/workflows`. There is no `script` profile.

### Type-checked rules

```js
'@typescript-eslint/no-explicit-any': 'error',
'@typescript-eslint/no-unsafe-assignment': 'error',
'@typescript-eslint/no-unsafe-argument': 'error',
'@typescript-eslint/no-unsafe-call': 'error',
'@typescript-eslint/no-unsafe-member-access': 'error',
'@typescript-eslint/no-unsafe-return': 'error',
'@typescript-eslint/no-floating-promises': 'error',
'@typescript-eslint/no-misused-promises': 'error',
'@typescript-eslint/await-thenable': 'error',
'@typescript-eslint/switch-exhaustiveness-check': 'error',
'@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
'@typescript-eslint/consistent-type-exports': 'error',
'@typescript-eslint/prefer-nullish-coalescing': 'error',
'@typescript-eslint/prefer-optional-chain': 'error',
'@typescript-eslint/no-unnecessary-condition': 'error',
'@typescript-eslint/no-unnecessary-type-assertion': 'error',
'@typescript-eslint/no-non-null-assertion': 'error',
'@typescript-eslint/promise-function-async': 'error',
'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],

'@typescript-eslint/strict-boolean-expressions': ['error', {
  allowNullableBoolean: true,
  allowNullableString: true,
  allowNullableObject: true,
  allowNumber: false,
  allowString: false,
}],

'@typescript-eslint/require-await': 'off',
'@typescript-eslint/explicit-function-return-type': 'off',
'@typescript-eslint/explicit-module-boundary-types': 'off',   // 'error' in packages/* only
```

### The three exceptions, explained rather than hidden

**`strict-boolean-expressions` relaxed.** Full strictness forbids `if (nullableBoolean)` and `if (nullableString)`, requiring `=== true` and `!== undefined && !== ''` everywhere. Once `noUncheckedIndexedAccess` and `no-unnecessary-condition` are on, the additional bugs caught are close to zero, and the friction is substantial. `allowNumber` and `allowString` stay `false` because `if (count)` genuinely is a bug when `count` can be `0`, and `if (str)` genuinely is a bug when `''` is valid — those are the cases worth keeping.

**`require-await` off.** It conflicts with `promise-function-async` and forces meaningless `await Promise.resolve()` in async interface implementations that happen not to await — which is common in adapter implementations satisfying a port. `no-floating-promises` and `await-thenable` catch the bugs that matter.

**`explicit-module-boundary-types` on in packages, off in apps.** A package's public API benefits from explicit return types: inference leaks internal types across a boundary and makes accidental breaking changes invisible. Inside an application, explicit return types are noise that inference handles better and that goes stale.

### Boundary enforcement

A boundary is a profile a package opts into, and its scoping is the flat-config `files`/`ignores` inside the profile itself. There is no central map of zones: `no-restricted-imports` has no such option, and the globs in a profile are resolved relative to the `eslint.config.js` that spreads it. A package whose layout differs composes its own `ignores` rather than widening a shared one.

```js
// packages/eslint-config/src/boundaries.js — contractsBoundary, abridged
'no-restricted-imports': ['error', { patterns: [{
  // Anything that is not exactly "zod" and not a relative path. A `group: ['*']`
  // would also match relative imports and forbid the package importing itself.
  regex: '^(?!zod$|\\.{1,2}/).*',
  message: 'packages/contracts may import only "zod" and relative modules — see docs/ARCHITECTURE.md §7',
}]}],
```

| Export                 | Composed by                     | Forbids                                                                                                                                                       |
| ---------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contractsBoundary`    | `packages/contracts`            | anything but `zod` and relative modules — statically, dynamically (`import()`, including the template-literal form), and the Node globals that need no import |
| `prismaImportBoundary` | `apps/api`                      | `@prisma/client` and `@metrika/database`, bare and by subpath, outside `src/infrastructure/persistence/**` — ADR-0005                                         |
| `rawSqlBan`            | `apps/api`, `packages/database` | `$queryRawUnsafe` / `$executeRawUnsafe` — everywhere, persistence included, because neither parameterises                                                     |
| `prismaBoundary`       | `apps/api`                      | both of the two above, in that composition                                                                                                                    |
| `webBoundary`          | `apps/web`                      | `@metrika/database`, `@metrika/pricing-engine`, `@prisma/client` — bare, by subpath and dynamically                                                           |
| `serverActionBoundary` | `apps/web`                      | `'use server'` outside `src/app/**/actions.ts` and `src/lib/session/**` — ADR-0015                                                                            |
| `featureBoundary`      | `apps/web`                      | reaching into another feature's `components`/`hooks`/`schemas`/`lib` instead of through its `index.ts`                                                        |

The `process.env` ban is not a boundary profile; it is in `base`, so every package composing `base` (directly, or through `typeChecked()` and `nest()`) gets it, and the two sanctioned readers exempt themselves file by file in their own configs:

```js
// packages/eslint-config/src/base.js
'no-restricted-properties': ['error',
  { object: 'process', property: 'env',
    message: 'Read configuration from config/env.ts only' }],
```

`next()` is the one profile that does not start from `base` — it composes `react()`, which starts from `js.configs.recommended` — so `apps/web` composes `typeChecked()` after it to get the ban back along with the type-aware set. That is measured and documented in `src/next.js`; composing `next()` alone resolves 55 fewer rules than `nest()` does, this one among them.

The React and accessibility rules come from `eslint-plugin-react`, `eslint-plugin-react-hooks` and `eslint-plugin-jsx-a11y`, reached through `eslint-config-next`'s own plugin registrations rather than registered a second time — ESLint 10 rejects two non-identical registrations of one plugin name, and `src/next.js` carries the full reasoning. There is no import-ordering plugin and no Vitest plugin yet; `src/test.js` is where the latter will go.

### Suppression policy

Every suppression must carry a justification, enforced mechanically:

```ts
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Three.js GLTF result is untyped upstream; validated on the next line
```

`--report-unused-disable-directives` is on, and a CI script fails on any `eslint-disable` or `@ts-expect-error` without a `--` justification. `@ts-ignore` is banned outright — `@ts-expect-error` at least fails when the underlying error disappears.

There is no warning tier; a rule is either worth enforcing or it is off. `--max-warnings=0` lives in the root `lint` script, and CI's `Lint` step is a bare `pnpm lint`, so the local gate and the CI gate are the same command — see §7, which also explains why that script is now two `turbo run lint` invocations rather than one (the flag is an ESLint flag, and `ruff` exits 2 on it).

---

## 4. Prettier

Prettier owns formatting entirely. No ESLint formatting rules; `eslint-config-prettier` last in the chain.

```jsonc
{
  "semi": true, "singleQuote": true, "trailingComma": "all",
  "printWidth": 100, "tabWidth": 2, "arrowParens": "always",
  "plugins": ["prettier-plugin-tailwindcss"]
}
```

The version is pinned **exactly** (not `^`), because a Prettier patch release that changes output turns an unrelated pull request into a thousand-line diff.

**This applies to every dependency in the workspace, and it is enforced rather than asked for.** `packages/typescript-config/test/dependency-pins.test.ts` walks every manifest named by `pnpm-workspace.yaml`'s globs plus the root, and fails on a caret, a tilde, a range, `*` or a dist-tag such as `latest`. `workspace:` and `catalog:` protocols are allowed; `peerDependencies` are excluded, because a peer range is a compatibility statement rather than an install instruction. An unrecognised glob shape throws instead of being skipped, so the gate cannot silently stop covering a package.

The reason it is a test and not a convention: this repository has twice shipped a version outside a peer range and lost a whole class of checking silently — `typescript-eslint`'s type-aware rules once, and `eslint-plugin-react`'s under ESLint 10. A range is how that happens without anyone choosing it.

Python: `ruff format` + `ruff check` with an equivalently strict rule set, and `mypy --strict` on `apps/workers`. The Python side gets the same treatment as TypeScript — an untyped worker is exactly as capable of producing a wrong price. Both live in `apps/workers/pyproject.toml`: ruff selects `E F I N UP B A C4 SIM ARG PTH RUF ASYNC S PGH DTZ T20` (the Node side runs typescript-eslint's strict and stylistic sets plus type-aware rules; this is the closest equivalent ruff offers), and `[tool.mypy]` carries `strict`, `warn_unreachable`, `disallow_any_explicit` and `enable_error_code = ["ignore-without-code"]`. `disallow_any_explicit` is the Python half of "no `any`, no exceptions", since `strict` alone still permits a hand-written one.

**Suppressions are gated on both sides, and the Python shape is not the TypeScript shape.** The last three ruff rule sets are each a Node-side rule this repository already enforces: `T20` is `no-console`, `DTZ` is the timezone rule ADR-0027 asked for, and `PGH` is the suppression half — measured, a first-line `# type: ignore` makes mypy skip the **entire file** at exit 0 (`ignore-without-code` does not see it; ruff's `PGH003` does). CI's two suppression steps now include `*.py`: a `noqa` or `type: ignore` needs a `-- <justification>` like every `eslint-disable`, and `# mypy: ignore-errors` is banned outright beside `@ts-ignore`, because it silences a file and neither tool can be made to report it. The justification goes in a **second comment** — `# type: ignore[return-value]  # -- why` — because the inline form makes mypy report `Invalid "type: ignore" comment` and suppress nothing, which is a rule that would quietly un-suppress what it was written to allow.

**And the pin gate covers `pyproject.toml` too.** `uv add` writes `>=` ranges rather than pins, so the same test walks every `pyproject.toml` in the repository — `[project] dependencies`, `[project.optional-dependencies]`, `[dependency-groups]`, `[tool.uv] dev-dependencies` and `[build-system] requires` — and fails on `>=`, `~=`, `!=`, a wildcard, a comma-joined range or a bare name. Two exemptions, both deliberate: `[project] requires-python`, because it is the interpreter range and `==3.12.*` is its correct shape, and a name carrying `[tool.uv.sources] <name> = { workspace = true }` **in the same file**, which is the uv analogue of `workspace:*` and is bare by design because the version comes from the member. `{ git = … }`, `{ path = … }` and `{ url = … }` sources are not exempt. Two non-vacuity tests guard the small TOML reader, for the reason the YAML one is guarded: a reader that quietly matches nothing is indistinguishable from a repository with nothing to check. A third asserts every member package on disk appears in `uv.lock`'s `[manifest] members`, because a member the globs do not match is silently not a member and `uv lock --check` is content either way.

**`uv.lock` is enforced, not asserted.** Every script in `apps/workers/package.json` runs `uv run --locked --all-packages`, and `tests/test_toolchain.py` runs `uv lock --check`. Measured, and the reason both exist: after an edit to `pyproject.toml`, a bare `uv run` **re-locks and exits 0** — the Python-side twin of a lockfile-less `pnpm install`, and precisely what ADR-0027 obligation 1 is about. `--locked` exits 2 instead; `--frozen` is weaker, declining to update the lockfile without checking whether it still matches. `--all-packages` is what installs workspace members, without which `mypy` reports `import-not-found` on the workspace's own sources.

---

## 5. Package builds

Internal packages are **source-only, unless `apps/api` depends on them at runtime** — see [ADR-0020](./adr/0020-internal-package-build-output.md), which supersedes the source-only paragraph of [ADR-0001](./adr/0001-monorepo-strategy.md). `apps/api` compiles to `dist/main.js` and runs it with a plain `node` process; a bare-specifier import into that compiled output cannot resolve `.ts` source, so a package it depends on at runtime is built and exposed through a conditional `exports` map instead:

```jsonc
{
  "name": "@metrika/contracts",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./package.json": "./package.json"
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -b tsconfig.build.json",
    "typecheck": "tsc -b"
  }
}
```

- `apps/api` resolves it exactly as it would resolve a published npm package — through `main`/`types`/`exports` pointing at compiled JavaScript — because that is the only resolution mode a bare-specifier import into already-compiled Node output supports.
- `apps/web` resolves it the same way, and that is a correction to what [ADR-0020](./adr/0020-internal-package-build-output.md) expected. The ADR assumed Next would keep reading `.ts` source through `transpilePackages`; `apps/web` as built sets none, and `vitest.config.ts` aliases only `@/*`, so both go through the `exports` map above and both need `dist/`. MEASURED on a clean clone with `packages/contracts` unbuilt: `next build` compiles and then fails its TypeScript phase with `src/lib/formatting/money.ts(1,38): error TS2307: Cannot find module '@metrika/contracts'`. Turbo's `dependsOn: ["^build", …]` on `build`, `typecheck`, `lint` and `test:unit` is what keeps the inner loop working anyway; the cost is that `apps/web` no longer has a zero-build inner loop for a contracts edit — `pnpm build` has to have run once.
- `typecheck` (`tsc -b` over `tsconfig.json`, never emits) and `build` (`tsc -b tsconfig.build.json`, emits to `dist/`) are separate scripts and separate Turbo tasks, so the emitting half is cached and ordered independently. `build`'s Turbo output names `tsconfig.build.tsbuildinfo` exactly, never a `*.tsbuildinfo` glob — a glob would let a `build` cache hit also restore a stale `typecheck` state file and cause `tsc -b` to skip checking silently.
- Packages with no runtime consumer that executes compiled Node output — `packages/eslint-config`, `packages/typescript-config`, and any future package only `apps/web`/Vitest import — declare no `build` script and stay exactly as ADR-0001 originally described; Turbo skips the (nonexistent) task for them without erroring.

This keeps the inner loop free of a build step everywhere it safely can: editing a source-only package is immediately visible with no watch-mode build. Where a build step is unavoidable, it is Turbo-cached, so an unchanged package costs nothing on a warm cache.

`exports` still deliberately lists only intended entry points — `"./dist/index.js"`, not a directory — which enforces the public API at the module-resolution level rather than by convention. `"./package.json"` is exported explicitly on every built package: once `"."` is declared, an `exports` map is a closed allow-list, and without this entry `require.resolve('@metrika/contracts/package.json')` — the normal way a test harness locates a workspace package's own directory for fixtures — fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

---

## 6. Runtime versions

```
.nvmrc            24.x  (pinned to the exact LTS patch)
.python-version   3.12.x   (root, and again in apps/workers — uv reads the nearest one)
mise.toml         node = "24", python = "3.12", uv = "0.12.3"
package.json      "packageManager": "pnpm@x.y.z", "engines": { "node": ">=24 <25" }
```

**`uv` is the one exact version in `mise.toml`, and the asymmetry is deliberate.** `node` and `python` float their major there because the exact patch lives in a file the ecosystem's own tools already read; `uv` has no companion file, so the version is carried in `mise.toml` or nowhere. "Nowhere" is what [ADR-0027](./adr/0027-python-toolchain.md)'s spike actually found — `uv` reachable only through a global `~/.config/mise/config.toml` at `latest`, an unpinned per-machine version no checkout reproduces. CI installs the same version through `astral-sh/setup-uv` and needs no `actions/setup-python` step at all: `uv` provisions its own CPython from `.python-version`.

**Node is pinned to 24 (Krypton), not 22.** Resolved from nodejs.org's release schedule: v24 is **Active LTS**, v22 has moved to **Maintenance LTS**, and v26 is **Current** — production must not run a Current release. Revisit this pin once v26 reaches Active LTS.

`engines.node` alone is advisory under pnpm: `pnpm install` on a mismatched Node major only warns (`[WARN] Unsupported engine`) and exits 0. `.npmrc`'s `engine-strict=true` does not change that under pnpm 11.20.0 — it binds for npm, not pnpm. The check that actually fails an install on the wrong Node version is `scripts/check-node-version.mjs`, wired as the root `preinstall` script; it reads the required major straight out of `.nvmrc` so there is exactly one place to bump.

**mise** is the recommended version manager — it handles Node and Python from one `mise.toml`, which matters in a polyglot repository where nvm plus pyenv means two tools and two failure modes. `.nvmrc` and `.python-version` are committed anyway so nvm and pyenv users are not excluded.

CI reads the same files. A version mismatch between local and CI is not a debugging session anyone should have.

---

## 7. Root scripts

The root manifest, as it stands:

```jsonc
{
  "preinstall": "node scripts/check-node-version.mjs",
  "build": "node --env-file-if-exists=.env scripts/turbo.mjs run build",
  "dev": "node --env-file-if-exists=.env scripts/turbo.mjs run dev",
  "lint": "turbo run lint --filter=!@metrika/workers -- --max-warnings=0 && turbo run lint --filter=@metrika/workers",
  "lint:fix": "turbo run lint -- --fix",
  "typecheck": "turbo run typecheck",
  "test:unit": "node --env-file-if-exists=.env scripts/turbo.mjs run test:unit",
  "test:integration": "node --env-file-if-exists=.env scripts/turbo.mjs run test:integration",
  "infra:up": "docker compose -f infra/docker/docker-compose.yml up -d --wait",
  "infra:down": "docker compose -f infra/docker/docker-compose.yml down",
  "infra:reset": "docker compose -f infra/docker/docker-compose.yml down -v",
  "db:generate": "node --env-file-if-exists=.env scripts/prisma.mjs generate",
  "db:migrate": "node --env-file-if-exists=.env scripts/prisma.mjs migrate dev",
  "db:deploy": "node --env-file-if-exists=.env scripts/prisma.mjs migrate deploy",
  "db:reset": "node --env-file-if-exists=.env scripts/prisma.mjs migrate reset --force",
  "db:studio": "node --env-file-if-exists=.env scripts/prisma.mjs studio",
  "format": "prettier --write . && turbo run format",
  "format:check": "prettier --check . && turbo run format:check",
  "verify": "pnpm format:check && pnpm build && pnpm lint && pnpm typecheck && pnpm test:unit",
  "ci": "pnpm verify",
}
```

Six of them are not the bare `turbo run <task>` they look like they should be, and each deviation is load-bearing:

- **`verify` runs `build`, as its second step.** It is not `format:check + lint + typecheck + test:unit`; anything describing it that way is out of date. `lint` and `typecheck` both `dependsOn: ["^build"]`, so a workspace dependency that does not compile has to fail as a build rather than as a confusing downstream type error — and `apps/web`'s `next build` is the only gate that sees a missing `NEXT_PUBLIC_` key, an unresolvable `@metrika/contracts` import, or a Tailwind sheet that emits nothing.
- **`build`, `dev`, `test:unit` and `test:integration` go through `scripts/turbo.mjs` under `node --env-file-if-exists=.env`.** `apps/web/src/app/layout.tsx` imports `clientEnv`, which parses `NEXT_PUBLIC_*` at module scope, and all four of those tasks schedule `@metrika/web#build`. Without the root `.env` loaded into the process they fail on a missing variable. The wrapper is `spawnSync` plus `process.exit(status ?? 1)`: it forwards its arguments unchanged and swallows nothing, including a signal-killed child. `--env-file-if-exists` cannot be passed to `next build` directly — Next propagates its exec argv into `NODE_OPTIONS` for its workers, and Node rejects the flag there.
- **`lint` carries `--max-warnings=0` itself.** CI's `Lint` step is a bare `pnpm lint`, so a developer's `pnpm verify` and CI run the identical command. The flag used to live only in the workflow, which made `pnpm verify` systematically weaker than CI: every warning-severity rule was invisible locally, and that bit twice during Plan 0B-2 alone. Two places to change is how the two drift apart.
- **`lint` is two `turbo run lint` invocations, split on `@metrika/workers`.** Turbo forwards everything after `--` to _every_ task it schedules, and `--max-warnings=0` is an ESLint flag: MEASURED, `uv run ruff check . --max-warnings=0` exits **2** with `unexpected argument '--max-warnings' found`, so a single invocation cannot cover both languages. The flag stays in the root script rather than moving into each package's own `lint` script — seven copies of it is seven chances to forget one, and a forgotten copy fails _silently_, by making warnings invisible in that package. `lint:fix` needs no split, because `--fix` is valid for `eslint` and `ruff` alike.
- **`format` and `format:check` are Prettier at the root _plus_ `turbo run format[:check]`.** Prettier owns every language it can parse and runs once over the whole tree; the turbo half exists for the languages it cannot, which today means `ruff format` in `apps/workers` and nothing else. It is a turbo task rather than `pnpm --filter @metrika/workers run format:check` for a measured reason: `pnpm --filter <no-match> run <script>` exits **0**, so a package rename would delete the Python half of `format:check` from `pnpm verify` in silence. `turbo run` exits **1** on a filter that matches nothing.
- **`db:*` go through `scripts/prisma.mjs`** rather than `pnpm --filter @metrika/database …`, for the same environment reason plus one more: they pass `--schema` explicitly, because a bare `pnpm exec prisma` inside `packages/database` cannot find `DATABASE_ADMIN_URL`. `db:reset` is the destructive one.

**Not yet created**, and named here so their absence is not mistaken for an omission: `test:e2e` (a package script only — `pnpm --filter @metrika/web test:e2e`; a root one would put a chromium download in everyone's inner loop), and `db:seed` and `contracts:emit` (Plan 0B-3). The `ruff` half of `format`/`format:check` used to be on this list and no longer is: `apps/workers` exists, and all five of `lint`, `typecheck`, `test:unit`, `format` and `format:check` reach it. There is no aggregate `test` script either; `test:unit` and `test:integration` are run by name, and only the second one needs Docker.

---

## 8. Git workflow

- **Conventional commits**, enforced by commitlint. Scopes match package names.
- **Branches:** `main` protected; work on `feat/*`, `fix/*`, `chore/*`; squash merge.
- **Changesets** for package versioning — meaningful because internal packages are versioned for changelog and release-note purposes even though they are not published.
- **CODEOWNERS** on `packages/pricing-engine`, `packages/contracts`, `apps/api/src/authorization`, `infra/` and every migration directory. On a solo team this is a self-imposed "stop and think" marker on the files where a mistake is expensive; it becomes real review as soon as there is a second engineer.
- **Pre-commit hooks are deliberately minimal**: `lint-staged` runs Prettier and ESLint on changed files, plus gitleaks and commitlint. Typecheck and tests run in CI, where they are parallel and cached. A slow pre-commit hook trains people to use `--no-verify`, which is strictly worse than no hook.
