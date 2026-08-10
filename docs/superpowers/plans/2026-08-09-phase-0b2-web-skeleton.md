# Phase 0B-2 — `apps/web` skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `apps/web` as a Next.js App Router application that boots, renders a localised shell in `es-CO`, and is fenced by the same lint boundaries that already protect `apps/api` — with no domain features, no API client, and no 3D viewer.

**Architecture:** Presentation only. `apps/web` renders; it never computes a price, never touches Postgres, and never mutates the domain. Configuration is parsed once through Zod in `src/config/env.ts`, split into a server half and a client half because Next inlines `NEXT_PUBLIC_*` at build time and a whole-object read of `process.env` silently defeats that. Money and measurement formatting is centralised in `src/lib/formatting` from the first commit, fed the currency exponent rather than a float, because retrofitting that across a built UI is how currencies get rendered wrong.

**Tech Stack:** Next.js App Router, React 19, TypeScript 6.0.3, Tailwind CSS 4, shadcn/ui (copy-in), `next-intl`, ESLint 10 flat config, Vitest 4, Playwright.

## Global Constraints

Copy these values verbatim. Every task's requirements implicitly include this section.

- **Exact version pins, no ranges.** TypeScript `6.0.3` · ESLint `10.8.0` · Vitest `4.1.10` · Zod `4.4.3` · Node `24.19.0` (`.nvmrc`; `preinstall` fails outright on another major — the ambient shell may be a different version, so use `mise exec` or put `/Users/mike/.local/share/mise/installs/node/24.19.0/bin` on `PATH`).
- **Next.js, React, Tailwind and `next-intl` versions are decided by Task 1's spike, not assumed here.** Every later task reads them from `apps/web/package.json`.
- **No `any`.** External data is `unknown` and parsed with Zod. `@ts-ignore` is banned. `@ts-expect-error` and `eslint-disable` require a `-- <justification>` on the same line or CI's two suppression greps fail the build.
- **`process.env` may be read only in `apps/web/src/config/env.ts`.** Enforced by lint, as it already is for `apps/api/src/config/env.ts`.
- **`apps/web` must not import `@metrika/database` or `@metrika/pricing-engine`.** Prices are computed server-side; a client-side recomputation is a second source of truth. Enforced by lint with a fixture asserting rejection.
- **`'use server'` may appear only in `apps/web/src/app/**/actions.ts` and `apps/web/src/lib/session/**`.** Server Actions are for cookies, the SSE relay, and Vercel-side form posts — never domain mutations. See [ADR-0015](../../adr/0015-server-actions.md).
- **Cross-feature imports go through `src/features/<feature>/index.ts`.** Deep imports into another feature's `components/`, `hooks/`, `schemas/` or `lib/` are a lint error.
- **Exactly two Zustand stores will ever exist** (`viewerStore`, `uploadStore`), both feature-scoped. Neither is created in this plan. There is no `useAppStore`.
- **Server state lives in TanStack Query and is never mirrored into Zustand.** No TanStack Query provider is installed in this plan — it arrives with the first real query, in the plan that adds `packages/api-client`.
- **Money on the wire is an integer string** — base-10 digits, optional leading `-`, no decimal point. Never `number`, never `Float`. `Intl.NumberFormat` is fed a decimal **string**, never a float.
- **Every physical quantity carries its unit in its name** (`lengthMm`, `massG`, `volumeMm3`, `durationS`).
- **Documentation ships in the same commit as the code it describes.** ADRs are immutable — supersede, never edit, apart from a status line.
- **Conventional commits, scoped by package** (`feat(web): …`). **No `Co-Authored-By` trailers or any other AI attribution.**
- **Gates, all from `$?` directly** — never off a pipe, since `cmd | tail; echo $?` reports `tail`'s status:
  - `pnpm verify` exit 0
  - `pnpm test:integration` exit 0
  - `tsc -b --force` exit 0 for every package
- **Do not add an `actions/cache` step for `.turbo` and do not enable a Turbo remote cache.** `tsc -b` skips re-checking when only a workspace dependency's `.d.ts` changed, because no tsconfig declares project `references`; a fresh checkout carrying no build-info is the only reason CI currently catches it. See [R19](../../RISK_REGISTER.md#r19--tsc--b-skips-stale-cross-package-dependencies) and the comment at the top of `.github/workflows/ci.yml`.

## What this plan does **not** build

Named explicitly so no task quietly grows into them: `packages/api-client`, `packages/ui`, TanStack Query wiring, either Zustand store, the 3D viewer, authentication, any domain route, any real page beyond the shell, and the `en-US` catalogue's actual copy (the locale is scaffolded, not translated).

## File structure

| File                                                          | Responsibility                                                             |
| ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `packages/eslint-config/src/react.js`                         | React + hooks + a11y rules, framework-agnostic                             |
| `packages/eslint-config/src/next.js`                          | `react` composed with Next's rules and the App Router zones                |
| `packages/eslint-config/src/boundaries.js` (modify)           | `webBoundary`, `serverActionBoundary`, `featureBoundary`                   |
| `packages/eslint-config/test/eslint.react.config.js`          | Fixture proving the React profile rejects what it claims to                |
| `packages/eslint-config/test/eslint.web-boundaries.config.js` | Fixture proving each web boundary rejects                                  |
| `apps/web/package.json`                                       | Pins, scripts                                                              |
| `apps/web/tsconfig.json`                                      | Extends `@metrika/typescript-config/next.json`                             |
| `apps/web/next.config.ts`                                     | Next configuration; `next-intl` plugin                                     |
| `apps/web/eslint.config.js`                                   | Composes the profiles; the `process.env` and `'use server'` escape hatches |
| `apps/web/src/config/env.ts`                                  | The only `process.env` reader; server half and client half                 |
| `apps/web/src/lib/formatting/money.ts`                        | `formatMoney` — exponent-driven, string-fed, never a float                 |
| `apps/web/src/lib/formatting/units.ts`                        | `formatLengthMm`, `formatMassG`, `formatDurationS`                         |
| `apps/web/src/i18n/routing.ts`                                | Locale list, default locale                                                |
| `apps/web/src/i18n/request.ts`                                | `next-intl` server config                                                  |
| `apps/web/messages/es-CO.json`                                | The shipped catalogue                                                      |
| `apps/web/messages/en-US.json`                                | Scaffolded, structurally identical                                         |
| `apps/web/src/app/layout.tsx`                                 | Root layout — html/body, fonts, providers                                  |
| `apps/web/src/app/page.tsx`                                   | The shell page                                                             |
| `apps/web/src/app/globals.css`                                | Tailwind entry + design tokens                                             |
| `apps/web/src/components/ui/**`                               | shadcn copy-in components                                                  |
| `apps/web/test/**`                                            | Vitest unit tests                                                          |
| `apps/web/e2e/**`                                             | Playwright specs                                                           |
| `.github/workflows/ci.yml` (modify)                           | The `web` job                                                              |

---

### Task 1: The stack spike, and the ADR that records it

`docs/ARCHITECTURE.md:279` names **Next.js 15**. The current major is **16**. This repository has already had one recorded framework decision fail its own spike gate — ADR-0009 chose ts-rest, and the spike found it pinned to Zod 3 internals with no publish in fourteen months, which is why ADR-0019 exists. Do not repeat that shape by pinning a version and discovering the incompatibility three tasks later.

Nothing in this task ships in `apps/web`. It produces a measurement and a decision.

**Files:**

- Create: `docs/adr/0021-next-major-and-frontend-stack.md`
- Modify: `docs/adr/README.md`, `docs/ARCHITECTURE.md` (the Next version reference)
- Test: none — the deliverable is a measurement, recorded

**Interfaces:**

- Consumes: nothing
- Produces: **the exact pin for every package Tasks 2–6 install**, written into ADR-0021 as a table — `next`, `react`, `react-dom`, `@types/react`, `@types/react-dom`, `next-intl`, `tailwindcss`, `@tailwindcss/postcss`, `eslint-config-next`, `eslint-plugin-react`, `eslint-plugin-react-hooks`, `eslint-plugin-jsx-a11y`, `clsx`, `tailwind-merge`, `@playwright/test`. Later tasks write `<pin>` wherever a version appears; that placeholder means "read ADR-0021's table", never "choose one now".

- [ ] **Step 1: Create a throwaway spike directory outside the workspace**

The spike must not be a workspace member — a failed spike would otherwise leave `pnpm install` broken for the whole repo.

```bash
SPIKE=$(mktemp -d)
echo "SPIKE=$SPIKE"
cd "$SPIKE"
```

- [ ] **Step 2: Record what the registry actually offers**

Do not trust the numbers in this plan — they were read while it was written and may have moved.

```bash
for p in next react react-dom @types/react @types/react-dom \
         next-intl tailwindcss @tailwindcss/postcss \
         eslint-config-next eslint-plugin-react eslint-plugin-react-hooks eslint-plugin-jsx-a11y \
         clsx tailwind-merge @playwright/test; do
  echo "$p: $(npm view "$p" version)"
done
```

Write the output into ADR-0021's table in Step 7. Every package Tasks 2–6 install appears in this list — a pin decided ad hoc in a later task is a pin nobody reviewed.

