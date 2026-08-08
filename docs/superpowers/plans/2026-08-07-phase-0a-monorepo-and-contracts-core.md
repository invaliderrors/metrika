# Phase 0A — Monorepo Foundations & Contracts Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the pnpm/Turborepo monorepo with working quality gates, and build `packages/contracts` core primitives — branded IDs, Money, physical units, Result, domain error codes, and canonical JSON hashing — fully tested.

**Architecture:** Three config packages (`typescript-config`, `eslint-config`, plus root Prettier) define the gates. `packages/contracts` is the root of the dependency graph and may import nothing but `zod`. Everything is source-only (`exports` → `./src/index.ts`); correctness comes from a Turbo-cached `typecheck` task, not from a build step. CI runs format → lint → typecheck → unit tests, all with zero tolerance.

**Tech Stack:** pnpm workspaces, Turborepo, TypeScript (strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`), ESLint 9 flat config with typescript-eslint type-aware rules, Prettier, Vitest, fast-check, Zod, GitHub Actions.

## Global Constraints

- **Node 24 (Krypton)** — pinned in `.nvmrc` and `engines`. Resolved from nodejs.org during pre-flight: v24 is **Active LTS**, v22 has moved to **Maintenance LTS** (so the blueprint's Node 22 is stale), and v26 is **Current**, which production must not run. The blueprint ([docs/TYPESCRIPT_AND_TOOLING.md §6](../../TYPESCRIPT_AND_TOOLING.md#6-runtime-versions)) is corrected to 24 in Task 12. Revisit when v26 reaches Active LTS (expected October 2026).
- This machine has **v26.5.0** installed; install 24 (`mise install node@24` or `nvm install 24`) before starting. `engines.node` is `>=24 <25` so a mismatch fails loudly rather than producing subtle differences from CI.
- **Python 3.12**, pinned in `.python-version`. ⚠️ This machine has **3.9.6**, which is too old. Not needed for Plan 0A, but install before Plan 0B (`mise install python@3.12`).
- **No `any`.** `@typescript-eslint/no-explicit-any` and all six `no-unsafe-*` rules are errors with no exceptions.
- **`packages/contracts` may import nothing but `zod`.** No Node built-ins, no framework, no React. Enforced by a lint zone in Task 10.
- **CI runs `eslint --max-warnings=0`.** There is no warning tier.
- **Money is `bigint` minor units + currency + explicit exponent.** Never `number`, never `Float`.
- **`noUnusedLocals`/`noUnusedParameters` are `false` in tsconfig**; unused variables are an ESLint error with `^_` ignore patterns instead.
- **Every physical quantity carries its unit in its name** (`lengthMm`, `massG`, `volumeMm3`, `durationS`).
- **Commit conventions:** conventional commits scoped by package; **no `Co-Authored-By` or other AI attribution in commit messages**; commit every change, never leave the tree dirty.
- Tool versions are pinned **exactly** (`-E` on install), not with `^`.
- All source is ESM (`"type": "module"`).

**Deferred out of this plan, deliberately** — each maps to a ROADMAP Phase 0 deliverable that lands in a later plan:

| Deferred | Why | Lands in |
|---|---|---|
| ts-rest spike (0.15) | The primitives here are plain Zod and unaffected by the outcome. The spike belongs where API contracts are actually built | 0B |
| `packages/database` (0.6) | Needs Postgres running, which needs docker compose | 0B |
| `ruff` / `mypy` config (0.4) | Nothing Python exists yet | 0B |
| App skeletons (0.7–0.9), docker compose (0.10), Testcontainers (0.13) | — | 0B |
| OpenTelemetry + correlation (0.11) | Needs all three runtimes to exist before propagation can be proven | 0C |
| Terraform `shared` (0.14) | Independent of all application code | 0D |
| Tailwind Prettier plugin | `apps/web` does not exist; adding it now fails to resolve | 0B |

---

## File Structure

| File | Responsibility |
|---|---|
| `pnpm-workspace.yaml`, `package.json`, `turbo.json` | Workspace membership, root scripts, task graph |
| `.nvmrc`, `.python-version`, `.gitignore`, `.editorconfig` | Toolchain and editor pinning |
| `packages/typescript-config/{base,node,react-library}.json` | Compiler flags — one source of truth |
| `packages/typescript-config/test/` | Compile fixtures proving each strict flag actually fires |
| `prettier.config.js` | Formatting — the only formatter |
| `packages/eslint-config/src/{base,type-checked,boundaries,test}.js` | Composable lint profiles |
| `packages/eslint-config/test/` | Lint fixtures proving each rule fires |
| `packages/contracts/src/brand.ts` | The `brandedUuid` helper — one definition |
| `packages/contracts/src/ids.ts` | Every entity ID |
| `packages/contracts/src/money.ts` | `Money`, currency registry, formatting-safe shape |
| `packages/contracts/src/units.ts` | `Millimeters`, `CubicMillimeters`, `Grams`, `Seconds` |
| `packages/contracts/src/result.ts` | `Result`, `ok`, `err`, `assertNever` |
| `packages/contracts/src/errors.ts` | `DomainErrorCode` closed union |
| `packages/contracts/src/hashing.ts` | `canonicalJson`, `sha256Canonical` |
| `packages/contracts/src/index.ts` | Public barrel — the package's entire API surface |
| `.github/workflows/ci.yml` | The gate |

---

### Task 1: Repository skeleton

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `.nvmrc`, `.python-version`, `.gitignore`, `.editorconfig`

**Interfaces:**
- Consumes: nothing
- Produces: workspace globs `apps/*` and `packages/*`; root scripts `lint`, `typecheck`, `test:unit`, `format`, `format:check`, `verify`

- [ ] **Step 1: Create a branch**

```bash
git switch -c feat/phase-0a-foundations
```

- [ ] **Step 2: Write the workspace files**

`pnpm-workspace.yaml`:
```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

`.nvmrc` — the exact Node 24 patch you installed. Get it with `mise install node@24 && mise use node@24 && node --version` (or the nvm equivalent), then write it without the leading `v`:
```
24.10.0
```

`.python-version`:
```
3.12.7
```

`.editorconfig`:
```ini
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true
indent_style = space
indent_size = 2

[*.md]
trim_trailing_whitespace = false
```

`.gitignore`:
```gitignore
node_modules/
dist/
.turbo/
coverage/
*.tsbuildinfo
.env
.env.local
.DS_Store
.venv/
__pycache__/
.pytest_cache/
.mypy_cache/

# agent scratch — ledgers, briefs, review packages
.superpowers/
```

- [ ] **Step 3: Write the root `package.json`**

```json
{
  "name": "metrika",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.12.3",
  "engines": { "node": ">=24 <25" },
  "scripts": {
    "lint": "turbo run lint",
    "lint:fix": "turbo run lint -- --fix",
    "typecheck": "turbo run typecheck",
    "test:unit": "turbo run test:unit",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "verify": "pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:unit"
  }
}
```

Replace `pnpm@9.12.3` with the output of `pnpm --version` after `corepack enable`.

- [ ] **Step 4: Write `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "typecheck": { "dependsOn": ["^typecheck"], "outputs": ["*.tsbuildinfo", "dist/**"] },
    "lint": { "dependsOn": ["^typecheck"] },
    "test:unit": { "dependsOn": ["^typecheck"], "outputs": ["coverage/**"] },
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] }
  }
}
```

`lint` depends on `^typecheck` because type-aware ESLint rules need dependencies' declaration files to exist.

- [ ] **Step 5: Install and verify the workspace resolves**

```bash
corepack enable
pnpm install
pnpm add -Dw -E turbo prettier
pnpm exec turbo run typecheck
```

Expected: turbo runs and reports no packages with a `typecheck` task (there are none yet). No error about a malformed workspace.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: initialise pnpm workspace and turborepo pipeline"
```

---

### Task 2: `packages/typescript-config`

**Files:**
- Create: `packages/typescript-config/package.json`, `base.json`, `node.json`, `react-library.json`
- Test: `packages/typescript-config/test/fixtures/*.ts`, `packages/typescript-config/test/flags.test.ts`, `packages/typescript-config/test/tsconfig.fixtures.json`

**Interfaces:**
- Consumes: Task 1 workspace
- Produces: `@metrika/typescript-config/base.json` (extended by every package), `/node.json`, `/react-library.json`

- [ ] **Step 1: Write the failing test**

The test proves each strict flag actually rejects code. Create three fixtures that must fail to compile.

`packages/typescript-config/test/fixtures/unchecked-index.ts`:
```ts
export function first(items: readonly string[]): string {
  const value = items[0];
  return value.toUpperCase(); // noUncheckedIndexedAccess: value is string | undefined
}
```

`packages/typescript-config/test/fixtures/exact-optional.ts`:
```ts
interface Update { readonly name?: string }
export const update: Update = { name: undefined }; // exactOptionalPropertyTypes
```

`packages/typescript-config/test/fixtures/implicit-returns.ts`:
```ts
export function classify(n: number): string {
  if (n > 0) return 'positive';
  // noImplicitReturns: not all code paths return
}
```

`packages/typescript-config/test/tsconfig.fixtures.json`:
```json
{
  "extends": "../base.json",
  "compilerOptions": {
    "composite": false,
    "declaration": false,
    "declarationMap": false,
    "noEmit": true
  },
  "include": ["fixtures/**/*.ts"]
}
```

`composite` must be switched off here: `tsc` rejects `--noEmit` together with `composite: true` ("Option 'noEmit' cannot be specified with option 'composite'"), and these fixtures are only ever type-checked, never built. The strict flags under test are inherited from `base.json` unchanged, which is the point.

`packages/typescript-config/test/flags.test.ts`:
```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);

