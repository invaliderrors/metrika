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

```ts
// packages/eslint-config/src/index.ts
export { base } from './base.js';
export { typeChecked } from './type-checked.js';
export { react } from './react.js';
export { next } from './next.js';
export { nest } from './nest.js';
export { workflows } from './workflows.js';   // Temporal determinism
export { test } from './test.js';
export { script } from './script.js';
export { boundaries } from './boundaries.js';
```

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

```js
// packages/eslint-config/src/boundaries.ts
'no-restricted-imports': ['error', { zones: [
  { target: './packages/contracts/**',      from: './packages/!(contracts)/**',
    message: 'contracts is the root of the dependency graph and may import only zod' },
  { target: './packages/pricing-engine/**', from: ['@nestjs/*', '@prisma/client', 'node:*'],
    message: 'pricing-engine must stay pure — no framework, no I/O' },
  { target: './packages/ui/**',             from: ['./packages/api-client/**', './packages/database/**'],
    message: 'ui is a design system; feature components belong in apps/web/src/features' },
  { target: './apps/web/**',                from: ['./packages/database/**', './packages/pricing-engine/**'],
    message: 'no Prisma in the browser; prices are computed server-side only' },
  { target: './apps/api/src/!(infrastructure)/**', from: ['@prisma/client'],
    message: 'Prisma access goes through infrastructure/persistence' },
  { target: './apps/api/src/workflows/**',  from: ['@prisma/client', 'node:*', '**/infrastructure/**'],
    message: 'workflow code must be deterministic — do I/O in activities' },
]}],

'no-restricted-properties': ['error',
  { object: 'process', property: 'env',
    message: 'Read configuration from config/env.ts only' }],

'no-restricted-syntax': ['error',
  { selector: "CallExpression[callee.property.name='$queryRawUnsafe']",
    message: 'Use tagged-template $queryRaw' },
  { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message: 'Banned — XSS risk' },
],
```

Plus `eslint-plugin-import-x` for deterministic import ordering, `eslint-plugin-react-hooks`, `eslint-plugin-jsx-a11y`, and `eslint-plugin-vitest` in the test profile.

### Suppression policy

Every suppression must carry a justification, enforced mechanically:

```ts
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Three.js GLTF result is untyped upstream; validated on the next line
```

`--report-unused-disable-directives` is on, and a CI script fails on any `eslint-disable` or `@ts-expect-error` without a `--` justification. `@ts-ignore` is banned outright — `@ts-expect-error` at least fails when the underlying error disappears.

CI runs `eslint . --max-warnings=0`. There is no warning tier; a rule is either worth enforcing or it is off.

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

Python: `ruff format` + `ruff check` with an equivalently strict rule set, and `mypy --strict` on `apps/workers`. The Python side gets the same treatment as TypeScript — an untyped worker is exactly as capable of producing a wrong price.

---

## 5. Package builds

Internal packages are **source-only**:

```jsonc
{
  "name": "@metrika/contracts",
  "exports": { ".": "./src/index.ts", "./events": "./src/events/index.ts" },
  "scripts": { "typecheck": "tsc -b" }
}
```

- `apps/web` consumes them via `transpilePackages` in `next.config.ts`.
- `apps/api` compiles them through TypeScript project references (`tsc -b`), so production output includes them.
- Vitest resolves them natively through the workspace.

This removes an entire build step from the inner loop — editing `packages/contracts` is immediately visible everywhere with no watch-mode build. Correctness is preserved by the separate, Turbo-cached `typecheck` task, which must pass in CI.

`exports` deliberately lists only intended entry points. Deep imports into `src/internal/...` do not resolve, which enforces the public API at the module-resolution level rather than by convention.

---

## 6. Runtime versions

```
.nvmrc            24.x  (pinned to the exact LTS patch)
.python-version   3.12.x
package.json      "packageManager": "pnpm@x.y.z", "engines": { "node": ">=24 <25" }
```

**Node is pinned to 24 (Krypton), not 22.** Resolved from nodejs.org's release schedule: v24 is **Active LTS**, v22 has moved to **Maintenance LTS**, and v26 is **Current** — production must not run a Current release. Revisit this pin once v26 reaches Active LTS.

`engines.node` alone is advisory under pnpm: `pnpm install` on a mismatched Node major only warns (`[WARN] Unsupported engine`) and exits 0. `.npmrc`'s `engine-strict=true` does not change that under pnpm 11.20.0 — it binds for npm, not pnpm. The check that actually fails an install on the wrong Node version is `scripts/check-node-version.mjs`, wired as the root `preinstall` script; it reads the required major straight out of `.nvmrc` so there is exactly one place to bump.

**mise** is the recommended version manager — it handles Node and Python from one `mise.toml`, which matters in a polyglot repository where nvm plus pyenv means two tools and two failure modes. `.nvmrc` and `.python-version` are committed anyway so nvm and pyenv users are not excluded.

CI reads the same files. A version mismatch between local and CI is not a debugging session anyone should have.

---

## 7. Root scripts

```jsonc
{
  "dev": "turbo run dev",
  "build": "turbo run build",
  "lint": "turbo run lint",
  "lint:fix": "turbo run lint -- --fix",
  "format": "prettier --write . && ruff format apps/workers",
  "format:check": "prettier --check . && ruff format --check apps/workers",
  "typecheck": "turbo run typecheck",
  "test": "turbo run test:unit test:integration",
  "test:unit": "turbo run test:unit",
  "test:integration": "turbo run test:integration",
  "test:e2e": "turbo run test:e2e",
  "db:migrate": "pnpm --filter @metrika/database migrate:dev",
  "db:migrate:deploy": "pnpm --filter @metrika/database migrate:deploy",
  "db:generate": "pnpm --filter @metrika/database generate",
  "db:seed": "pnpm --filter @metrika/database seed",
  "db:reset": "pnpm --filter @metrika/database reset",
  "contracts:emit": "pnpm --filter @metrika/contracts emit:json-schema && pnpm --filter @metrika/contracts emit:pydantic",
  "verify": "pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:unit"
}
```

Every script does exactly what its name says. `db:reset` is the only destructive one and refuses to run when `NODE_ENV=production`. `pnpm verify` is the local pre-push gate and mirrors the CI fast path.

---

## 8. Git workflow

- **Conventional commits**, enforced by commitlint. Scopes match package names.
- **Branches:** `main` protected; work on `feat/*`, `fix/*`, `chore/*`; squash merge.
- **Changesets** for package versioning — meaningful because internal packages are versioned for changelog and release-note purposes even though they are not published.
- **CODEOWNERS** on `packages/pricing-engine`, `packages/contracts`, `apps/api/src/authorization`, `infra/` and every migration directory. On a solo team this is a self-imposed "stop and think" marker on the files where a mistake is expensive; it becomes real review as soon as there is a second engineer.
- **Pre-commit hooks are deliberately minimal**: `lint-staged` runs Prettier and ESLint on changed files, plus gitleaks and commitlint. Typecheck and tests run in CI, where they are parallel and cached. A slow pre-commit hook trains people to use `--no-verify`, which is strictly worse than no hook.