- [ ] **Step 3: Check peer ranges before installing anything**

This is the step that catches the failure mode this repo has already hit twice. `pnpm` will install a package whose peer range excludes the installed version and merely warn; the tool then silently degrades. Task 1 of Plan 0A found TypeScript resolving to a version outside `typescript-eslint`'s peer range, which disabled **all** type-aware linting with no error.

```bash
npm view next@latest peerDependencies --json
npm view next-intl@latest peerDependencies --json
npm view eslint-config-next@latest peerDependencies --json
npm view @tailwindcss/postcss@latest peerDependencies --json
```

For each, answer in writing: does the range include React 19, ESLint **10.8.0**, and TypeScript **6.0.3**? An excluded range is a spike failure for that component, not a warning to ignore.

- [ ] **Step 4: Build the spike app**

```bash
cd "$SPIKE"
cat > package.json <<'JSON'
{
  "name": "spike-web",
  "private": true,
  "type": "module",
  "scripts": { "build": "next build", "lint": "eslint ." }
}
JSON
pnpm add next react react-dom next-intl
pnpm add -D typescript@6.0.3 eslint@10.8.0 eslint-config-next @types/react @types/react-dom tailwindcss @tailwindcss/postcss
echo "INSTALL_EXIT=$?"
```

Capture the exit code from `$?` directly. Record every peer warning `pnpm` prints — those are the finding, not noise.

- [ ] **Step 5: Prove the four integrations actually compose**

A spike that only proves `next build` exits 0 proves almost nothing. Each of these has to be exercised:

```bash
mkdir -p src/app src/i18n messages
cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "preserve",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "incremental": true,
    "plugins": [{ "name": "next" }]
  },
  "include": ["**/*.ts", "**/*.tsx", ".next/types/**/*.ts"]
}
JSON

cat > postcss.config.mjs <<'JS'
export default { plugins: { '@tailwindcss/postcss': {} } };
JS

cat > src/app/globals.css <<'CSS'
@import 'tailwindcss';
CSS

cat > messages/es-CO.json <<'JSON'
{ "spike": { "greeting": "Hola" } }
JSON

cat > src/i18n/request.ts <<'TS'
import { getRequestConfig } from 'next-intl/server';

export default getRequestConfig(async () => ({
  locale: 'es-CO',
  messages: (await import('../../messages/es-CO.json')).default,
}));
TS

cat > next.config.ts <<'TS'
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');
export default withNextIntl({});
TS

cat > src/app/layout.tsx <<'TSX'
import './globals.css';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  return (
    <html lang={locale}>
      <body className="bg-white text-slate-900">
        <NextIntlClientProvider messages={messages}>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
TSX

cat > src/app/page.tsx <<'TSX'
import { getTranslations } from 'next-intl/server';

export default async function Page() {
  const t = await getTranslations('spike');
  return <main className="p-8 text-2xl font-bold">{t('greeting')}</main>;
}
TSX

cat > eslint.config.js <<'JS'
import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';

export default [
  ...coreWebVitals,
  ...typescript,
  // `eslint-config-next` sets `settings.react.version: 'detect'`, and
  // eslint-plugin-react's detect path calls `context.getFilename()`, removed
  // in ESLint 10 — ESLint exits 2 without this. Pin to the React version in
  // apps/web/package.json.
  { settings: { react: { version: '19.2.8' } } },
];
JS
```

These two specifiers and the `settings.react.version` pin are what the spike measured; `eslint-config-next/flat` does **not** exist and throws `ERR_PACKAGE_PATH_NOT_EXPORTED`. If the exports map has moved again, inspect it (`node -e "console.log(require('eslint-config-next/package.json').exports)"`) and record the real names — Task 2 consumes them.

- [ ] **Step 6: Run the gates and record every exit code**

```bash
cd "$SPIKE"
pnpm exec tsc --noEmit; echo "TSC_EXIT=$?"
pnpm build > build.log 2>&1; echo "BUILD_EXIT=$?"
pnpm exec eslint . > lint.log 2>&1; echo "LINT_EXIT=$?"
grep -c 'Hola' build.log || true
```

Required for a pass: `TSC_EXIT=0`, `BUILD_EXIT=0`, `LINT_EXIT` is 0 **or** a real finding (a crash or a "config invalid" error is a failure, a legitimate lint complaint about the spike source is not).

Then prove Tailwind actually processed, rather than the class attribute merely surviving into the HTML:

```bash
find .next -name '*.css' -exec grep -l 'padding' {} + | head -1
```

An empty result means the PostCSS plugin did not run — a Tailwind failure, even though `next build` exited 0.

- [ ] **Step 7: Write ADR-0021**

`docs/adr/0021-next-major-and-frontend-stack.md`. Use the exact structure of the existing ADRs (`Status` / `Context` / `Decision` / `Alternatives` / `Consequences`) — read `docs/adr/0019-nestjs-zod-contracts.md` for the house style.

The ADR must contain:

- The version table from Step 2, with the date measured.
- The peer-range answers from Step 3, quoted.
- The exit codes from Step 6, and the Tailwind CSS-output check.
- The decision: which Next major, and why.
- **A stated fallback**, in the shape ADR-0009 used and Task 12a of Plan 0B-1 was able to execute: if the chosen major fails on any of the four integrations, pin the previous major and name the specific measurement that would justify revisiting.
- Whatever did **not** work. A spike that reports unqualified success is the one to distrust — record the peer warnings even where they turned out to be benign.

- [ ] **Step 8: Reconcile `ARCHITECTURE.md`**

`docs/ARCHITECTURE.md:279` says `# Next.js 15 App Router`. Update it to whatever Step 7 decided, and add the ADR-0021 row to `docs/adr/README.md` in numeric order.

- [ ] **Step 9: Destroy the spike and commit**

```bash
rm -rf "$SPIKE"
```

The spike directory must not be committed and must not appear in the workspace.

```bash
git add docs/adr/0021-next-major-and-frontend-stack.md docs/adr/README.md docs/ARCHITECTURE.md
git commit -m "docs(adr): pin the frontend stack against a measured spike"
```

---

### Task 2: The `react` and `next` ESLint profiles

ROADMAP 0.3 lists these profiles as part of `packages/eslint-config` and defers them to "the plan that adds `apps/web`". This is that plan.

`packages/eslint-config` already has a fixture-test convention: each profile has a config in `test/` and a test that runs ESLint against deliberately-bad source and asserts the specific rule fires. Read `packages/eslint-config/test/eslint.boundaries.config.js` and its test before writing anything — a profile without a fixture asserting rejection is an intention, not a control.

**Files:**

- Create: `packages/eslint-config/src/react.js`, `packages/eslint-config/src/next.js`, `packages/eslint-config/test/eslint.react.config.js`, `packages/eslint-config/test/eslint.next.config.js`, `packages/eslint-config/test/react.test.ts`
- Modify: `packages/eslint-config/src/index.js`, `packages/eslint-config/package.json`
- Test: `packages/eslint-config/test/react.test.ts`

**Interfaces:**

- Consumes: Task 1's ADR-0021 for the `eslint-config-next` pin and its real flat-config export name
- Produces:
  - `react(options: { tsconfigRootDir: string; project: string }): FlatConfig[]`
  - `next(options: { tsconfigRootDir: string; project: string; reactVersion: string }): FlatConfig[]` — composes `react`. `reactVersion` is required and must equal `apps/web`'s `react` pin; it is what stops ESLint exiting 2 (ADR-0021 obligation 3).
  - both exported from `@metrika/eslint-config`

- [ ] **Step 1: Add the dependencies at the pins ADR-0021 recorded**

```bash
pnpm --filter @metrika/eslint-config add \
  eslint-plugin-react@<pin> \
  eslint-plugin-react-hooks@<pin> \
  eslint-plugin-jsx-a11y@<pin> \
  eslint-config-next@<pin>
```

Exact versions from ADR-0021's table. No ranges.

- [ ] **Step 2: Write the failing fixture test**

