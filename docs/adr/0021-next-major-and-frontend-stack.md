# ADR-0021 — Next.js 16 and the pinned frontend stack

**Status:** Accepted · **Date:** 2026-08-09 · **Scoped by** [ADR-0023](./0023-eslint-plugin-resolution.md) (plugin declaration) and [ADR-0024](./0024-types-node-pin.md) (the `@types/node` pin — this ADR's `26.2.0` is superseded by `24.13.3`)

> **On the number.** Plan 0B-2 Task 1 asked for this to be ADR-0020. That number
> was taken by [ADR-0020](./0020-internal-package-build-output.md) (merged in
> `b1b565b`) between the plan being written and the spike being run, and ADRs are
> immutable, so this is 0021. Plan 0B-2's references were corrected in `36193a1`;
> the note stays because a reader coming from an older copy of the plan will
> otherwise open ADR-0020 and find a document about package build outputs.

## Context

[`ARCHITECTURE.md`](../ARCHITECTURE.md) named **Next.js 15**. The current major
is **16**, released 2025-10-22, at `16.3.0` since 2026-08-03. Plan 0B-2 Tasks
2–6 install fifteen packages; a pin chosen ad hoc inside one of those tasks is a
pin nobody reviewed, and a wrong one is discovered three tasks later.

This repository has already had a framework decision fail its own spike gate
once — [ADR-0009](./0009-ts-rest-contracts.md) chose ts-rest and the spike found
it pinned to Zod 3 internals with no publish in fourteen months, emitting
silently empty OpenAPI schemas, which is why [ADR-0019](./0019-nestjs-zod-contracts.md)
exists. Plan 0A lost **all** type-aware linting to the softer version of the same
failure: TypeScript resolved outside `typescript-eslint`'s peer range, every
type-aware rule stopped running, and nothing errored. So this decision is gated
on a spike that measures four integrations positively — Next 16 + React 19,
Tailwind 4 via PostCSS, `next-intl` 4, and `eslint-config-next` under the
repository's ESLint 10.8.0 / TypeScript 6.0.3 — rather than on `next build`
exiting 0.

The spike ran in two throwaway directories outside the workspace (`mktemp -d`),
on Node 24.19.0 and pnpm 11.20.0, and was destroyed afterwards.

### Registry state, measured 2026-08-09

`npm view <pkg> version`. "Direct" means a declared dependency of `apps/web`
rather than something `eslint-config-next` brings transitively.

| Package                     | Latest  | **Pin**   | Direct?                            |
| --------------------------- | ------- | --------- | ---------------------------------- |
| `next`                      | 16.3.0  | `16.3.0`  | yes (dep)                          |
| `react`                     | 19.2.8  | `19.2.8`  | yes (dep)                          |
| `react-dom`                 | 19.2.8  | `19.2.8`  | yes (dep)                          |
| `@types/react`              | 19.2.18 | `19.2.18` | yes (devDep)                       |
| `@types/react-dom`          | 19.2.4  | `19.2.4`  | yes (devDep)                       |
| `@types/node`               | 26.2.0  | `26.2.0`  | yes (devDep) — **mandatory**       |
| `next-intl`                 | 4.13.5  | `4.13.5`  | yes (dep)                          |
| `tailwindcss`               | 4.3.3   | `4.3.3`   | yes (devDep)                       |
| `@tailwindcss/postcss`      | 4.3.3   | `4.3.3`   | yes (devDep)                       |
| `eslint-config-next`        | 16.3.0  | `16.3.0`  | yes (devDep)                       |
| `eslint-plugin-react`       | 7.37.5  | `7.37.5`  | **no** — from `eslint-config-next` |
| `eslint-plugin-react-hooks` | 7.1.1   | `7.1.1`   | **no** — from `eslint-config-next` |
| `eslint-plugin-jsx-a11y`    | 6.10.2  | `6.10.2`  | **no** — from `eslint-config-next` |
| `clsx`                      | 2.1.1   | `2.1.1`   | yes (dep)                          |
| `tailwind-merge`            | 3.6.0   | `3.6.0`   | yes (dep)                          |
| `@playwright/test`          | 1.62.1  | `1.62.1`  | yes (devDep)                       |

The three ESLint plugins are **not** direct installs, and this is a fact about
module resolution rather than a stylistic preference. `eslint-config-next@16.3.0`
declares them itself (`eslint-plugin-react@^7.37.0`,
`eslint-plugin-react-hooks@^7.0.0`, `eslint-plugin-jsx-a11y@^6.10.0`) and loads
them with `require("eslint-plugin-react")` **from its own package directory**.
Under pnpm's isolated `node_modules` that resolves to the copy inside
`eslint-config-next`'s own dependency tree. A second declaration in
`apps/web/package.json` therefore installs a _different physical copy that the
config never loads_: a version in the manifest, reviewed and pinned and
upgraded, linting nothing. The versions are pinned above so they are on record
and so `pnpm peers check` output is interpretable — not so anyone installs them.

`@types/node` is listed because the spike proved it is not optional — see
"What did not work".

`eslint-config-next@16.3.0` also brings `typescript-eslint@^8.46.0`, which
resolves to the `8.66.0` already pinned across this workspace. No duplicate.

### Peer ranges, checked before installing

| Package                      | All declared peers                                                                                                                                                                                                    | React 19.2.8 | ESLint 10.8.0 | TS 6.0.3     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------- | ------------ |
| `next@16.3.0`                | required — `react`/`react-dom`: `"^18.2.0 \|\| 19.0.0-rc-de68d2f4-20241204 \|\| ^19.0.0"`. Optional — `sass "^1.3.0"`, `@playwright/test "^1.51.1"`, `@opentelemetry/api "^1.1.0"`, `babel-plugin-react-compiler "*"` | **in range** | n/a           | n/a          |
| `next-intl@4.13.5`           | `next`: `"^12.0.0 \|\| ^13.0.0 \|\| ^14.0.0 \|\| ^15.0.0 \|\| ^16.0.0"`; `react`: `"… \|\| ^19.0.0"`                                                                                                                  | **in range** | n/a           | n/a          |
| `eslint-config-next@16.3.0`  | `eslint`: `">=9.0.0"`; `typescript`: `">=3.3.1"`                                                                                                                                                                      | n/a          | **in range**  | **in range** |
| `@tailwindcss/postcss@4.3.3` | _(none declared)_                                                                                                                                                                                                     | n/a          | n/a           | n/a          |

`@playwright/test@1.62.1` satisfies `next`'s optional `^1.51.1`; the other three
optional peers are for features this project does not use and were left
uninstalled.

Its own dependency tree is where the exclusions are. `pnpm peers check` after a
clean install reports exactly three, all against ESLint:

```
✕ unmet peer eslint
  Installed: 10.8.0
  Wanted:
    "^2 || ^3 || ^4 || ^5 || ^6 || ^7.2.0 || ^8 || ^9":  eslint-plugin-import@2.32.0
    "^3 || ^4 || ^5 || ^6 || ^7 || ^8 || ^9":            eslint-plugin-jsx-a11y@6.10.2
    "^3 || ^4 || ^5 || ^6 || ^7 || ^8 || ^9.7":          eslint-plugin-react@7.37.5
```

`eslint-plugin-react-hooks@7.1.1` declares `"… || ^9.0.0 || ^10.0.0"` and is
in range. Each of the three excluded plugins was then exercised individually
against source written to violate one of its rules, because a stale peer range
and a real incompatibility look identical until you measure:

- `eslint-plugin-jsx-a11y@6.10.2` — **works.** Emits `jsx-a11y/alt-text` on an
  `<img>` with no `alt`. Stale metadata; last publish 2024-10-26, 21.5 months.
- `eslint-plugin-import@2.32.0` — **works.** `eslint-config-next` enables
  exactly one rule from it, `import/no-anonymous-default-export`, and that rule
  fires. `import/no-unresolved` was additionally enabled **by hand** in a probe
  config, to prove `eslint-import-resolver-typescript` resolves despite
  `unrs-resolver`'s build script being denied; it is not on in the shipped
  config.
- `eslint-plugin-react@7.37.5` — **crashes, conditionally.** See below.

### Gate results, from a cold install

Node 24.19.0, pnpm 11.20.0, no warm `node_modules`, no `.next`. Exit codes read
from `$?` immediately after each command.

| Gate                     | Exit  | Evidence beyond the exit code                                                       |
| ------------------------ | ----- | ----------------------------------------------------------------------------------- |
| `pnpm install`           | **0** | one `[WARN]` line pointing at `pnpm peers check`; the three unmet peers above       |
| `pnpm exec tsc --noEmit` | **0** | —                                                                                   |
| `pnpm build`             | **0** | `▲ Next.js 16.3.0 (Turbopack)`; 3/3 static pages; `next.config.ts` executed         |
| `pnpm exec eslint .`     | **1** | seven real findings on deliberately-bad fixtures; **0** on the spike's real sources |

`LINT_EXIT=1` is a pass, not a failure: the run was pointed at fixtures written
to be wrong. What matters is _which_ rules fired, because that is the check Plan
0A did not make. All six plugins produced a finding:
`react/jsx-key`, `react-hooks/rules-of-hooks`, `jsx-a11y/alt-text`,
`@next/next/no-img-element`, `@typescript-eslint/no-unused-vars`,
`import/no-anonymous-default-export`. Nothing degraded silently.

**Tailwind actually processed**, rather than an unprocessed `className`
surviving into the HTML. The emitted stylesheet contains a rule _body_:

```
.p-8{padding:calc(var(--spacing) * 8)}
.text-2xl{font-size:var(--text-2xl);line-height:var(--tw-leading,var(--text-2xl--line-height))}
```

**`next-intl` actually resolved**, rather than rendering the message key.
`.next/server/app/index.html` contains `Hola` (from `messages/es-CO.json`, via
`getTranslations`) and `lang="es-CO"` (from `getLocale()` in the root layout,
via `getRequestConfig`). `next dev` serves the same at HTTP 200.

## Decision

**Pin Next.js 16.3.0** and the table above. `apps/web` targets Next 16, not 15.

Four things the spike proved are required, and are therefore obligations on
Plan 0B-2 Tasks 2–6 rather than suggestions:

1. **`@types/node@26.2.0` is a declared devDependency of `apps/web`.** Not
   optional, not inherited. Without it a cold `next build` fails — see below.
2. **`next.config.ts` sets `agentRules: false`.** Next 16's `next dev` otherwise
   writes `AGENTS.md` and `CLAUDE.md` into the app directory on every start.
3. **The flat config appends `{ settings: { react: { version: '19.2.8' } } }`
   after `eslint-config-next`'s configs**, overriding its `'detect'`. Without it
   ESLint exits 2 and lints nothing. **Task 2 additionally ships a fixture
   asserting that `react/jsx-key` reports on a `.map()` returning JSX without a
   `key`** — the named rule, reporting, not "the config loads" and not the exit
   code. Asserting the config loads is precisely the assertion that would have
   passed all the way through Plan 0A's silent loss of type-aware linting. This
   override has no other guard: obligations 1, 2 and 4 fail loudly on a cold CI
   run, but a regression here surfaces as `ESLint exited 2`, which one `|| true`
   in a script swallows — or, if a future `eslint-plugin-react` stops throwing
   and starts no-op'ing, as exit 0 with the rules inert. A control without a
   fixture asserting it fires is an intention.
4. **`pnpm-workspace.yaml` gains `allowBuilds` entries for `@parcel/watcher`,
   `@swc/core` and `unrs-resolver`.** All three measured safe to set `false`:
   with every build script denied, `pnpm install`, `next build`, `next dev` and
   a hand-enabled `import/no-unresolved` all work. An absent entry — not a
   `false` one — is what `ERR_PNPM_IGNORED_BUILDS` fails on, exactly as recorded
   for `@scarf/scarf`.

**Three of those four are not a cost of choosing 16.** `@types/node` is
declared by any TypeScript application, Next 15 included — 16's only difference
is that it self-installs it mid-build instead of erroring. The `allowBuilds`
entries are existing repository policy (`@scarf/scarf`), and two of the three
packages come from `next` under either major. The
`settings.react.version` override is **explicitly not avoided by the fallback**:
`eslint-config-next@15.5.23` depends on the same `eslint-plugin-react@^7.37.0`
and sets the same `'detect'`. Exactly one line — `agentRules: false` — is a
genuinely 16-specific cost, and the fallback's own cost is larger (see below).
The count of workarounds is not an argument against this decision, and should
not be read as one.

`eslint-config-next` exposes **no `./flat` subpath**. Its `exports` map is `.`,
`./core-web-vitals`, `./typescript`, `./parser`. The flat-config entry points to
use are `eslint-config-next/core-web-vitals` (4 config objects) and
`eslint-config-next/typescript` (5), both default-exporting arrays.

### Fallback

If any of the four integrations fails during Tasks 2–6, pin **`next@15.5.23`**
and **`eslint-config-next@15.5.23`** and update `apps/web` only — nothing else in
the table moves, because `next-intl@4.13.5` peer-accepts `^15.0.0`,
`@tailwindcss/postcss` declares no peers at all, and React 19.2.8 is in
`next@15.5.23`'s peer range too. 15 is still maintained: `15.5.23` was published
2026-08-06, three days before this ADR, under the `backport` dist-tag.

The condition covers all four integrations, so each gets its own trigger
measurement. Any one of these, reproduced, justifies the fallback:

| Integration      | Trigger measurement                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Next + React** | A **cold** `pnpm build` in `apps/web` failing with `@types/node` declared and `.next` removed — the `workStore` failure below reproducing after its known cause is fixed.                   |
| **Tailwind**     | The emitted `.next/**/*.css` containing no rule _body_ for a class used in the source (`.p-8{padding:…}`). `next build` exiting 0 is not evidence; an unprocessed `className` survives.     |
| **`next-intl`**  | A prerendered page containing the message _key_ (`spike.greeting`) instead of its value, or `<html>` missing the `lang` `getLocale()` should have supplied.                                 |
| **ESLint**       | `react/jsx-key` failing to report on the obligation-3 fixture, with `settings.react.version` correctly pinned. Note this trigger fires the fallback but is **not cured** by it — see below. |

A warm rebuild passing is not evidence either way for any of them; the spike's
first failure passed on every warm rebuild.

**The fallback costs more than the decision it would reverse, and it does not
cure the ESLint trigger.** `eslint-config-next@15.5.23` ships **no `exports`
field** at all — it is a legacy `.eslintrc` config needing
`@rushstack/eslint-patch` to work as flat config — and it depends on
`eslint-plugin-react-hooks@^5.0.0`, whose peer range `"… || ^9.0.0"` stops at
ESLint 9. `^5` is the one plugin line here with a **real** ESLint 10 exclusion
that has not been measured; `7.1.1`, which 16 pulls, declares `^10.0.0`
explicitly. And because 15 carries the same `eslint-plugin-react@^7.37.0` and
the same `'detect'`, it inherits the crash and obligation 3 verbatim. So the
trade is: one config line (`agentRules: false`) against a legacy-config shim,
plus an untested ESLint-10 exclusion on the only plugin that currently has a
clean peer range, plus the same React-version override anyway. Taking the
fallback means either losing the `react-hooks` rules or installing
`eslint-plugin-react-hooks@7.1.1` directly to override the transitive v5 — which
runs straight into the resolution problem described above, since
`eslint-config-next@15` `require`s its own copy. Record that cost if it is
taken.

## Alternatives

- **Stay on Next 15**, as `ARCHITECTURE.md` said. Rejected on measurement, not
  on novelty: 16 passed every gate, its `eslint-config-next` is
  flat-config-native where 15's is a legacy `.eslintrc` needing a patch shim, it
  pulls the only `react-hooks` line that supports ESLint 10, and it inherits the
  `eslint-plugin-react` crash no more than 15 does. Choosing 15 would cost more
  configuration than choosing 16, not less — and it would still buy a migration
  in Phase 1.
- **Install `eslint-plugin-react` / `-react-hooks` / `-jsx-a11y` directly**, as
  Plan 0B-2's interface list assumed. Rejected, and not as a judgement call:
  `eslint-config-next` loads them with `require("eslint-plugin-react")` from its
  own package directory, so under pnpm's isolated `node_modules` a direct
  declaration in `apps/web` installs a copy the config **never loads**. The
  manifest would carry a pinned, reviewed version that lints nothing, and every
  future upgrade of it would be a no-op nobody could tell from a working one.
- **Hand-roll the flat config from `@next/eslint-plugin-next` alone**, avoiding
  the three out-of-range peers entirely. Measured working (it declares no peers
  and emits `@next/next/no-img-element` under ESLint 10), and it is the escape
  hatch if `eslint-plugin-react` breaks harder in a later ESLint. Rejected for
  now: it drops `react`, `jsx-a11y` and `import` rules that were measured to
  work, in exchange for owning a config Vercel currently maintains.
- **Downgrade ESLint to 9 for `apps/web`.** Rejected: one ESLint version across
  the workspace is what makes `pnpm lint` mean one thing, and the three unmet
  peers turned out to be stale metadata rather than real breakage.

## Consequences

### What did not work

**A cold `next build` failed, and the cause is a mid-build `pnpm install`.**
The first run in a clean directory failed with

```
Error occurred prerendering page "/_global-error".
Error [InvariantError]: Invariant: Expected workStore to be initialized. This is a bug in Next.js.
```

`BUILD_EXIT=1`. Every warm rebuild of the identical sources passed, which is the
shape of bug that gets dismissed as flaky and then only ever fires in CI. It
reproduced deterministically in a second clean directory. Bisected: not
`next-intl` (plain Next 16 + Tailwind builds; the plugin alone builds;
`getLocale`/`getMessages` in the layout builds; `getTranslations` in the page
builds), not the `jsx: "preserve"` tsconfig, not a mid-build install by itself.
It requires a mid-build install that **adds packages** — Next 16 detects
TypeScript, finds `@types/node` missing, and runs `pnpm add -D @types/node`
while its own build workers are running, mutating `node_modules` underneath
them. Declaring `@types/node@26.2.0` up front removes the install and the cold
build exits 0. Hence obligation 1; a `next build` that prints
`Installing devDependencies` should be treated as a failed build even when it
exits 0.

**ESLint exited 2 with `eslint-config-next` out of the box.**

```
TypeError: Error while loading rule 'react/display-name': contextOrFilename.getFilename is not a function
    at resolveBasedir (…/eslint-plugin-react@7.37.5/lib/util/version.js:31:100)
    at detectReactVersion (…/version.js:85:19)
```

`eslint-config-next` sets `settings.react.version = 'detect'`;
`eslint-plugin-react@7.37.5` implements detection via `context.getFilename()`,
removed in ESLint 10. This is the `eslint-plugin-react` peer exclusion cashing
in — the one of the three that was real. It is **not** a Next 16 problem:
`eslint-config-next@15` depends on the same `eslint-plugin-react@^7.37.0` and
sets the same `'detect'`, so the fallback does not avoid it. Confirmed by
isolation: with `version: 'detect'` the plugin crashes; with a literal version
it emits `react/jsx-key` correctly; with the setting absent it warns and still
works. Hence obligation 3.

The override was then checked for the failure mode that matters more than the
crash — that it stops the throw while leaving the rules inert. It does not:
under the pinned version **all 15 reportable `react/*` rules
`eslint-config-next` enables produce findings**, `react/jsx-uses-vars` is live
(so JSX-only identifiers are not misreported as unused), and the five
`react-hooks` v7 rules and `jsx-a11y/alt-text` report alongside them. The plugin
was also audited for other calls into APIs ESLint 10 removed: every other legacy
use is guarded by a feature check, with two exceptions —
`react/jsx-filename-extension` and `react/forward-ref-uses-ref` call them
unguarded. Neither rule is enabled by `eslint-config-next`, so both are latent
rather than active; **anyone widening the `react/*` rule set past what
`eslint-config-next` turns on must enable those two individually and check they
do not throw.**

When `eslint-plugin-react` ships an ESLint 10 release, the override can go — it
has had no publish since 2025-04-03, sixteen months, which is ts-rest's number.
"Worth watching" in a document nobody re-reads is not watching, so this is
tracked as **R20** in [RISK_REGISTER.md](../RISK_REGISTER.md), which has a
review cadence.

**`pnpm install` exited 1 on first contact.** `[ERR_PNPM_IGNORED_BUILDS]` for
`@parcel/watcher@2.6.0` and `@swc/core@1.15.47`, and `unrs-resolver@1.12.2` once
`eslint-config-next` was added. Hence obligation 4. A related trap: pnpm 11
ignores `pnpm.allowBuilds` in `package.json` and only reads `allowBuilds` from
`pnpm-workspace.yaml`, warning
`The "pnpm" field in package.json is no longer read by pnpm`.

**`next dev` wrote `AGENTS.md` and an 11-byte `CLAUDE.md` containing
`@AGENTS.md`** into the app directory, announced as
`✓ Generated AGENTS.md and CLAUDE.md for AI agents`. In a repository whose
`CLAUDE.md` is hand-authored and whose rules say not to leave the tree dirty,
a dev server that generates one is unacceptable. `next build` does not do it.
`agentRules: false` suppresses it — verified: files absent, dev still serves 200.
Hence obligation 2.

**Next 16 rewrites `tsconfig.json` on build.** It sets `jsx: "react-jsx"`
(mandatory, overriding `"preserve"`), `isolatedModules: true` (mandatory),
`allowJs: true`, and appends `.next/dev/types/**/*.ts` to `include` — note
`dev`, which the plan's tsconfig did not have. Writing those values up front
makes the rewrite a no-op, verified by diffing the file across a build. A
`tsconfig.json` that changes during CI is a dirty tree.

**Benign, but recorded.** `eslint-plugin-jsx-a11y@6.10.2` (unmet peer, last
publish 2024-10-26 — 21.5 months) and `eslint-plugin-import@2.32.0`
(unmet peer) both work under ESLint 10; they are recorded because the next
person to run `pnpm peers check` will see three warnings and needs to know which
one was real. ESLint 10 also lints only `.js`/`.mjs`/`.cjs` unless a config
entry names other extensions — a config without an explicit `files` pattern
reports `File ignored because no matching configuration was supplied` and exits
**0**, which is the silent-success shape this repository keeps meeting.
`eslint-config-next` supplies the patterns; a hand-rolled config would not.

### What is now true

**Accepted:** `apps/web` carries four pieces of configuration that exist only to
work around upstream bugs — though only one of the four, `agentRules: false`, is
a cost of choosing 16 over 15. Obligations 1, 2 and 4 fail loudly on a cold CI
run; obligation 3 would not, which is why it alone carries a required fixture.
`apps/web` pins a React version in two places — `package.json` and the ESLint
settings — and they must move together; the obligation-3 fixture is what makes
a drift between them visible. `eslint-plugin-react`'s health is now a tracked
risk (R20) rather than a paragraph in an ADR. Turbopack is Next 16's default
builder and the spike never exercised Webpack; any later `next.config.ts` option
assuming Webpack is unverified.

**Gained:** every version Tasks 2–6 install was measured against this
repository's actual ESLint 10.8.0 and TypeScript 6.0.3 rather than against the
defaults `create-next-app` would have produced, and all four integrations were
verified by positive evidence — a CSS rule body, a translated string in
prerendered HTML, a named lint rule firing per plugin — rather than by the
absence of an error. The one genuinely broken integration was found now, in a
directory that was deleted, instead of in Task 5.