async function compileFixtures(): Promise<string> {
  try {
    await run('pnpm', ['exec', 'tsc', '-p', 'test/tsconfig.fixtures.json', '--noEmit']);
    return '';
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
}

describe('base tsconfig strict flags', () => {
  it.each([
    ['noUncheckedIndexedAccess', 'unchecked-index.ts', 'TS18048'],
    ['exactOptionalPropertyTypes', 'exact-optional.ts', 'TS2375'],
    ['noImplicitReturns', 'implicit-returns.ts', 'TS7030'],
  ])('%s rejects its fixture', async (_flag, file, code) => {
    const output = await compileFixtures();
    expect(output).toContain(file);
    expect(output).toContain(code);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @metrika/typescript-config test:unit`
Expected: FAIL — the package and its `base.json` do not exist yet.

- [ ] **Step 3: Write the configs**

`packages/typescript-config/base.json`:
```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
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

    "noUnusedLocals": false,
    "noUnusedParameters": false,

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

`packages/typescript-config/node.json`:
```json
{
  "extends": "./base.json",
  "compilerOptions": { "types": ["node"] }
}
```

`packages/typescript-config/react-library.json`:
```json
{
  "extends": "./base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "moduleResolution": "Bundler",
    "module": "ESNext",
    "jsx": "react-jsx"
  }
}
```

`packages/typescript-config/package.json`:
```json
{
  "name": "@metrika/typescript-config",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "files": ["base.json", "node.json", "react-library.json"],
  "scripts": { "test:unit": "vitest run" },
  "devDependencies": { "typescript": "*", "vitest": "*" }
}
```

- [ ] **Step 4: Install dependencies and run the test**

pnpm's node_modules is strict: a workspace package can only resolve dependencies it declares itself. Root devDependencies are **not** visible to `pnpm --filter <pkg> run …`, so `typescript` and `vitest` must be added to this package, not only to the root.

```bash
pnpm add -Dw -E @types/node
pnpm --filter @metrika/typescript-config add -DE typescript vitest
pnpm --filter @metrika/typescript-config test:unit
```

Expected: PASS — all three fixtures produce their expected error codes.

If instead you see `Option 'noEmit' cannot be specified with option 'composite'`, the `composite: false` override in `tsconfig.fixtures.json` is missing.

- [ ] **Step 5: Commit**

```bash
git add packages/typescript-config
git commit -m "feat(typescript-config): add strict base tsconfig with flag fixtures"
```

---

### Task 3: Prettier

**Files:**
- Create: `prettier.config.js`, `.prettierignore`

**Interfaces:**
- Consumes: Task 1
- Produces: deterministic formatting for `pnpm format` / `format:check`

- [ ] **Step 1: Write the config**

`prettier.config.js`:
```js
/** @type {import('prettier').Config} */
export default {
  semi: true,
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 100,
  tabWidth: 2,
  arrowParens: 'always',
};
```

`.prettierignore`:
```
node_modules/
dist/
.turbo/
coverage/
pnpm-lock.yaml
*.tsbuildinfo
```

The Tailwind plugin is added in Plan 0B when `apps/web` exists — adding it now would fail to resolve.

- [ ] **Step 2: Format the repository and verify the check passes**

```bash
pnpm format
pnpm format:check
```

Expected: `format:check` exits 0.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: add prettier config and format repository"
```

---

### Task 4: `packages/eslint-config`

**Files:**
- Create: `packages/eslint-config/package.json`, `src/base.js`, `src/type-checked.js`, `src/test.js`, `src/index.js`
- Test: `packages/eslint-config/test/fixtures/*.ts`, `packages/eslint-config/test/rules.test.ts`

**Interfaces:**
- Consumes: Task 2
- Produces: named exports `base`, `typeChecked`, `test` from `@metrika/eslint-config`; each is a flat-config array

- [ ] **Step 1: Write the failing test**

Fixtures that MUST produce errors.

`packages/eslint-config/test/fixtures/explicit-any.ts`:
```ts
export function parse(input: any): string {
  return String(input);
}
```

`packages/eslint-config/test/fixtures/floating-promise.ts`:
```ts
async function work(): Promise<void> {}
export function run(): void {
  work();
}
```

`packages/eslint-config/test/fixtures/non-exhaustive-switch.ts`:
```ts
type Shape = { kind: 'circle' } | { kind: 'square' };
export function area(shape: Shape): number {
  switch (shape.kind) {
    case 'circle':
      return 1;
  }
  return 0;
}
```

A fixture that must produce NO errors, so the config is not merely "everything fails":

`packages/eslint-config/test/fixtures/clean.ts`:
```ts
export function greet(name: string): string {
  return `hola ${name}`;
}
```

`packages/eslint-config/test/rules.test.ts`:
```ts
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

async function lintFixture(file: string): Promise<readonly string[]> {
  const eslint = new ESLint({ cwd: import.meta.dirname });
  const [result] = await eslint.lintFiles([`fixtures/${file}`]);
  return (result?.messages ?? []).map((m) => m.ruleId ?? 'unknown');
}

describe('eslint-config typeChecked', () => {
  it.each([
    ['explicit-any.ts', '@typescript-eslint/no-explicit-any'],
    ['floating-promise.ts', '@typescript-eslint/no-floating-promises'],
    ['non-exhaustive-switch.ts', '@typescript-eslint/switch-exhaustiveness-check'],
  ])('%s triggers %s', async (file, rule) => {
    expect(await lintFixture(file)).toContain(rule);
  });

  it('clean.ts produces no findings', async () => {
    expect(await lintFixture('clean.ts')).toEqual([]);
  });
});
```

The fixtures need their own `eslint.config.js` and `tsconfig.json` inside `test/` so the type-aware rules have a program. Create `packages/eslint-config/test/tsconfig.json`:
```json
{
  "extends": "@metrika/typescript-config/base.json",
  "compilerOptions": { "noEmit": true, "composite": false },
  "include": ["fixtures/**/*.ts"]
}
```

and `packages/eslint-config/test/eslint.config.js`:
```js
import { typeChecked } from '../src/index.js';

export default [
  ...typeChecked({ tsconfigRootDir: import.meta.dirname, project: './tsconfig.json' }),
];
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @metrika/eslint-config test:unit`
Expected: FAIL — `../src/index.js` does not exist.

- [ ] **Step 3: Write the configs**

`packages/eslint-config/src/base.js`:
```js
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';

/** @type {import('eslint').Linter.Config[]} */
export const base = [
  js.configs.recommended,
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'no-console': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'env', message: 'Read configuration from config/env.ts only' },
      ],
    },
  },
  prettier,
];
```

`packages/eslint-config/src/type-checked.js`:
```js
import tseslint from 'typescript-eslint';
import { base } from './base.js';