`packages/eslint-config/test/react.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import reactConfig from './eslint.react.config.js';
import nextConfig from './eslint.next.config.js';

async function run(config: unknown, code: string, filename: string): Promise<string[]> {
  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: config as never });
  const [result] = await eslint.lintText(code, { filePath: filename });
  return (result?.messages ?? []).map((m) => m.ruleId ?? '(fatal)');
}

const lint = (code: string, filename: string) => run(reactConfig, code, filename);
const lintWithNext = (code: string, filename: string) => run(nextConfig, code, filename);

describe('the react profile', () => {
  it('rejects a conditional hook call', async () => {
    const rules = await lint(
      `export function C({ on }: { on: boolean }) {
         if (on) { const [v] = React.useState(0); return <p>{v}</p>; }
         return null;
       }`,
      'src/C.tsx',
    );
    expect(rules).toContain('react-hooks/rules-of-hooks');
  });

  it('rejects an image without alt text', async () => {
    const rules = await lint(`export const C = () => <img src="/a.png" />;`, 'src/C.tsx');
    expect(rules).toContain('jsx-a11y/alt-text');
  });

  it('does not require React to be in scope — the automatic runtime is on', async () => {
    const rules = await lint(`export const C = () => <p>ok</p>;`, 'src/C.tsx');
    expect(rules).not.toContain('react/react-in-jsx-scope');
  });

  it('accepts a correct component', async () => {
    const rules = await lint(
      `export const C = ({ label }: { label: string }) => <button type="button">{label}</button>;`,
      'src/C.tsx',
    );
    expect(rules).toEqual([]);
  });
});

/**
 * ADR-0021 obligation 3. `eslint-config-next` depends on eslint-plugin-react,
 * whose peer range excludes ESLint 10 and which has not published in 16
 * months; its `settings.react.version: 'detect'` path calls
 * `context.getFilename()`, removed in ESLint 10. The `next` profile overrides
 * that setting, and this block is what proves the override left the rules
 * REPORTING rather than merely stopping the crash.
 *
 * The distinction is not hypothetical here. Plan 0A shipped a config where
 * TypeScript resolved outside typescript-eslint's peer range and every
 * type-aware rule silently stopped running, with no error and a green build.
 * A test asserting the config loads would have passed throughout.
 */
describe('the next profile, against ADR-0021 obligation 3', () => {
  it('does not exit non-zero merely by loading', async () => {
    await expect(lintWithNext(`export const C = () => <p>ok</p>;`, 'src/C.tsx')).resolves.toEqual(
      [],
    );
  });

  it('still reports react/display-name — the rule whose detect path crashes', async () => {
    // Named specifically: this is the rule that throws under ESLint 10 without
    // the settings override, so it is the one whose silence would mean the
    // workaround masked the problem instead of fixing it.
    const rules = await lintWithNext(
      `export const C = () => { const Inner = () => <p>x</p>; return <Inner />; };`,
      'src/C.tsx',
    );
    expect(rules).toContain('react/display-name');
  });

  it('still reports react/jsx-key', async () => {
    const rules = await lintWithNext(
      `export const C = () => <>{[1, 2].map((n) => <li>{n}</li>)}</>;`,
      'src/C.tsx',
    );
    expect(rules).toContain('react/jsx-key');
  });
});
```

The last two matter as much as the first two. A profile that fires on everything is as useless as one that fires on nothing, and `react/react-in-jsx-scope` firing under the automatic JSX runtime is the single most common misconfiguration of this profile.

- [ ] **Step 3: Run it and watch it fail**

```bash
pnpm --filter @metrika/eslint-config test:unit; echo "EXIT=$?"
```

Expected: **non-zero**, `Cannot find module './eslint.react.config.js'`.

- [ ] **Step 4: Write `src/react.js`**

```js
import js from '@eslint/js';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import tseslint from 'typescript-eslint';

/**
 * Framework-agnostic React rules. `next()` composes this; nothing here may
 * import or assume Next, so a future package (packages/ui) can take this
 * profile without dragging a framework in.
 */
export const react = ({ tsconfigRootDir, project }) => [
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project,
        tsconfigRootDir,
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      react,
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,

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
```

Note: the exact rule-set accessor (`react.configs.flat.recommended`, `jsxA11y.flatConfigs.recommended`) differs between plugin majors. Verify against the versions ADR-0021 pinned before assuming these names — `node -e "import('eslint-plugin-react').then(m => console.log(Object.keys(m.default.configs)))"`.

- [ ] **Step 5: Write the two fixture configs**

`packages/eslint-config/test/eslint.react.config.js`:

```js
import { react } from '../src/react.js';

export default react({
  tsconfigRootDir: import.meta.dirname,
  project: './tsconfig.json',
});
```

`packages/eslint-config/test/eslint.next.config.js` — the obligation-3 fixture's
subject. `reactVersion` must be the same literal as `apps/web`'s `react` pin:

```js
import { next } from '../src/next.js';

export default next({
  tsconfigRootDir: import.meta.dirname,
  project: './tsconfig.json',
  reactVersion: '<pin>',
});
```

- [ ] **Step 6: Run the test and watch it pass**

```bash
pnpm --filter @metrika/eslint-config test:unit; echo "EXIT=$?"
```

Expected: **0**, four tests passing.

- [ ] **Step 7: Mutation — prove the fixture is not decorative**

Delete `'react/react-in-jsx-scope': 'off'` from `src/react.js`.

```bash
pnpm --filter @metrika/eslint-config test:unit; echo "EXIT=$?"
```

Expected: **non-zero** — `does not require React to be in scope` and `accepts a correct component` both fail. Restore.

Then delete the `'react-hooks': reactHooks` plugin registration and confirm the conditional-hook test fails. Restore.

If either mutation leaves the suite green, the fixture is not exercising the profile — say so and fix it before continuing.

- [ ] **Step 8: Write `src/next.js`**

```js
import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';
import { react } from './react.js';

/**
 * `react` plus Next's own rules and the App Router's constraints.
 *
 * Two entry points, measured by ADR-0021's spike: `eslint-config-next/flat`
 * does not exist and throws ERR_PACKAGE_PATH_NOT_EXPORTED. Both default-export
 * arrays of config objects.
 *
 * The `settings` block LAST is load-bearing, not cosmetic. `eslint-config-next`
 * sets `react.version: 'detect'`, and eslint-plugin-react's detect path calls
 * `context.getFilename()` — removed in ESLint 10 — so ESLint exits 2 before
 * linting anything. Overriding it after the shared config is what makes the
 * React rules run at all. The version string must track apps/web's react pin.
 * See ADR-0021 obligation 3, and the fixture in Step 2 that proves the rules
 * still report rather than merely that the config loads.
 */
export const next = ({ tsconfigRootDir, project, reactVersion }) => [
  ...react({ tsconfigRootDir, project }),
  ...coreWebVitals,
  ...typescript,
  { settings: { react: { version: reactVersion } } },
];
```

- [ ] **Step 9: Export both, and confirm the whole package still passes**

`packages/eslint-config/src/index.js` gains:

```js
export { react } from './react.js';
export { next } from './next.js';
```

```bash
pnpm verify; echo "EXIT=$?"
```

Expected: **0**.

- [ ] **Step 10: Commit**

```bash
git add packages/eslint-config
git commit -m "feat(eslint-config): add the react and next profiles with rejection fixtures"
```

---

### Task 3: `apps/web` scaffold and the two-halved environment

This task ends with a package that installs, builds, lints, type-checks and has a green unit suite. No UI, no styling, no i18n — those are Tasks 4 and 5.

**Files:**

- Create: `apps/web/package.json`, `tsconfig.json`, `next.config.ts`, `eslint.config.js`, `vitest.config.ts`, `src/config/env.ts`, `src/app/layout.tsx`, `src/app/page.tsx`
- Modify: `.env.example`
- Test: `apps/web/test/env.test.ts`

**Interfaces:**

- Consumes: Task 1 (pins), Task 2 (`next` profile)
- Produces:
  - `ServerEnvSchema` / `type ServerEnv` / `parseServerEnv(source: Record<string, string | undefined>): ServerEnv`
  - `ClientEnvSchema` / `type ClientEnv` / `clientEnv: ClientEnv` — a **module-level constant**, not a function, for the reason in Step 4
  - `EnvValidationError`

- [ ] **Step 1: Write the failing env tests**

`apps/web/test/env.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseServerEnv } from '../src/config/env.js';

const VALID = {
  NEXT_PUBLIC_API_BASE_URL: 'http://localhost:3001',
  NEXT_PUBLIC_DEFAULT_LOCALE: 'es-CO',
} as const;

describe('parseServerEnv', () => {
  it('applies defaults for the optional keys', () => {
    const env = parseServerEnv({ ...VALID });
    expect(env.NODE_ENV).toBe('development');
    expect(env.WEB_PORT).toBe(3000);
  });

  it('coerces WEB_PORT from its string form', () => {
    expect(parseServerEnv({ ...VALID, WEB_PORT: '4000' }).WEB_PORT).toBe(4000);
  });

  it('rejects a missing NEXT_PUBLIC_API_BASE_URL and names it', () => {
    const { NEXT_PUBLIC_DEFAULT_LOCALE } = VALID;
    expect(() => parseServerEnv({ NEXT_PUBLIC_DEFAULT_LOCALE })).toThrow(EnvValidationError);
    expect(() => parseServerEnv({ NEXT_PUBLIC_DEFAULT_LOCALE })).toThrow(
      /NEXT_PUBLIC_API_BASE_URL/,
    );
  });

  it('rejects an API base URL that is not http(s)', () => {
    expect(() => parseServerEnv({ ...VALID, NEXT_PUBLIC_API_BASE_URL: 'ftp://x/y' })).toThrow(
      /NEXT_PUBLIC_API_BASE_URL/,
    );
  });

  it('rejects a locale outside the supported set', () => {
    expect(() => parseServerEnv({ ...VALID, NEXT_PUBLIC_DEFAULT_LOCALE: 'fr-FR' })).toThrow(
      /NEXT_PUBLIC_DEFAULT_LOCALE/,
    );
  });

  it('reports every problem at once, not just the first', () => {
    try {
      parseServerEnv({});
      expect.unreachable('parseServerEnv should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as Error).message).toContain('NEXT_PUBLIC_API_BASE_URL');
      expect((error as Error).message).toContain('NEXT_PUBLIC_DEFAULT_LOCALE');
    }
  });
});
```

- [ ] **Step 2: Write the test that pins the inlining rule**

This is the one that matters, and it is easy to get wrong. Next replaces the **literal text** `process.env.NEXT_PUBLIC_FOO` at build time. It does not replace `process.env` as an object — so `parseServerEnv(process.env)` works on the server and produces `undefined` for every public key in a client bundle. The split is not stylistic.

`apps/web/test/env-inlining.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(new URL('../src/config/env.ts', import.meta.url), 'utf8');

describe('the client half of the env module', () => {
  it('reads each NEXT_PUBLIC_ key by its full literal text', () => {
    // Next's build-time replacement is textual. `process.env[key]`,
    // `const e = process.env; e.NEXT_PUBLIC_X`, and object spread all survive
    // typecheck, pass every server-side test, and yield undefined in the
    // browser bundle. The literal form is the only one that is replaced.
    expect(SOURCE).toContain('process.env.NEXT_PUBLIC_API_BASE_URL');
    expect(SOURCE).toContain('process.env.NEXT_PUBLIC_DEFAULT_LOCALE');
  });

  it('never reaches a NEXT_PUBLIC_ key through a computed member access', () => {
    expect(SOURCE).not.toMatch(/process\.env\[/);
  });
});
```

- [ ] **Step 3: Run both and watch them fail**

```bash
pnpm --filter @metrika/web --fail-if-no-match test:unit; echo "EXIT=$?"
```

Expected: **non-zero** — the package does not exist yet.

`--fail-if-no-match` is not optional here. Without it pnpm prints
`No projects matched the filters` and exits **0**, so the "watch it fail" step
would pass while proving nothing — measured.

- [ ] **Step 4: Write `src/config/env.ts`**

```ts
import { z } from 'zod';

export const SUPPORTED_LOCALES = ['es-CO', 'en-US'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

const PublicKeys = {
  NEXT_PUBLIC_API_BASE_URL: z
    .string()
    .regex(/^https?:\/\//, 'must be an http:// or https:// URL'),
  NEXT_PUBLIC_DEFAULT_LOCALE: z.enum(SUPPORTED_LOCALES),
};

export const ClientEnvSchema = z.object(PublicKeys);
export type ClientEnv = z.infer<typeof ClientEnvSchema>;

export const ServerEnvSchema = z.object({
  ...PublicKeys,
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  WEB_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});
export type ServerEnv = z.infer<typeof ServerEnvSchema>;

export class EnvValidationError extends Error {
  constructor(issues: readonly z.core.$ZodIssue[]) {
    super(
      [
        'Environment configuration is invalid. Every problem, not just the first:',
        ...issues.map((issue) => {
          const path = issue.path.join('.');
          return `  ${path !== '' ? path : '(root)'}: ${issue.message}`;
        }),
        '',
        'Copy .env.example to .env and fill in the values it names.',
      ].join('\n'),
    );
    this.name = 'EnvValidationError';
  }
}

/** Pure, so it can be unit-tested without touching the ambient environment. */
export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const result = ServerEnvSchema.safeParse(source);
  if (!result.success) throw new EnvValidationError(result.error.issues);
  return result.data;
}

export function loadServerEnv(): ServerEnv {
  return parseServerEnv(process.env);
}

/**
 * Each key is read by its FULL LITERAL TEXT, and the object is built by hand.
 *
 * Next's `NEXT_PUBLIC_` support is a textual substitution performed at build
 * time on the exact string `process.env.NEXT_PUBLIC_WHATEVER`. Any indirection
 * — `process.env[key]`, destructuring `process.env`, spreading it, aliasing it
 * to a local — is not substituted, type-checks cleanly, passes every
 * server-side test, and evaluates to `undefined` in the browser. A loop over
 * `SUPPORTED_PUBLIC_KEYS` would be tidier and would silently ship a broken
 * client bundle.
 *
 * Parsed at module scope so a misconfigured deployment fails at build, not on
 * a user's first render.
 */
export const clientEnv: ClientEnv = ClientEnvSchema.parse({
  NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
  NEXT_PUBLIC_DEFAULT_LOCALE: process.env.NEXT_PUBLIC_DEFAULT_LOCALE,
});
```

- [ ] **Step 5: Write the package files**

`apps/web/package.json` — versions from ADR-0021:

```json
{
  "name": "@metrika/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "next build",
    "typecheck": "tsc -b --force",
    "lint": "eslint .",
    "start": "next start --port ${WEB_PORT:-3000}",
    "dev": "next dev --port ${WEB_PORT:-3000}",
    "test:unit": "vitest run --config vitest.config.ts",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "@metrika/contracts": "workspace:*",
    "next": "<pin>",
    "next-intl": "<pin>",
    "react": "<pin>",
    "react-dom": "<pin>",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@metrika/eslint-config": "workspace:*",
    "@metrika/typescript-config": "workspace:*",
    "@types/node": "24.13.3",
    "@types/react": "<pin>",
    "@types/react-dom": "<pin>",
    "eslint": "10.8.0",
    "typescript": "6.0.3",
    "vitest": "4.1.10"
  }
}
```

`apps/web/tsconfig.json`:

```json
{
  "extends": "@metrika/typescript-config/next.json",
  "include": ["src/**/*.ts", "src/**/*.tsx", "test/**/*.ts", "vitest.config.ts", "next.config.ts", ".next/types/**/*.ts"],
  "exclude": ["node_modules", ".next"]
}
```

`apps/web/eslint.config.js`:

```js
import { next, typeChecked } from '@metrika/eslint-config';

export default [
  // ORDER IS LOAD-BEARING, and `next()` alone is not enough.
  //
  // `next()` composes `react()`, which starts from `js.configs.recommended`
  // rather than this repo's `base`. On its own it resolves 156 rules against a
  // .tsx file; `nest()` — what apps/api gets — resolves 123, and 55 of those
  // are ABSENT under `next()` alone. Not just the type-aware set:
  // `no-restricted-properties` (the CLAUDE.md process.env ban),
  // `no-console` and `eqeqeq` are all OFF, and
  // `reportUnusedDisableDirectives` drops from error to warn. MEASURED.
  // Composing `typeChecked()` restores all 55 and takes the total to 210.
  //
  // `next()` FIRST. `eslint-config-next/typescript` sets
  // `@typescript-eslint/no-unused-vars: 'warn'` — severity only, so ESLint 10
  // preserves typeChecked()'s `^_` ignore patterns either way — but putting it
  // last still downgrades that rule and `no-unused-expressions` from error to
  // warn, and re-enables `no-unexpected-multiline` against
  // eslint-config-prettier. The downgrade is INVISIBLE LOCALLY: `pnpm verify`
  // runs `turbo run lint` with no `--max-warnings`, while CI passes
  // `--max-warnings=0`. See the ordering fixture in packages/eslint-config.
  ...next({
    // Must equal the `react` pin in this package.json. `eslint-config-next`
    // sets 'detect', whose code path calls an ESLint 9 API that ESLint 10
    // removed — ESLint exits 2 before linting a single file. See ADR-0021.
    reactVersion: '<pin>',
  }),
  ...typeChecked({ tsconfigRootDir: import.meta.dirname, project: './tsconfig.json' }),
  {
    // The one sanctioned process.env reader, per CLAUDE.md. Everything else in
    // the app takes configuration through the exports of this module.
    //
    // This exemption is only meaningful because `typeChecked()` above turns
    // `no-restricted-properties` ON. Under `next()` alone the rule is off for
    // the whole app and this block would exempt nothing while reading as
    // enforcement — which is worse than having no exemption at all.
    files: ['src/config/env.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  { ignores: ['.next/**', 'coverage/**', 'playwright-report/**'] },
];
```

- [ ] **Step 5b: Prove the boundary is actually enforced, not merely configured**

The block above is exactly the shape that has already shipped twice in this
repo asserting a control that did not exist. Verify it rather than trusting it:

```bash
cat > apps/web/src/probe-env.ts <<'TS'
export const leaked = process.env.NEXT_PUBLIC_API_BASE_URL;
TS
pnpm --filter @metrika/web lint; echo "PROBE_EXIT=$?"
rm apps/web/src/probe-env.ts
```

Expected: **non-zero**, `no-restricted-properties`. If it exits 0, `typeChecked()`
is not composed and the exemption below it is decorative.

- [ ] **Step 5c: Pin the composition ORDER, which the probe above cannot see**

`packages/eslint-config`'s fixtures pin the ordering property inside that
package; they never read `apps/web/eslint.config.js`. And Step 5b does not cover
it either — `no-restricted-properties` is **not** among the three rules that
differ between the two orders, so it resolves identically and the probe passes
whichever way round the composition is. Measured: exactly three rules change,
and that is the only signal.