/**
 * @param {{ tsconfigRootDir: string, project?: string | string[] }} options
 * @returns {import('eslint').Linter.Config[]}
 */
export function typeChecked(options) {
  return tseslint.config(
    ...base,
    ...tseslint.configs.strictTypeChecked,
    {
      files: ['**/*.ts', '**/*.tsx'],
      languageOptions: {
        parserOptions: {
          projectService: options.project === undefined,
          project: options.project,
          tsconfigRootDir: options.tsconfigRootDir,
        },
      },
      rules: {
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/no-misused-promises': 'error',
        '@typescript-eslint/switch-exhaustiveness-check': 'error',
        '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
        '@typescript-eslint/consistent-type-exports': 'error',
        '@typescript-eslint/no-non-null-assertion': 'error',
        '@typescript-eslint/promise-function-async': 'error',
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
        ],
        '@typescript-eslint/strict-boolean-expressions': [
          'error',
          {
            allowNullableBoolean: true,
            allowNullableString: true,
            allowNullableObject: true,
            allowNumber: false,
            allowString: false,
          },
        ],
        // Documented exceptions — see docs/TYPESCRIPT_AND_TOOLING.md §3
        '@typescript-eslint/require-await': 'off',
        '@typescript-eslint/explicit-function-return-type': 'off',
        '@typescript-eslint/explicit-module-boundary-types': 'off',
      },
    },
  );
}
```

`packages/eslint-config/src/test.js`:
```js
/** @type {import('eslint').Linter.Config[]} */
export const test = [
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
];
```

`packages/eslint-config/src/index.js`:
```js
export { base } from './base.js';
export { typeChecked } from './type-checked.js';
export { test } from './test.js';
```

`packages/eslint-config/package.json`:
```json
{
  "name": "@metrika/eslint-config",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.js" },
  "scripts": { "test:unit": "vitest run" },
  "dependencies": {
    "@eslint/js": "*",
    "eslint-config-prettier": "*",
    "typescript-eslint": "*"
  },
  "devDependencies": {
    "@metrika/typescript-config": "workspace:*",
    "eslint": "*",
    "vitest": "*"
  }
}
```

- [ ] **Step 4: Install and run the test**

```bash
pnpm add -Dw -E eslint
pnpm --filter @metrika/eslint-config add -E @eslint/js eslint-config-prettier typescript-eslint
pnpm --filter @metrika/eslint-config add -DE @metrika/typescript-config@workspace:* eslint vitest
pnpm --filter @metrika/eslint-config test:unit
```

Expected: PASS — all four assertions, including `clean.ts` producing zero findings.

- [ ] **Step 5: Commit**

```bash
git add packages/eslint-config
git commit -m "feat(eslint-config): add base and type-checked flat config profiles"
```

---

### Task 5: `packages/contracts` scaffold and branded IDs

**Files:**
- Create: `packages/contracts/package.json`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, `src/brand.ts`, `src/ids.ts`, `src/index.ts`
- Test: `packages/contracts/test/ids.test.ts` (runtime), `packages/contracts/test/ids.test-d.ts` (types)

**Interfaces:**
- Consumes: Tasks 2 and 4
- Produces:
  - `brandedUuid<B extends string>(brand: B)` → a Zod schema branded as `B`
  - `UserId`, `OrganizationId`, `ProjectId`, `ModelId`, `ModelVersionId`, `QuoteId`, `OrderId`, `SliceJobId`, `PrintJobId`, `MaterialId`, `PrinterProfileVersionId` — each exported as both a schema and a type

- [ ] **Step 1: Write the failing test**

`packages/contracts/test/ids.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ModelId } from '../src/index.js';

describe('branded IDs', () => {
  it('accepts a UUIDv4', () => {
    const raw = '9f1c2b3a-4d5e-4f60-8a1b-2c3d4e5f6071';
    expect(ModelId.parse(raw)).toBe(raw);
  });

  it('accepts a UUIDv7', () => {
    const raw = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4051';
    expect(ModelId.parse(raw)).toBe(raw);
  });

  it('rejects a non-UUID', () => {
    expect(ModelId.safeParse('not-a-uuid').success).toBe(false);
  });

  it('rejects the nil UUID', () => {
    expect(ModelId.safeParse('00000000-0000-0000-0000-000000000000').success).toBe(false);
  });
});
```

Nominal distinctness is a **compile-time** property, so it goes in a type test, not a runtime test. `expectTypeOf` compiles to a no-op at runtime — placed in a `*.test.ts` it asserts nothing and passes even when branding is broken. Vitest only evaluates it under `--typecheck`, against `*.test-d.ts` files.

`packages/contracts/test/ids.test-d.ts`:
```ts
import { describe, expectTypeOf, it } from 'vitest';
import type { ModelId, ProjectId } from '../src/index.js';

describe('branded IDs are nominally distinct', () => {
  it('does not let a ProjectId satisfy ModelId', () => {
    expectTypeOf<ProjectId>().not.toEqualTypeOf<ModelId>();
  });

  it('does not let a bare string satisfy ModelId', () => {
    expectTypeOf<string>().not.toEqualTypeOf<ModelId>();
  });

  it('lets a ModelId be used as a string', () => {
    expectTypeOf<ModelId>().toExtend<string>();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @metrika/contracts test:unit`
Expected: FAIL — the package does not exist.

- [ ] **Step 3: Write the package**

`packages/contracts/src/brand.ts`:
```ts
import { z } from 'zod';

/**
 * Accepts UUID variants 1-8 (RFC 9562), which includes v7 — the version this
 * schema uses for time-sortable primary keys. Written as an explicit regex
 * rather than Zod's `.uuid()` so behaviour does not shift across Zod majors,
 * which have differed on which versions they accept.
 * The nil UUID is deliberately rejected: it is never a valid identifier here.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function brandedUuid<B extends string>(brand: B) {
  return z.string().regex(UUID_PATTERN, `must be a UUID (${brand})`).brand<B>();
}
```

`packages/contracts/src/ids.ts`:
```ts
import { z } from 'zod';
import { brandedUuid } from './brand.js';

export const UserId = brandedUuid('UserId');
export const OrganizationId = brandedUuid('OrganizationId');
export const ProjectId = brandedUuid('ProjectId');
export const ModelId = brandedUuid('ModelId');
export const ModelVersionId = brandedUuid('ModelVersionId');
export const QuoteId = brandedUuid('QuoteId');
export const OrderId = brandedUuid('OrderId');
export const SliceJobId = brandedUuid('SliceJobId');
export const PrintJobId = brandedUuid('PrintJobId');
export const MaterialId = brandedUuid('MaterialId');
export const PrinterProfileVersionId = brandedUuid('PrinterProfileVersionId');

export type UserId = z.infer<typeof UserId>;
export type OrganizationId = z.infer<typeof OrganizationId>;
export type ProjectId = z.infer<typeof ProjectId>;
export type ModelId = z.infer<typeof ModelId>;
export type ModelVersionId = z.infer<typeof ModelVersionId>;
export type QuoteId = z.infer<typeof QuoteId>;
export type OrderId = z.infer<typeof OrderId>;
export type SliceJobId = z.infer<typeof SliceJobId>;
export type PrintJobId = z.infer<typeof PrintJobId>;
export type MaterialId = z.infer<typeof MaterialId>;
export type PrinterProfileVersionId = z.infer<typeof PrinterProfileVersionId>;
```

`packages/contracts/src/index.ts`:
```ts
export * from './brand.js';
export * from './ids.js';
```

`packages/contracts/tsconfig.json`:
```json
{
  "extends": "@metrika/typescript-config/base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "." },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

`packages/contracts/eslint.config.js`:
```js
import { typeChecked } from '@metrika/eslint-config';

export default [
  ...typeChecked({ tsconfigRootDir: import.meta.dirname, project: './tsconfig.json' }),
  { ignores: ['dist/**'] },
];
```

`packages/contracts/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    typecheck: {
      enabled: true,
      include: ['test/**/*.test-d.ts'],
      tsconfig: './tsconfig.json',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
});
```

`typecheck.enabled` is what makes the `*.test-d.ts` assertions real — without it Vitest never type-checks them and branding regressions pass silently.

`packages/contracts/package.json`:
```json
{
  "name": "@metrika/contracts",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc -b",
    "lint": "eslint .",
    "test:unit": "vitest run --coverage"
  },
  "dependencies": { "zod": "*" },
  "devDependencies": {
    "@metrika/eslint-config": "workspace:*",
    "@metrika/typescript-config": "workspace:*",
    "@vitest/coverage-v8": "*",
    "eslint": "*",
    "typescript": "*",
    "vitest": "*"
  }
}
```

- [ ] **Step 4: Install and run the test**

```bash
pnpm --filter @metrika/contracts add -E zod
pnpm --filter @metrika/contracts add -DE @metrika/eslint-config@workspace:* \
  @metrika/typescript-config@workspace:* @vitest/coverage-v8 eslint typescript vitest
pnpm --filter @metrika/contracts test:unit
```

Expected: PASS, 5 tests, 100% coverage of `src/`.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts pnpm-lock.yaml
git commit -m "feat(contracts): add branded UUID identifiers for every entity"
```

---

### Task 6: Money

**Files:**
- Create: `packages/contracts/src/money.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/money.test.ts`

**Interfaces:**
- Consumes: Task 5
- Produces:
  - `CurrencyCode` — Zod enum of `'COP' | 'USD' | 'EUR' | 'MXN'`
  - `CURRENCY_REGISTRY: Readonly<Record<CurrencyCode, { exponent: number; symbol: string }>>`
  - `Money` — Zod object `{ amountMinor: string; currency: CurrencyCode; exponent: number }`
  - `type Money`
  - `money(amountMinor: bigint, currency: CurrencyCode): Money`
  - `toBigInt(m: Money): bigint`
  - `addMoney(a: Money, b: Money): Money` — throws `MoneyMismatchError` on differing currency or exponent
  - `class MoneyMismatchError extends Error`

- [ ] **Step 1: Write the failing test**

`packages/contracts/test/money.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { addMoney, CURRENCY_REGISTRY, Money, MoneyMismatchError, money, toBigInt } from '../src/index.js';

describe('Money', () => {
  it('constructs COP with exponent 0 from the registry', () => {
    const m = money(350_000n, 'COP');
    expect(m).toEqual({ amountMinor: '350000', currency: 'COP', exponent: 0 });
  });

  it('constructs USD with exponent 2', () => {
    expect(money(1999n, 'USD').exponent).toBe(2);
  });

  it('round-trips through bigint without precision loss beyond Number.MAX_SAFE_INTEGER', () => {
    const huge = 9_007_199_254_740_993n; // MAX_SAFE_INTEGER + 2
    expect(toBigInt(money(huge, 'COP'))).toBe(huge);
  });

  it('serialises the amount as a string, never a number', () => {
    expect(typeof money(1n, 'COP').amountMinor).toBe('string');
  });

  it('parses a valid wire representation', () => {
    expect(Money.safeParse({ amountMinor: '-500', currency: 'COP', exponent: 0 }).success).toBe(true);
  });

  it('rejects a non-integer amount string', () => {
    expect(Money.safeParse({ amountMinor: '1.5', currency: 'COP', exponent: 0 }).success).toBe(false);
  });

  it('rejects a numeric amount', () => {
    expect(Money.safeParse({ amountMinor: 100, currency: 'COP', exponent: 0 }).success).toBe(false);
  });

  it('adds amounts of the same currency', () => {
    expect(addMoney(money(100n, 'COP'), money(250n, 'COP')).amountMinor).toBe('350');
  });

  it('throws when currencies differ', () => {
    expect(() => addMoney(money(1n, 'COP'), money(1n, 'USD'))).toThrow(MoneyMismatchError);
  });

  it('throws when exponents differ for the same currency', () => {
    const odd = { ...money(1n, 'COP'), exponent: 2 };
    expect(() => addMoney(money(1n, 'COP'), odd)).toThrow(MoneyMismatchError);
  });

  it('registry declares COP as exponent 0 — Colombian commerce uses whole pesos', () => {
    expect(CURRENCY_REGISTRY.COP.exponent).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @metrika/contracts test:unit -- money`
Expected: FAIL — `addMoney` and friends are not exported.

- [ ] **Step 3: Write the implementation**

`packages/contracts/src/money.ts`:
```ts
import { z } from 'zod';

export const CurrencyCode = z.enum(['COP', 'USD', 'EUR', 'MXN']);
export type CurrencyCode = z.infer<typeof CurrencyCode>;

/**
 * `exponent` is how many minor units make one major unit, as USED, not as ISO
 * 4217 declares it. ISO assigns COP two minor units; Colombian commerce
 * operates in whole pesos, and rendering 350000 as "$3,500.00" would be wrong.
 */
export const CURRENCY_REGISTRY: Readonly<
  Record<CurrencyCode, { readonly exponent: number; readonly symbol: string }>
> = {
  COP: { exponent: 0, symbol: '$' },
  USD: { exponent: 2, symbol: 'US$' },
  EUR: { exponent: 2, symbol: '€' },
  MXN: { exponent: 2, symbol: 'MX$' },
};

const INTEGER_STRING = /^-?(0|[1-9]\d*)$/;

export const Money = z.object({
  amountMinor: z.string().regex(INTEGER_STRING, 'must be an integer string'),
  currency: CurrencyCode,
  exponent: z.number().int().min(0).max(4),
});
export type Money = z.infer<typeof Money>;

export class MoneyMismatchError extends Error {
  constructor(a: Money, b: Money) {
    super(`Cannot combine ${a.currency}/${a.exponent} with ${b.currency}/${b.exponent}`);
    this.name = 'MoneyMismatchError';
  }
}

export function money(amountMinor: bigint, currency: CurrencyCode): Money {
  return {
    amountMinor: amountMinor.toString(),
    currency,
    exponent: CURRENCY_REGISTRY[currency].exponent,
  };
}

export function toBigInt(value: Money): bigint {
  return BigInt(value.amountMinor);
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency || a.exponent !== b.exponent) {
    throw new MoneyMismatchError(a, b);
  }
  return { ...a, amountMinor: (toBigInt(a) + toBigInt(b)).toString() };
}
```

Add to `packages/contracts/src/index.ts`:
```ts
export * from './money.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @metrika/contracts test:unit`
Expected: PASS, coverage still 100%.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): add Money as minor units with explicit currency exponent"
```

---

### Task 7: Physical units

**Files:**
- Create: `packages/contracts/src/units.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/units.test.ts` (runtime), `packages/contracts/test/units.test-d.ts` (types)

**Interfaces:**
- Consumes: Task 5
- Produces: `Millimeters`, `SquareMillimeters`, `CubicMillimeters`, `Grams`, `Seconds` — each a branded Zod number schema plus its inferred type. Constructors `mm`, `mm2`, `mm3`, `grams`, `seconds`.

- [ ] **Step 1: Write the failing test**

`packages/contracts/test/units.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { CubicMillimeters, Grams, Millimeters, Seconds } from '../src/index.js';