`apps/web/test/eslint-order.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

/**
 * `next()` must come BEFORE `typeChecked()`. Reversed, `eslint-config-next`'s
 * bare `'warn'` for these two rules wins on severity and they drop from error
 * to warning — which `pnpm verify` cannot see, because it runs `turbo run lint`
 * with no `--max-warnings`, while CI passes `--max-warnings=0`. The failure
 * would therefore be invisible locally and red only in CI.
 *
 * Resolved config, not a lint run: this asserts the property directly rather
 * than hoping some file happens to trip the rule.
 */
describe('apps/web eslint composition', () => {
  it('keeps no-unused-vars an error, which reversing the order would not', async () => {
    const eslint = new ESLint({ cwd: new URL('..', import.meta.url).pathname });
    const config = await eslint.calculateConfigForFile('src/app/page.tsx');
    expect(config.rules?.['@typescript-eslint/no-unused-vars']?.[0]).toBe(2);
  });

  it('keeps no-unused-expressions an error', async () => {
    const eslint = new ESLint({ cwd: new URL('..', import.meta.url).pathname });
    const config = await eslint.calculateConfigForFile('src/app/page.tsx');
    expect(config.rules?.['@typescript-eslint/no-unused-expressions']?.[0]).toBe(2);
  });
});
```

Prove it: swap the two spreads in `apps/web/eslint.config.js`, confirm the suite
exits non-zero, and restore.

`apps/web/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
```

`apps/web/next.config.ts` — bare for now; Task 5 adds the `next-intl` plugin:

```ts
import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // `pnpm verify` must fail on a type error or a lint finding rather than
  // letting `next build` skip its own checks. These are Next's defaults today;
  // they are stated so a future `ignoreBuildErrors` is a visible edit.
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: false },
};

export default config;
```

Minimal `src/app/layout.tsx` and `src/app/page.tsx` so `next build` has a route — Task 6 replaces both:

```tsx
// src/app/layout.tsx
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-CO">
      <body>{children}</body>
    </html>
  );
}
```

```tsx
// src/app/page.tsx
export default function Page() {
  return <main>Metrika</main>;
}
```

- [ ] **Step 6: Add the new keys to `.env.example`**

Read the existing file first and match its comment style. Both new keys need a line saying what they are and that `NEXT_PUBLIC_` means _this value is compiled into the browser bundle and is public_ — never put a secret behind that prefix.

- [ ] **Step 7: Install and run everything**

```bash
pnpm install; echo "INSTALL_EXIT=$?"
pnpm --filter @metrika/web test:unit; echo "UNIT_EXIT=$?"
pnpm verify; echo "VERIFY_EXIT=$?"
```

Expected: all **0**.

- [ ] **Step 8: Mutation — prove the inlining test bites**

In `src/config/env.ts`, replace the hand-built object with the tidier version that does not work:

```ts
export const clientEnv: ClientEnv = ClientEnvSchema.parse(process.env);
```

```bash
pnpm --filter @metrika/web test:unit; echo "EXIT=$?"
```

Expected: **non-zero** — both inlining assertions fail. Restore.

- [ ] **Step 9: Commit**

```bash
git add apps/web .env.example
git commit -m "feat(web): add the Next scaffold and the Zod-validated environment"
```

---

### Task 4: Tailwind, the design tokens, and shadcn init

**Files:**

- Create: `apps/web/postcss.config.mjs`, `apps/web/src/app/globals.css`, `apps/web/components.json`, `apps/web/src/lib/cn.ts`, `apps/web/src/components/ui/button.tsx`
- Modify: `apps/web/package.json`, `apps/web/src/app/layout.tsx`
- Test: `apps/web/test/tailwind-build.test.ts`

**Interfaces:**

- Consumes: Task 3
- Produces: `cn(...inputs: ClassValue[]): string`; the `Button` component; the token names in `globals.css`

- [ ] **Step 1: Write the failing build test**

A test asserting a class name appears in the HTML proves nothing — an unprocessed `className` survives into the markup untouched. The assertion has to be that Tailwind **emitted CSS**.

`apps/web/test/tailwind-build.test.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('..', import.meta.url).pathname;

describe('the Tailwind pipeline', () => {
  it('emits a stylesheet containing the utilities the shell uses', () => {
    execFileSync('pnpm', ['exec', 'next', 'build'], { cwd: ROOT, stdio: 'pipe' });

    const cssDir = join(ROOT, '.next', 'static', 'css');
    const sheets = readdirSync(cssDir)
      .filter((f) => f.endsWith('.css'))
      .map((f) => readFileSync(join(cssDir, f), 'utf8'));

    expect(sheets.length).toBeGreaterThan(0);
    const all = sheets.join('\n');

    // A rule body, not a class name: `.p-8{...}` proves the compiler ran,
    // whereas the string `p-8` also appears in an unprocessed className.
    expect(all).toMatch(/\.p-8\s*\{[^}]*padding/);
    // The custom token resolves, so the theme block is being read.
    expect(all).toContain('--color-brand');
  });
}, 180_000);
```

Note the 180 s timeout — this test runs a real production build. It belongs in the unit suite rather than integration because it needs no container, but it is the slowest test in the package; say so in a comment so nobody "optimises" it away.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @metrika/web test:unit; echo "EXIT=$?"
```

Expected: **non-zero** — no `.next/static/css` directory.

- [ ] **Step 3: Add Tailwind at ADR-0021's pins**

```bash
pnpm --filter @metrika/web add -D tailwindcss@<pin> @tailwindcss/postcss@<pin>
pnpm --filter @metrika/web add clsx@<pin> tailwind-merge@<pin>
```

`apps/web/postcss.config.mjs`:

```js
export default { plugins: { '@tailwindcss/postcss': {} } };
```

- [ ] **Step 4: Write `globals.css` with the tokens**

Tailwind 4 configures through CSS, not a JS config file.

```css
@import 'tailwindcss';

/*
 * Design tokens. Every colour the UI uses is named here; components reference
 * the token, never a raw hex. Restyling is then one edit in one file, which is
 * the whole reason shadcn is copy-in rather than a dependency.
 */
@theme {
  --color-brand: oklch(0.55 0.18 255);
  --color-brand-foreground: oklch(0.98 0 0);
  --color-surface: oklch(1 0 0);
  --color-surface-foreground: oklch(0.21 0.02 260);
  --color-muted: oklch(0.96 0.005 260);
  --color-muted-foreground: oklch(0.5 0.02 260);
  --color-danger: oklch(0.58 0.21 27);
  --radius-card: 0.75rem;
}

@media (prefers-color-scheme: dark) {
  @theme {
    --color-surface: oklch(0.19 0.02 260);
    --color-surface-foreground: oklch(0.97 0 0);
    --color-muted: oklch(0.27 0.02 260);
    --color-muted-foreground: oklch(0.72 0.02 260);
  }
}
```

- [ ] **Step 5: Write `src/lib/cn.ts`**

```ts
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * shadcn's class merge helper. `clsx` resolves conditionals; `twMerge` then
 * resolves Tailwind conflicts by precedence, so a caller's `p-2` beats a
 * component's default `p-4` instead of the pair both landing in the class
 * attribute and the winner being decided by stylesheet order.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 6: Initialise shadcn and add one component**

```bash
pnpm --filter @metrika/web dlx shadcn@latest init
pnpm --filter @metrika/web dlx shadcn@latest add button
```

The generator writes `components.json` and `src/components/ui/button.tsx`. **Read every generated file before committing it** — the CLI writes a `cn` helper, a tsconfig path alias and CSS variables of its own, and any of those may conflict with Steps 4 and 5. Reconcile by hand toward the token names in `globals.css`; do not keep two colour systems.

If the generator installs a dependency at a range rather than an exact version, pin it.

- [ ] **Step 7: Use the tokens in the shell so the build test has something to compile**

`src/app/layout.tsx` gains `import './globals.css';` and a `className` on `<body>` using `bg-surface text-surface-foreground`; `src/app/page.tsx` uses `p-8`.

- [ ] **Step 8: Run the test and watch it pass**

```bash
pnpm --filter @metrika/web test:unit; echo "EXIT=$?"
pnpm verify; echo "VERIFY_EXIT=$?"
```

Expected: both **0**.

- [ ] **Step 9: Mutation — prove the build test bites**

Rename `postcss.config.mjs` to `postcss.config.mjs.disabled` and rerun the unit suite.

```bash
mv apps/web/postcss.config.mjs apps/web/postcss.config.mjs.disabled
pnpm --filter @metrika/web test:unit; echo "EXIT=$?"
mv apps/web/postcss.config.mjs.disabled apps/web/postcss.config.mjs
```

Expected: **non-zero**. If `next build` still exits 0 and the test still passes, the assertion is reading a stale `.next` directory — delete it in the test before building, and record that you had to.

- [ ] **Step 10: Commit**

```bash
git add apps/web
git commit -m "feat(web): add Tailwind, the design tokens and the shadcn base"
```

---

### Task 5: `next-intl` with `es-CO`, and centralised formatting

The formatting module is the reason this task is not merely "add i18n". `Intl.NumberFormat` fed a float is how a COP amount renders as `$3,500.00` instead of `$350.000`, and that bug is unfixable once it is spread across forty components.

**Files:**

- Create: `apps/web/src/i18n/routing.ts`, `src/i18n/request.ts`, `messages/es-CO.json`, `messages/en-US.json`, `src/lib/formatting/money.ts`, `src/lib/formatting/units.ts`, `src/lib/formatting/index.ts`
- Modify: `apps/web/next.config.ts`, `src/app/layout.tsx`, `src/app/page.tsx`
- Test: `apps/web/test/formatting.test.ts`, `apps/web/test/messages.test.ts`

**Interfaces:**

- Consumes: Tasks 3, 4; `Money` from `@metrika/contracts`
- Produces:
  - `formatMoney(money: Money, locale: SupportedLocale): string`
  - `formatLengthMm(lengthMm: number, locale: SupportedLocale): string`
  - `formatMassG(massG: number, locale: SupportedLocale): string`
  - `formatDurationS(durationS: number): string` — **no locale parameter**, deliberately; see Step 6
  - `DEFAULT_LOCALE`, `SUPPORTED_LOCALES` from `src/i18n/routing.ts`

- [ ] **Step 1: Read the `Money` shape before writing anything against it**

```bash
sed -n '1,80p' packages/contracts/src/money.ts
```

`amountMinor` is a `bigint`; `exponent` travels with the amount; the schema deliberately does **not** cross-check the exponent against the currency registry, because pinning a stored value to today's registry would make an old quote unparseable. Formatting must honour the exponent it is given, not look one up.

- [ ] **Step 2: Write the failing formatting tests**

`apps/web/test/formatting.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatMoney, formatLengthMm, formatMassG, formatDurationS } from '../src/lib/formatting/index.js';

const cop = (amountMinor: bigint) => ({ amountMinor, currency: 'COP' as const, exponent: 2 });

describe('formatMoney', () => {
  it('renders COP with the exponent it was given', () => {
    // 350000 minor units at exponent 2 is 3 500,00 COP — NOT 350 000.
    expect(formatMoney(cop(350_000n), 'es-CO')).toMatch(/3[.\s]500,00/);
  });

  it('honours an exponent of 0 rather than assuming two decimals', () => {
    const whole = { amountMinor: 350_000n, currency: 'COP' as const, exponent: 0 };
    expect(formatMoney(whole, 'es-CO')).toMatch(/350[.\s]000/);
    expect(formatMoney(whole, 'es-CO')).not.toContain(',00');
  });

  it('renders a negative amount', () => {
    expect(formatMoney(cop(-350_000n), 'es-CO')).toContain('-');
  });

  it('renders zero without a sign', () => {
    expect(formatMoney(cop(0n), 'es-CO')).not.toContain('-');
  });

  it('is exact beyond Number.MAX_SAFE_INTEGER', () => {
    // 123456789012345678 minor units at exponent 2 is 1234567890123456.78.
    //
    // The float path loses this: Number(123456789012345678n) is
    // 123456789012345680, and dividing by 100 gives ...3456.8, which renders
    // with minor digits "80". The assertion below is the one that forbids the
    // float implementation — it fails on the minor digits, not on a separator.
    const huge = { amountMinor: 123_456_789_012_345_678n, currency: 'COP' as const, exponent: 2 };
    const formatted = formatMoney(huge, 'es-CO');
    expect(formatted).toMatch(/56,78$/);
    expect(formatted).not.toMatch(/56,80$/);
    expect(formatted).not.toContain('e+');
  });
});

describe('unit formatting', () => {
  it('formats a length in millimetres with its unit', () => {
    expect(formatLengthMm(125.5, 'es-CO')).toMatch(/125,5\s?mm/);
  });

  it('formats a mass in grams with its unit', () => {
    expect(formatMassG(48.25, 'es-CO')).toMatch(/48,25?\s?g/);
  });

  it('formats a duration as hours and minutes, not raw seconds', () => {
    expect(formatDurationS(5_400)).toBe('1 h 30 min');
  });

  it('formats a sub-hour duration without a leading zero hour', () => {
    expect(formatDurationS(600)).toBe('10 min');
  });
});
```

Run it once the implementation exists and correct the expected strings to whatever ICU actually produces for `es-CO` on Node 24 — do not guess the separator. The **shape** of each assertion is the requirement; the exact glyph is a measurement.

- [ ] **Step 3: Write the failing catalogue test**

`apps/web/test/messages.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import esCO from '../messages/es-CO.json' with { type: 'json' };
import enUS from '../messages/en-US.json' with { type: 'json' };

function keyPaths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([k, v]) => keyPaths(v, prefix ? `${prefix}.${k}` : k));
}

describe('message catalogues', () => {
  it('carry exactly the same key set', () => {
    // A key present in one locale and absent from the other is a runtime
    // MISSING_MESSAGE in production for whichever locale lacks it. Structural
    // equality is checkable now; translation quality is not.
    expect(keyPaths(enUS).sort()).toEqual(keyPaths(esCO).sort());
  });

  it('has no empty string values in the shipped locale', () => {
    const empties = keyPaths(esCO).filter((path) => {
      const v = path.split('.').reduce<unknown>((acc, k) => (acc as Record<string, unknown>)[k], esCO);
      return v === '';
    });
    expect(empties).toEqual([]);
  });
});
```

- [ ] **Step 4: Run both and watch them fail**

```bash
pnpm --filter @metrika/web test:unit; echo "EXIT=$?"
```

Expected: **non-zero**, module-not-found.

- [ ] **Step 5: Write `src/lib/formatting/money.ts`**

```ts
import type { Money } from '@metrika/contracts';
import type { SupportedLocale } from '../../config/env.js';

/**
 * Builds the decimal STRING the amount represents, then hands that string to
 * `Intl.NumberFormat`.
 *
 * `Intl.NumberFormat.prototype.format` accepts a string and formats it at
 * arbitrary precision (ECMA-402 "Intl.NumberFormat V3"). That is the whole
 * reason this function does not divide.
 *
 * The obvious implementation — `Number(amountMinor) / 10 ** exponent` — is
 * wrong twice over: it is a float, which this project forbids for money, and
 * it silently rounds above Number.MAX_SAFE_INTEGER. A quote total in COP
 * minor units reaches that range at roughly ninety trillion pesos, which is
 * absurd today and is exactly the kind of assumption that stops being absurd.
 */
function toDecimalString(amountMinor: bigint, exponent: number): string {
  const negative = amountMinor < 0n;
  const digits = (negative ? -amountMinor : amountMinor).toString();

  if (exponent === 0) return negative ? `-${digits}` : digits;

  const padded = digits.padStart(exponent + 1, '0');
  const whole = padded.slice(0, padded.length - exponent);
  const fraction = padded.slice(padded.length - exponent);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

export function formatMoney(money: Money, locale: SupportedLocale): string {
  const { amountMinor, currency, exponent } = money;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    // Driven by the amount's OWN exponent, never by the locale's default for
    // the currency and never by a registry lookup — a stored Money must render
    // the same way in ten years, after the registry has changed.
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(toDecimalString(amountMinor, exponent));
}
```

- [ ] **Step 6: Write `src/lib/formatting/units.ts`**

```ts
import type { SupportedLocale } from '../../config/env.js';

const decimal = (locale: SupportedLocale, maximumFractionDigits: number) =>
  new Intl.NumberFormat(locale, { maximumFractionDigits });

/** Millimetres, because every length in this system is millimetres. */
export function formatLengthMm(lengthMm: number, locale: SupportedLocale): string {
  return `${decimal(locale, 1).format(lengthMm)} mm`;
}

export function formatMassG(massG: number, locale: SupportedLocale): string {
  return `${decimal(locale, 2).format(massG)} g`;
}

/**
 * Locale-independent by design: "1 h 30 min" is what an operator reads off a
 * job card, and `Intl.DurationFormat` is not available everywhere this runs.
 * Seconds are never shown — a print time in seconds is unreadable and invites
 * false precision about an estimate.
 */
export function formatDurationS(durationS: number): string {
  const totalMinutes = Math.round(durationS / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  if (minutes === 0) return `${hours} h`;
  return `${hours} h ${minutes} min`;
}
```

And `src/lib/formatting/index.ts` re-exporting both modules.

- [ ] **Step 7: Wire `next-intl`**

`src/i18n/routing.ts`:

```ts
import { SUPPORTED_LOCALES, type SupportedLocale } from '../config/env.js';

export { SUPPORTED_LOCALES };
export type { SupportedLocale };

/**
 * `es-CO` is the only locale with real copy at MVP. `en-US` exists so the
 * catalogue structure is exercised from day one — retrofitting message
 * extraction across a built UI is far more expensive than this tax.
 */
export const DEFAULT_LOCALE: SupportedLocale = 'es-CO';
```

`src/i18n/request.ts`:

```ts
import { getRequestConfig } from 'next-intl/server';
import { DEFAULT_LOCALE } from './routing.js';

export default getRequestConfig(async () => {
  const locale = DEFAULT_LOCALE;
  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
```

`next.config.ts` gains the plugin:

```ts
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');
export default withNextIntl(config);
```

`messages/es-CO.json`:

```json
{
  "app": {
    "name": "Metrika",
    "tagline": "Cotizaciones de manufactura para modelos arquitectónicos impresos en 3D"
  },
  "shell": {
    "skipToContent": "Saltar al contenido"
  }
}
```