describe('physical units', () => {
  it('accepts a finite non-negative value', () => {
    expect(Grams.parse(148.2)).toBe(148.2);
  });

  it('rejects NaN', () => {
    expect(Grams.safeParse(Number.NaN).success).toBe(false);
  });

  it('rejects Infinity', () => {
    expect(Grams.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
  });

  it('rejects negative mass', () => {
    expect(Grams.safeParse(-1).success).toBe(false);
  });

  it('rejects negative duration', () => {
    expect(Seconds.safeParse(-1).success).toBe(false);
  });

  it('allows negative length — coordinates can be negative', () => {
    expect(Millimeters.safeParse(-12.5).success).toBe(true);
  });

  it('rejects negative volume', () => {
    expect(CubicMillimeters.safeParse(-1).success).toBe(false);
  });
});
```

`packages/contracts/test/units.test-d.ts`:
```ts
import { describe, expectTypeOf, it } from 'vitest';
import type { CubicMillimeters, Grams, Millimeters, Seconds } from '../src/index.js';

describe('units are nominally distinct', () => {
  it('does not let Grams satisfy Millimeters', () => {
    expectTypeOf<Grams>().not.toEqualTypeOf<Millimeters>();
  });

  it('does not let Millimeters satisfy Grams', () => {
    expectTypeOf<Millimeters>().not.toEqualTypeOf<Grams>();
  });

  it('does not let CubicMillimeters satisfy Grams — the mix-up that becomes a wrong price', () => {
    expectTypeOf<CubicMillimeters>().not.toEqualTypeOf<Grams>();
  });

  it('does not let a bare number satisfy Seconds', () => {
    expectTypeOf<number>().not.toEqualTypeOf<Seconds>();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @metrika/contracts test:unit -- units`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`packages/contracts/src/units.ts`:
```ts
import { z } from 'zod';

/**
 * Canonical internal units: millimetres, grams, seconds. Branding is applied
 * only to the quantities that flow into money, where a mix-up becomes a wrong
 * invoice. Everything else relies on the naming convention (`lengthMm`,
 * `massG`, `durationS`) — see docs/DOMAIN_MODEL.md §4.
 *
 * Length may be negative (coordinates); mass, area, volume and duration may
 * not.
 */
export const Millimeters = z.number().finite().brand<'Millimeters'>();
export const SquareMillimeters = z.number().finite().nonnegative().brand<'SquareMillimeters'>();
export const CubicMillimeters = z.number().finite().nonnegative().brand<'CubicMillimeters'>();
export const Grams = z.number().finite().nonnegative().brand<'Grams'>();
export const Seconds = z.number().finite().nonnegative().brand<'Seconds'>();

export type Millimeters = z.infer<typeof Millimeters>;
export type SquareMillimeters = z.infer<typeof SquareMillimeters>;
export type CubicMillimeters = z.infer<typeof CubicMillimeters>;
export type Grams = z.infer<typeof Grams>;
export type Seconds = z.infer<typeof Seconds>;

export const mm = (value: number): Millimeters => Millimeters.parse(value);
export const mm2 = (value: number): SquareMillimeters => SquareMillimeters.parse(value);
export const mm3 = (value: number): CubicMillimeters => CubicMillimeters.parse(value);
export const grams = (value: number): Grams => Grams.parse(value);
export const seconds = (value: number): Seconds => Seconds.parse(value);
```

Add to `packages/contracts/src/index.ts`:
```ts
export * from './units.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @metrika/contracts test:unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): add branded physical unit types"
```

---

### Task 8: Result, exhaustiveness and domain error codes

**Files:**
- Create: `packages/contracts/src/result.ts`, `packages/contracts/src/errors.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/result.test.ts`

**Interfaces:**
- Consumes: Task 5
- Produces:
  - `type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }`
  - `ok<T>(value: T): Result<T, never>`, `err<E>(error: E): Result<never, E>`
  - `isOk`, `isErr` type guards
  - `assertNever(value: never, context: string): never`
  - `DomainErrorCode` Zod enum + type

- [ ] **Step 1: Write the failing test**

`packages/contracts/test/result.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { assertNever, DomainErrorCode, err, isErr, isOk, ok } from '../src/index.js';

describe('Result', () => {
  it('ok carries its value', () => {
    const r = ok(42);
    expect(r).toEqual({ ok: true, value: 42 });
    expect(isOk(r)).toBe(true);
    expect(isErr(r)).toBe(false);
  });

  it('err carries its error', () => {
    const r = err('QUOTE_EXPIRED');
    expect(r).toEqual({ ok: false, error: 'QUOTE_EXPIRED' });
    expect(isErr(r)).toBe(true);
    expect(isOk(r)).toBe(false);
  });

  it('narrows through isOk', () => {
    const r = ok('value');
    if (isOk(r)) expect(r.value.toUpperCase()).toBe('VALUE');
    else throw new Error('unreachable');
  });
});

describe('assertNever', () => {
  it('throws naming the context and the unhandled value', () => {
    expect(() => assertNever('UNEXPECTED' as never, 'FitResult')).toThrow(
      /FitResult.*UNEXPECTED/s,
    );
  });
});

describe('DomainErrorCode', () => {
  it('includes the codes the domain throws', () => {
    for (const code of ['MODEL_NOT_FOUND', 'UNITS_NOT_CONFIRMED', 'QUOTE_EXPIRED', 'SLICING_FAILED']) {
      expect(DomainErrorCode.safeParse(code).success).toBe(true);
    }
  });

  it('is a closed union', () => {
    expect(DomainErrorCode.safeParse('SOMETHING_MADE_UP').success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @metrika/contracts test:unit -- result`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`packages/contracts/src/result.ts`:
```ts
export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is { readonly ok: true; readonly value: T } {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is { readonly ok: false; readonly error: E } {
  return !result.ok;
}

/** Compile-time exhaustiveness guard for discriminated unions. */
export function assertNever(value: never, context: string): never {
  throw new Error(`Unhandled case in ${context}: ${JSON.stringify(value)}`);
}
```

`packages/contracts/src/errors.ts`:
```ts
import { z } from 'zod';

export const DomainErrorCode = z.enum([
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'INSUFFICIENT_PERMISSIONS',
  'MODEL_NOT_FOUND',
  'MODEL_NOT_READY',
  'MODEL_NOT_PRINTABLE',
  'MODEL_TOO_COMPLEX',
  'UNSUPPORTED_FILE_FORMAT',
  'FILE_TOO_LARGE',
  'CHECKSUM_MISMATCH',
  'MALICIOUS_ARCHIVE',
  'UNITS_NOT_CONFIRMED',
  'IMPLAUSIBLE_SCALE',
  'GEOMETRY_ANALYSIS_FAILED',
  'INVALID_PRINT_CONFIGURATION',
  'DOES_NOT_FIT_BUILD_VOLUME',
  'SLICING_FAILED',
  'QUOTE_NOT_FOUND',
  'QUOTE_EXPIRED',
  'QUOTE_SUPERSEDED',
  'INVALID_STATE_TRANSITION',
  'PAYMENT_VERIFICATION_FAILED',
  'IDEMPOTENCY_KEY_REUSED',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'INTERNAL_ERROR',
]);
export type DomainErrorCode = z.infer<typeof DomainErrorCode>;
```

Add to `packages/contracts/src/index.ts`:
```ts
export * from './result.js';
export * from './errors.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @metrika/contracts test:unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): add Result, assertNever and the closed domain error union"
```

---

### Task 9: Canonical JSON and content hashing

**Files:**
- Create: `packages/contracts/src/hashing.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/hashing.test.ts`

**Interfaces:**
- Consumes: Task 5
- Produces:
  - `canonicalJson(value: CanonicalValue): string` — deterministic, sorted keys, no whitespace
  - `type CanonicalValue = string | number | boolean | null | readonly CanonicalValue[] | { readonly [k: string]: CanonicalValue | undefined }`
  - `sha256Canonical(value: CanonicalValue): Promise<string>` — 64-char lowercase hex
  - `class CanonicalizationError extends Error`

This is the function the slice cache key depends on ([docs/SLICING.md §5](../../SLICING.md#5-reproducibility-and-the-cache)). If it is not stable, the cache silently serves wrong results.

- [ ] **Step 1: Write the failing test**

`packages/contracts/test/hashing.test.ts`:
```ts
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CanonicalizationError, canonicalJson, sha256Canonical } from '../src/index.js';

describe('canonicalJson', () => {
  it('sorts object keys', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts nested object keys', () => {
    expect(canonicalJson({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('emits no whitespace', () => {
    expect(canonicalJson({ a: [1, { b: 2 }] })).toBe('{"a":[1,{"b":2}]}');
  });

  it('omits undefined object values', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('preserves null', () => {
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
  });

  it('rejects non-integer numbers — decimals must be passed as strings', () => {
    expect(() => canonicalJson({ a: 1.5 })).toThrow(CanonicalizationError);
  });

  it('rejects NaN', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(CanonicalizationError);
  });

  it('rejects Infinity', () => {
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(CanonicalizationError);
  });

  it('rejects bigint — convert explicitly to avoid 1n/"1" collisions', () => {
    expect(() => canonicalJson({ a: 1n } as never)).toThrow(CanonicalizationError);
  });

  it('rejects Date — pass an ISO string', () => {
    expect(() => canonicalJson({ a: new Date(0) } as never)).toThrow(CanonicalizationError);
  });

  it('rejects a top-level undefined', () => {
    expect(() => canonicalJson(undefined as never)).toThrow(CanonicalizationError);
  });

  it('is insensitive to key insertion order', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.integer()), (obj) => {
        const reversed = Object.fromEntries(Object.entries(obj).reverse());
        expect(canonicalJson(obj)).toBe(canonicalJson(reversed));
      }),
    );
  });

  it('is deterministic across repeated calls', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.oneof(fc.integer(), fc.string(), fc.boolean())), (obj) => {
        expect(canonicalJson(obj)).toBe(canonicalJson(obj));
      }),
    );
  });
});

describe('sha256Canonical', () => {
  it('produces 64 lowercase hex characters', async () => {
    expect(await sha256Canonical({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces the known digest of the canonical bytes', async () => {
    // sha256 of the exact byte sequence: {"a":1}
    expect(await sha256Canonical({ a: 1 })).toBe(
      '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862',
    );
  });

  it('gives identical digests for differently ordered but equal objects', async () => {
    expect(await sha256Canonical({ b: 1, a: 2 })).toBe(await sha256Canonical({ a: 2, b: 1 }));
  });

  it('gives different digests for different values', async () => {
    expect(await sha256Canonical({ a: 2 })).toBe(
      '7e8059f495589fcd981232cc11d00b00da3802c01d688fa1cf1f6bed6e5bb33c',
    );
    expect(await sha256Canonical({ a: 1 })).not.toBe(await sha256Canonical({ a: 2 }));
  });
});
```

The two digest literals are the real SHA-256 of `{"a":1}` and `{"a":2}`, verified with `printf '%s' '{"a":1}' | shasum -a 256`. They are hardcoded deliberately: a digest test that computes its own expected value asserts nothing. If the implementation ever changes its serialisation, these fail — which is the point, because the slice cache key depends on this exact byte sequence being stable forever.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @metrika/contracts test:unit -- hashing`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`packages/contracts/src/hashing.ts`:
```ts
export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue | undefined };

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalizationError';
  }
}

/**
 * Deterministic JSON: keys sorted, no whitespace, undefined object values
 * omitted. Non-integer numbers are REJECTED — floats are not reproducible
 * across platforms, and this function backs the slice cache key, where an
 * unstable hash silently serves wrong manufacturing metrics. Pass decimals as
 * strings. bigint and Date are rejected so callers convert explicitly rather
 * than relying on a coercion that could collide (1n and "1").
 */
export function canonicalJson(value: CanonicalValue): string {
  return serialize(value, '$');
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(`Non-finite number at ${path}`);
      }
      if (!Number.isInteger(value)) {
        throw new CanonicalizationError(
          `Non-integer number at ${path}; pass decimals as strings`,
        );
      }
      return value.toString();
    case 'object':
      break;
    default:
      throw new CanonicalizationError(`Unsupported type ${typeof value} at ${path}`);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item, i) => serialize(item, `${path}[${i}]`)).join(',')}]`;
  }

  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new CanonicalizationError(`Only plain objects are supported, at ${path}`);
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${serialize(v, `${path}.${k}`)}`);

  return `{${entries.join(',')}}`;
}

/**
 * Uses Web Crypto rather than node:crypto so `packages/contracts` stays free
 * of Node built-ins and remains safe to bundle for the browser.
 */
export async function sha256Canonical(value: CanonicalValue): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
```

Note the `typeof value === 'undefined'` case falls through to `default`, which throws — that is how a top-level `undefined` is rejected while an `undefined` *object value* is filtered out before recursion.

Add to `packages/contracts/src/index.ts`:
```ts
export * from './hashing.js';
```

- [ ] **Step 4: Fix the known-digest test, then run**

```bash
printf '%s' '{"a":1}' | shasum -a 256
```

Replace the self-referential assertion with the literal digest, then:

Run: `pnpm --filter @metrika/contracts test:unit`
Expected: PASS, 100% coverage.

- [ ] **Step 5: Commit**

```bash
pnpm --filter @metrika/contracts add -DE fast-check
git add packages/contracts pnpm-lock.yaml
git commit -m "feat(contracts): add canonical JSON serialisation and sha256 content hashing"
```

---

### Task 10: Dependency boundary enforcement

**Files:**
- Create: `packages/eslint-config/src/boundaries.js`
- Modify: `packages/eslint-config/src/index.js`, `packages/contracts/eslint.config.js`
- Test: `packages/eslint-config/test/fixtures/contracts-forbidden-import.ts`, `packages/eslint-config/test/rules.test.ts`

**Interfaces:**
- Consumes: Task 4
- Produces: `contractsBoundary` — a flat-config array forbidding any import except `zod` inside `packages/contracts/src`

- [ ] **Step 1: Write the failing test**

`packages/eslint-config/test/fixtures/contracts-forbidden-import.ts`:
```ts
import { createHash } from 'node:crypto';

export function hash(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
```

Append to `packages/eslint-config/test/rules.test.ts`:
```ts
describe('contracts boundary', () => {
  it('forbids node built-ins inside contracts', async () => {
    const eslint = new ESLint({
      cwd: import.meta.dirname,
      overrideConfigFile: 'eslint.boundaries.config.js',
    });
    const [result] = await eslint.lintFiles(['fixtures/contracts-forbidden-import.ts']);
    const rules = (result?.messages ?? []).map((m) => m.ruleId);
    expect(rules).toContain('no-restricted-imports');
  });
});
```

`packages/eslint-config/test/eslint.boundaries.config.js`:
```js
import { contractsBoundary } from '../src/index.js';

export default [...contractsBoundary];
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @metrika/eslint-config test:unit -- boundary`
Expected: FAIL — `contractsBoundary` is not exported.

- [ ] **Step 3: Write the boundary config**

`packages/eslint-config/src/boundaries.js`:
```js
/**
 * packages/contracts is the root of the dependency graph. Anything it imports
 * propagates to every consumer, including the browser bundle. Only zod is
 * permitted. See docs/ARCHITECTURE.md §7.
 */
export const contractsBoundary = [
  {
    files: ['**/*.ts'],
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
    },
  },
];
```

Add to `packages/eslint-config/src/index.js`:
```js
export { contractsBoundary } from './boundaries.js';
```

Apply it in `packages/contracts/eslint.config.js`:
```js
import { contractsBoundary, typeChecked } from '@metrika/eslint-config';

export default [
  ...typeChecked({ tsconfigRootDir: import.meta.dirname, project: './tsconfig.json' }),
  ...contractsBoundary.map((c) => ({ ...c, files: ['src/**/*.ts'] })),
  { ignores: ['dist/**'] },
];
```

Scoping to `src/**` deliberately lets tests import `fast-check` and `vitest`.

- [ ] **Step 4: Run the tests and lint contracts**

```bash
pnpm --filter @metrika/eslint-config test:unit
pnpm --filter @metrika/contracts lint
```

Expected: tests PASS; `contracts` lints clean (it imports only `zod`).

- [ ] **Step 5: Commit**

```bash
git add packages/eslint-config packages/contracts
git commit -m "feat(eslint-config): enforce that contracts imports only zod"
```

---

### Task 11: CI pipeline

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `package.json` (add `ci` script)

**Interfaces:**
- Consumes: Tasks 1–10
- Produces: a green CI run gating every pull request

- [ ] **Step 1: Write the workflow**

`.github/workflows/ci.yml`:
```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: pnpm

      - name: Install
        run: pnpm install --frozen-lockfile

      - name: Format check
        run: pnpm format:check

      - name: Lint
        run: pnpm lint -- --max-warnings=0

      - name: Typecheck
        run: pnpm typecheck

      - name: Unit tests
        run: pnpm test:unit

      - name: Reject unjustified suppressions
        run: |
          if grep -rnE '(eslint-disable[^\n]*|@ts-expect-error)' \
               --include='*.ts' --include='*.tsx' --include='*.js' \
               packages apps 2>/dev/null | grep -v -- '--'; then
            echo "::error::Every eslint-disable / @ts-expect-error needs a '-- <justification>'"
            exit 1
          fi

      - name: Reject @ts-ignore
        run: |
          if grep -rn '@ts-ignore' --include='*.ts' --include='*.tsx' packages apps 2>/dev/null; then
            echo "::error::@ts-ignore is banned — use @ts-expect-error with a justification"
            exit 1
          fi
```

- [ ] **Step 2: Verify the same gates pass locally**

```bash
pnpm install --frozen-lockfile
pnpm verify
```

Expected: all four stages exit 0.

- [ ] **Step 3: Commit and push, then confirm CI is green**

```bash
git add .github package.json
git commit -m "ci: add verify pipeline with format, lint, typecheck and unit tests"
git push -u origin feat/phase-0a-foundations
gh run watch
```

Expected: the `verify` job succeeds.

---

### Task 12: Documentation reconciliation

**Files:**
- Modify: `CLAUDE.md`, `docs/LOCAL_DEVELOPMENT.md`, `docs/ROADMAP.md`

**Interfaces:**
- Consumes: Tasks 1–11
- Produces: documentation that matches what now exists

- [ ] **Step 1: Update `CLAUDE.md`**

Replace the "Current state" section's first line so it no longer claims nothing exists:

```markdown
## Current state

Phase 0A is complete: the monorepo, quality-gate config packages, and
`packages/contracts` core primitives exist and are tested. `apps/` is still
empty — Plan 0B builds the runtime skeletons.

Read [`docs/ROADMAP.md`](./docs/ROADMAP.md) before starting work and confirm
which phase it belongs to.
```

In the Commands section, delete the sentence "None of these work yet; they are the script surface Phase 0 must create." and replace with:

```markdown
Working today: `verify`, `lint`, `typecheck`, `test:unit`, `format`, `format:check`.
Not yet created (Plans 0B/0C): `dev`, `test:integration`, `test:e2e`, `db:*`, `contracts:emit`.
```

- [ ] **Step 2: Update `docs/LOCAL_DEVELOPMENT.md`**

In §2, mark the steps that work today:

```markdown
Working after Plan 0A: `mise install`, `pnpm install`, `pnpm verify`.
`docker compose up -d`, `pnpm db:migrate`, `pnpm db:seed` and `pnpm dev`
arrive in Plan 0B.
```

- [ ] **Step 3: Mark Phase 0 deliverables done in `docs/ROADMAP.md`**

Prefix the Task column for 0.1–0.6 and 0.12 with `✅ ` and add a line under the Phase 0 deliverables table:

```markdown
Progress: 0.1–0.6, 0.12 complete (Plan 0A). Remaining: 0.7–0.11, 0.13–0.16.
```

- [ ] **Step 4: Verify links still resolve and the tree is clean**

```bash
pnpm format
pnpm verify
git status --short
```

Expected: `verify` passes; `git status` shows only the intended doc changes.

- [ ] **Step 5: Commit and open the pull request**

```bash
git add -A
git commit -m "docs: reconcile documentation with Phase 0A deliverables"
git push
gh pr create --fill --title "Phase 0A — monorepo foundations and contracts core"
```

---

## Definition of done for Plan 0A

- `pnpm verify` passes on a clean clone (`rm -rf node_modules && pnpm install --frozen-lockfile && pnpm verify`).
- CI is green on the pull request.
- `packages/contracts` is at 100% line and branch coverage.
- `packages/contracts` imports nothing but `zod`, proven by a lint fixture rather than by inspection.
- Every strict tsconfig flag and every headline ESLint rule has a fixture proving it fires.
- No `any`, no `@ts-ignore`, no unjustified suppression anywhere.
- No commit contains AI attribution.
- Documentation states what exists rather than what is planned.