`messages/en-US.json` — the identical key set, English values.

- [ ] **Step 8: Run everything and correct the measured strings**

```bash
pnpm --filter @metrika/web test:unit; echo "EXIT=$?"
```

Where an assertion fails only on the separator glyph, print what ICU produced and fix the expectation. Where one fails on a _digit_, the implementation is wrong — do not adjust the expectation to match.

- [ ] **Step 9: Mutation — prove the money test forbids the float path**

Replace the body of `formatMoney` with the tempting version:

```ts
return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(
  Number(amountMinor) / 10 ** exponent,
);
```

```bash
pnpm --filter @metrika/web test:unit; echo "EXIT=$?"
```

Expected: **non-zero**, and specifically the `exponent of 0` and `beyond Number.MAX_SAFE_INTEGER` cases must both fail. If only one fails, the other assertion is not doing its job — strengthen it before restoring.

Then delete one key from `messages/en-US.json` and confirm the catalogue test goes red. Restore both.

- [ ] **Step 10: Commit**

```bash
git add apps/web
git commit -m "feat(web): add next-intl with es-CO and exponent-driven formatting"
```

---

### Task 6: The root layout, the shell, and a Playwright smoke test

**Files:**

- Create: `apps/web/playwright.config.ts`, `apps/web/e2e/shell.spec.ts`
- Modify: `apps/web/src/app/layout.tsx`, `src/app/page.tsx`, `apps/web/package.json`
- Test: `apps/web/e2e/shell.spec.ts`

**Interfaces:**

- Consumes: Tasks 3, 4, 5
- Produces: `pnpm --filter @metrika/web test:e2e`

- [ ] **Step 1: Write the failing Playwright spec**

`apps/web/e2e/shell.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

test('the shell renders localised copy in es-CO', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Metrika');
  // The tagline comes from the catalogue, so this fails if next-intl is not
  // actually resolving messages — a hardcoded string would pass regardless.
  await expect(page.getByText(/modelos arquitectónicos/i)).toBeVisible();
});

test('the document declares the es-CO locale', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'es-CO');
});

test('the skip link is the first focusable element', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: /saltar al contenido/i })).toBeFocused();
});

test('styles are applied, not merely referenced', async ({ page }) => {
  await page.goto('/');
  // A className present in the markup proves nothing; a computed background
  // proves the stylesheet loaded and the token resolved.
  const background = await page
    .locator('body')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(background).not.toBe('');
  expect(background).not.toBe('rgba(0, 0, 0, 0)');
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @metrika/web test:e2e; echo "EXIT=$?"
```

Expected: **non-zero** — Playwright is not installed.

- [ ] **Step 3: Install Playwright and configure it**

```bash
pnpm --filter @metrika/web add -D @playwright/test@<pin>
pnpm --filter @metrika/web exec playwright install --with-deps chromium
```

`apps/web/playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // A production build, not `next dev`: dev-mode behaviour differs enough on
  // hydration and CSS delivery that a green dev run is not evidence about
  // what ships.
  webServer: {
    command: 'pnpm build && pnpm start',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      NEXT_PUBLIC_API_BASE_URL: 'http://127.0.0.1:3001',
      NEXT_PUBLIC_DEFAULT_LOCALE: 'es-CO',
    },
  },
  use: { baseURL: 'http://127.0.0.1:3000' },
  forbidOnly: !!process.env.CI,
  retries: 0,
});
```

Zero retries deliberately: a retried e2e test hides flake, and this suite is small enough that flake should be fixed rather than absorbed.

- [ ] **Step 4: Write the real layout and page**

`src/app/layout.tsx`:

```tsx
import './globals.css';
import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('app');
  return { title: t('name'), description: t('tagline') };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  const t = await getTranslations('shell');

  return (
    <html lang={locale}>
      <body className="bg-surface text-surface-foreground antialiased">
        <NextIntlClientProvider messages={messages}>
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:rounded-md focus:bg-brand focus:px-4 focus:py-2 focus:text-brand-foreground"
          >
            {t('skipToContent')}
          </a>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
```

`src/app/page.tsx`:

```tsx
import { getTranslations } from 'next-intl/server';

export default async function Page() {
  const t = await getTranslations('app');
  return (
    <main id="main" className="mx-auto max-w-3xl p-8">
      <h1 className="text-4xl font-semibold tracking-tight">{t('name')}</h1>
      <p className="mt-3 text-muted-foreground">{t('tagline')}</p>
    </main>
  );
}
```

- [ ] **Step 5: Run the suite and watch it pass**

```bash
pnpm --filter @metrika/web test:e2e; echo "EXIT=$?"
pnpm verify; echo "VERIFY_EXIT=$?"
```

Expected: both **0**.

- [ ] **Step 6: Mutation — prove each spec bites**

Run each of these, confirm the expected failure, and restore before the next:

1. Replace `{t('tagline')}` with the literal Spanish string. Expected: the tagline test still passes (it cannot tell), **but** delete `messages/es-CO.json`'s `app.tagline` key and it must fail. Record which of the two mutations each assertion actually catches — this is the difference between testing the copy and testing the pipeline.
2. Remove the skip link. Expected: the focus test fails.
3. Remove `import './globals.css'`. Expected: the computed-background test fails.
4. Change `<html lang={locale}>` to `<html lang="en">`. Expected: the locale test fails.

If mutation 1 shows the tagline assertion cannot distinguish a hardcoded string from a resolved message, strengthen it — assert on a key that exists **only** in the catalogue, or assert the rendered text changes when the default locale changes.

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "feat(web): add the localised app shell and a Playwright smoke suite"
```

---

### Task 7: The boundary lint zones, each with a rejection fixture

Four rules, four fixtures. CLAUDE.md's boundary section is the specification; a rule without a fixture asserting rejection is an intention, not a control.

**Files:**

- Modify: `packages/eslint-config/src/boundaries.js`, `packages/eslint-config/src/index.js`, `apps/web/eslint.config.js`
- Create: `packages/eslint-config/test/eslint.web-boundaries.config.js`, `packages/eslint-config/test/web-boundaries.test.ts`
- Test: `packages/eslint-config/test/web-boundaries.test.ts`

**Interfaces:**

- Consumes: Task 2
- Produces: `webBoundary`, `serverActionBoundary`, `featureBoundary` from `@metrika/eslint-config`

- [ ] **Step 1: Read how the existing boundaries are written and tested**

```bash
cat packages/eslint-config/src/boundaries.js
cat packages/eslint-config/test/eslint.boundaries.config.js
```

Two details in that file are load-bearing and must be carried over: the profile sets `languageOptions.parser` directly so it works standalone rather than depending on being composed after `typeChecked()`, and `no-restricted-imports` only inspects static imports — a dynamic `import()` needs `no-restricted-syntax` with **two** selectors, because a template-literal specifier is not a `Literal` node.

- [ ] **Step 2: Write the failing fixture tests**

`packages/eslint-config/test/web-boundaries.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import config from './eslint.web-boundaries.config.js';

async function lint(code: string, filePath: string): Promise<string[]> {
  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: config });
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => m.ruleId ?? '(fatal)');
}

describe('webBoundary', () => {
  it('rejects importing @metrika/database', async () => {
    const rules = await lint(`import { x } from '@metrika/database';`, 'src/app/page.tsx');
    expect(rules).toContain('no-restricted-imports');
  });

  it('rejects importing @metrika/pricing-engine', async () => {
    const rules = await lint(`import { p } from '@metrika/pricing-engine';`, 'src/app/page.tsx');
    expect(rules).toContain('no-restricted-imports');
  });

  it('rejects a dynamic import of a forbidden package', async () => {
    const rules = await lint(`await import('@metrika/database');`, 'src/app/page.tsx');
    expect(rules).toContain('no-restricted-syntax');
  });

  it('rejects a dynamic import written with a template literal', async () => {
    // A TemplateLiteral is not a Literal node, so the selector that catches
    // the line above does not catch this one. Two selectors, or a hole.
    const rules = await lint('await import(`@metrika/database`);', 'src/app/page.tsx');
    expect(rules).toContain('no-restricted-syntax');
  });

  it('accepts @metrika/contracts', async () => {
    const rules = await lint(`import type { Money } from '@metrika/contracts';`, 'src/app/page.tsx');
    expect(rules).toEqual([]);
  });
});

describe('serverActionBoundary', () => {
  it("rejects 'use server' outside the two sanctioned locations", async () => {
    const rules = await lint(`'use server';\nexport async function f() {}`, 'src/app/thing.ts');
    expect(rules).toContain('no-restricted-syntax');
  });

  it("accepts 'use server' in an actions.ts file", async () => {
    const rules = await lint(
      `'use server';\nexport async function setLocale() {}`,
      'src/app/settings/actions.ts',
    );
    expect(rules).toEqual([]);
  });

  it("accepts 'use server' under src/lib/session", async () => {
    const rules = await lint(`'use server';\nexport async function f() {}`, 'src/lib/session/cookie.ts');
    expect(rules).toEqual([]);
  });
});

describe('featureBoundary', () => {
  it('rejects a deep import into another feature', async () => {
    const rules = await lint(
      `import { X } from '../../quotes/components/QuoteCard';`,
      'src/features/models/components/ModelCard.tsx',
    );
    expect(rules).toContain('no-restricted-imports');
  });

  it("accepts another feature's public surface", async () => {
    const rules = await lint(
      `import { QuoteCard } from '../../quotes';`,
      'src/features/models/components/ModelCard.tsx',
    );
    expect(rules).toEqual([]);
  });

  it('accepts a deep import within the SAME feature', async () => {
    const rules = await lint(
      `import { useModel } from '../hooks/use-model';`,
      'src/features/models/components/ModelCard.tsx',
    );
    expect(rules).toEqual([]);
  });
});
```

The three `accepts` cases are not padding. A boundary that also rejects legitimate imports gets disabled within a week, and the same-feature case is the one a careless pattern breaks.

- [ ] **Step 3: Run and watch it fail**

```bash
pnpm --filter @metrika/eslint-config test:unit; echo "EXIT=$?"
```

Expected: **non-zero**.

- [ ] **Step 4: Implement the three boundaries**

Append to `packages/eslint-config/src/boundaries.js`, following the file's existing shape and comment density. `webBoundary` bans `@metrika/database` and `@metrika/pricing-engine` statically and dynamically (both selectors). `serverActionBoundary` uses `no-restricted-syntax` on an `ExpressionStatement` whose expression is the `'use server'` directive, with the rule scoped by `files`/`ignores` so the two sanctioned paths never see it. `featureBoundary` uses `no-restricted-imports` with a `regex` matching `\.\./\.\./[^/]+/(components|hooks|schemas|lib)/` — a relative path that climbs out of the current feature and back into another feature's internals.

Each needs a message naming the rule and pointing at `CLAUDE.md` or the relevant ADR, in the style the existing boundaries use.

- [ ] **Step 5: Write the fixture config and run**

`packages/eslint-config/test/eslint.web-boundaries.config.js` composes all three. Then:

```bash
pnpm --filter @metrika/eslint-config test:unit; echo "EXIT=$?"
```

Expected: **0**.

- [ ] **Step 6: Compose them into `apps/web` and prove they fire on the real app**

`apps/web/eslint.config.js` gains `...webBoundary`, `...serverActionBoundary`, `...featureBoundary`.

Then verify against the actual application rather than only the fixture — a rule can pass its fixture and contribute nothing once composed, which has already happened in this repo when a later flat-config block silently replaced an earlier rule's options:

```bash
cat > apps/web/src/app/boundary-probe.ts <<'TS'
import { PrismaClient } from '@metrika/database';
export const p = PrismaClient;
TS
pnpm --filter @metrika/web lint; echo "PROBE_EXIT=$?"
rm apps/web/src/app/boundary-probe.ts
```

Expected: **non-zero**, and the message must be the boundary's, not a module-not-found. Repeat for a `'use server'` file outside the sanctioned paths.

- [ ] **Step 7: Check for flat-config clobbering**

Flat config **replaces** a rule's options wholesale when a later entry names the same rule id. `webBoundary` and `featureBoundary` both use `no-restricted-imports`, and both match files under `src/`.

Prove they coexist: write one probe file that violates **both** at once and confirm **two** findings, not one.

```bash
mkdir -p apps/web/src/features/models/components
cat > apps/web/src/features/models/components/probe.tsx <<'TSX'
import { PrismaClient } from '@metrika/database';
import { X } from '../../quotes/components/QuoteCard';
export const p = [PrismaClient, X];
TSX
pnpm --filter @metrika/web lint 2>&1 | grep -c 'no-restricted-imports'
rm -rf apps/web/src/features
```

Expected: **2**. If it is 1, one boundary is silently disabled — merge them into a single rule entry with both pattern sets rather than shipping the clobber.

- [ ] **Step 8: Run the gates and commit**

```bash
pnpm verify; echo "EXIT=$?"
```

```bash
git add packages/eslint-config apps/web
git commit -m "feat(eslint-config): fence apps/web with database, server-action and feature boundaries"
```

---

### Task 8: The CI job, and documentation that matches what exists

**Files:**

- Modify: `.github/workflows/ci.yml`, `CLAUDE.md`, `docs/ROADMAP.md`, `docs/LOCAL_DEVELOPMENT.md`, `docs/ARCHITECTURE.md`
- Test: the CI job itself, proven by mutation

**Interfaces:**

- Consumes: Tasks 1–7
- Produces: a `web` job in CI

- [ ] **Step 1: Read the existing workflow before adding to it**

```bash
sed -n '1,30p' .github/workflows/ci.yml
```

The comment block at the top is a hard constraint: **do not add an `actions/cache` step for `.turbo` and do not enable a Turbo remote cache.** Every job runs `pnpm build`, and `tsc -b`'s up-to-date check is trustworthy here only because a fresh checkout carries no `*.tsbuildinfo`.

- [ ] **Step 2: Add the `web` job**

Model it on the existing `openapi` job — same checkout, `pnpm/action-setup`, `setup-node` with `node-version-file: .nvmrc` and `cache: pnpm`, `pnpm install --frozen-lockfile`, `pnpm build`. Then:

```yaml
      - name: Install Playwright browsers
        run: pnpm --filter @metrika/web exec playwright install --with-deps chromium

      - name: E2E
        run: pnpm --filter @metrika/web test:e2e
```

**The two `NEXT_PUBLIC_` values are inherited from the workflow-level `env:` block, not set on the E2E step.** That placement is deliberate and was measured: the root layout imports `clientEnv`, which is parsed at module scope, so **`pnpm build` itself fails** with a ZodError naming both keys when they are absent — a `web` job that set them only on its E2E step would die one step earlier, at Build, with an error that looks nothing like a missing test-server variable.

If the workflow-level block is missing when you arrive, add it and move the per-job copies into it. A key that every job needs and each job declares separately is a trap for the next job somebody adds.

- [ ] **Step 3: Prove the job would actually fail**

The job has never run on a runner, so verify by running its exact commands locally, with a real break in place:

```bash
# Break something only e2e can see: remove the skip link from the layout.
pnpm --filter @metrika/web test:e2e; echo "EXIT=$?"   # expect non-zero
git checkout -- apps/web/src/app/layout.tsx
pnpm --filter @metrika/web test:e2e; echo "EXIT=$?"   # expect 0
```

Record both exit codes. A CI job whose failure mode has never been observed is a job nobody knows works.

- [ ] **Step 4: Reconcile the documentation, checking each claim against the tree**

Do not trust the wording already in these files — this repository has repeatedly shipped documents asserting controls that did not exist, and Plan 0B-1 spent a whole task correcting a batch of them.

- `CLAUDE.md`: the current-state paragraph and the command list. `dev`, `test:e2e` and the web-specific scripts now exist; say which. Add `apps/web/src/config/env.ts` to the `process.env` rule if it is not already named.
- `docs/ROADMAP.md`: mark 0.8 done; move 0.3's `react`/`next` profiles from deferred to done; update the progress paragraph so it agrees with the table rather than contradicting it.
- `docs/LOCAL_DEVELOPMENT.md`: how to run the web app, which port, which env keys.
- `docs/ARCHITECTURE.md`: the §6 package tree still lists `apps/web` as not existing alongside directories that genuinely do not. Add what now exists; leave the rest as target state and **say so explicitly** rather than letting a reader assume it is all present.

For anything a task in this plan did not build — `packages/api-client`, `packages/ui`, TanStack Query, the Zustand stores, the viewer — the documentation must describe it as target state in the honest form this repo already uses, not in the present tense.

- [ ] **Step 5: Run every gate from a clean clone**

State in the working checkout is the most common source of a green run that fails in CI.

```bash
TMP=$(mktemp -d)
git clone . "$TMP/metrika"
cd "$TMP/metrika"
pnpm install --frozen-lockfile; echo "INSTALL=$?"
pnpm verify; echo "VERIFY=$?"
pnpm --filter @metrika/web test:e2e; echo "E2E=$?"
cd - && rm -rf "$TMP"
```

Every exit code must be **0**. Anything that only works in the original checkout is a defect.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml CLAUDE.md docs
git commit -m "ci(web): run build, lint, typecheck and e2e for apps/web"
```

---

## Self-review notes for the executing agent

Three things this plan deliberately leaves to measurement rather than assertion, because guessing them is how the last plan lost time:

1. **Every version is ADR-0021's to decide.** If Task 1's spike fails on `next-intl` or `eslint-config-next`, the fallback is the previous Next major — not "work around it". Record the failure and take the fallback; that is what the fallback is for.
2. **The formatting assertions in Task 5 are shapes, not glyphs.** ICU's `es-CO` output is a measurement. Correct the separator, never the digits.
3. **Three tests in this plan can pass while the thing they guard is broken**, and each has a named mutation that proves otherwise: the Tailwind build test (a stale `.next`), the tagline e2e assertion (a hardcoded string), and the boundary fixtures (flat-config clobbering, which has already happened once in this repo). Run those mutations; do not reason about them.
