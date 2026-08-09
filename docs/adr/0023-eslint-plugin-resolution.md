# ADR-0023 — Where the ESLint plugins are declared, and why the answer differs per package

**Status:** Accepted · **Date:** 2026-08-09 · **Scopes:** the "Install `eslint-plugin-react` / `-react-hooks` / `-jsx-a11y` directly" bullet in [ADR-0021](./0021-next-major-and-frontend-stack.md)'s Alternatives section, and the corresponding sentence in its "Registry state" table caption. Everything else in ADR-0021 — the pins, the four obligations, the fallback — stands unchanged.

> **On the number.** 0022 is [`0022-orcaslicer.md`](./0022-orcaslicer.md), written on the parallel `docs/orcaslicer` branch and not yet merged. The gap here is that branch, not a mistake.

## Context

ADR-0021 rejected declaring the three ESLint plugins directly, and stated the reason as a general fact about pnpm:

> `eslint-config-next` loads them with `require("eslint-plugin-react")` from its own package directory, so under pnpm's isolated `node_modules` a direct declaration in `apps/web` installs a copy the config **never loads**. The manifest would carry a pinned, reviewed version that lints nothing.

Plan 0B-2 Task 2 then had to write `packages/eslint-config/src/react.js`, which imports all three plugins **by name** — a framework-agnostic React profile cannot get its plugins from `eslint-config-next` without importing Next. That package's `package.json` now declares all three, which reads as a direct contradiction of the bullet above. It is not, but nothing in either document said which situation it was describing, and [RISK_REGISTER.md](../RISK_REGISTER.md)'s R20 repeated the general form.

The discriminator was never written down. This ADR writes it down, because Task 3 writes `apps/web/package.json` reading ADR-0021, and would otherwise either copy the wrong precedent or "fix" a manifest that is correct.

## What was measured

Node 24.19.0, pnpm 11.20.0, this workspace, exit codes and paths read directly.

**1. A transitive import is not available to a workspace package.** With only `eslint-config-next` declared, from `packages/eslint-config`:

```
import('eslint-plugin-react')
→ ERR_MODULE_NOT_FOUND: Cannot find package 'eslint-plugin-react'
```

pnpm's isolated `node_modules` links a package's dependencies into that package's own directory and nowhere a workspace package's upward walk reaches. `node_modules/.pnpm/node_modules` — pnpm's hoisted fallback, populated by the default `hoist-pattern: ['*']` — sits on the resolution path of packages **inside** the virtual store, not of `packages/*`. So `src/react.js` cannot import a plugin it does not declare. There is no design choice here to make.

**2. At matching versions, the declaration resolves to the same physical copy.** With the ADR-0021 pins declared, comparing `fs.realpathSync` of the resolution from `packages/eslint-config` against the resolution from `eslint-config-next`'s own directory:

```
eslint-plugin-react        SAME COPY
eslint-plugin-react-hooks  SAME COPY
eslint-plugin-jsx-a11y     SAME COPY
```

Both sides land in one store entry, e.g. `.pnpm/eslint-plugin-react@7.37.5_eslint@10.8.0_jiti@2.7.0_supports-color@10.2.2_`. Same version, same resolved peer context, one directory. The pins in the manifest are therefore the copies `eslint-config-next` loads — not shadows of them.

**3. Forcing a divergence produces the two-copy structure ADR-0021 warned about.** Declaring `eslint-plugin-react@7.36.1` against `eslint-config-next@16.3.0`'s `^7.37.0`:

```
declared here : 7.36.1  .pnpm/eslint-plugin-react@7.36.1_eslint@10.8.0_…
loaded by ecn : 7.37.5  .pnpm/eslint-plugin-react@7.37.5_eslint@10.8.0_…
SAME INODE?   : NO — two physical copies
```

So the warning is real; its precondition is a **version or peer-context divergence**, not the act of declaring.

**4. `apps/web` needs to declare none of them, and `apps/api` proves why.** `apps/api/package.json` declares exactly two ESLint-related packages — `@metrika/eslint-config` and `eslint` — and cannot resolve `typescript-eslint` itself:

```
require.resolve('typescript-eslint') from apps/api → MODULE_NOT_FOUND
```

Yet `apps/api/eslint.config.js` loads and produces 15 config objects, with every type-aware rule live. `apps/api/node_modules/@metrika/eslint-config` is a symlink to `packages/eslint-config`, and Node resolves a module's own imports from its **realpath** (`preserveSymlinks` is off by default). `typeChecked()`'s `import tseslint from 'typescript-eslint'` is therefore resolved from `packages/eslint-config/node_modules`, where it is declared. The consumer never needs to know the plugin exists.

## Decision

**A package declares an ESLint plugin if and only if its own source `import`s it by name.**

| Package                                    | Declares                                                                                                               | Why                                                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `packages/eslint-config`                   | `eslint-plugin-react`, `eslint-plugin-react-hooks`, `eslint-plugin-jsx-a11y`, `eslint-config-next` — as `dependencies` | `src/react.js` and `src/next.js` import them; measurement 1 makes this mandatory, measurement 2 makes it harmless |
| `apps/web`, `apps/api`, any other consumer | none of them                                                                                                           | measurement 4: the config's imports resolve from the config package's realpath                                    |

ADR-0021's Alternatives bullet is **scoped to `apps/web`**, where it remains exactly right: `apps/web` imports none of the three, so a declaration there would be a reviewed, upgraded pin that nothing loads.

Two conditions attach to the declaration in `packages/eslint-config`, because measurement 2 is a property of today's version graph and not an invariant:

1. **The declared pins must stay inside `eslint-config-next`'s declared ranges** (`eslint-plugin-react@^7.37.0`, `eslint-plugin-react-hooks@^7.0.0`, `eslint-plugin-jsx-a11y@^6.10.0` at `16.3.0`). Bumping either side out of step reintroduces the two-copy structure.
2. **The property is asserted by a fixture**, not by this document. `packages/eslint-config/test/react.test.ts` compares the two `realpathSync` results for all three plugins and fails when they diverge.

## Alternatives

- **Resolve the plugins through `createRequire` anchored on `eslint-config-next`.** Would guarantee the same copy by construction, and would let `packages/eslint-config` declare nothing. Rejected: it makes the framework-agnostic `react()` profile depend on Next being installed, which is the one thing that profile exists not to do, and it replaces a declared, lockfile-visible dependency with a resolution trick no tool can audit.
- **Move the `react` profile into `apps/web`.** Removes the question entirely. Rejected: ROADMAP 0.3 puts these profiles in `packages/eslint-config`, and a future `packages/ui` needs `react()` without Next.
- **Leave the contradiction and note it only in R20.** Rejected on CLAUDE.md's rule — a manifest that contradicts an accepted ADR is a silent divergence, and the risk register is not where a reader of ADR-0021 looks.
- **`shamefully-hoist` / a `public-hoist-pattern` covering `*eslint*`.** Would make the transitive import work and let the manifest stay minimal. Rejected: it makes every package able to import things it does not declare, which converts a whole class of missing-dependency bugs from a hard error into a machine-dependent one.

## Consequences

**Accepted.** `packages/eslint-config/package.json` carries three pins whose correctness depends on a range declared in someone else's manifest. The fixture is what makes that dependency visible; without it the failure is silent in the worst way — see below.

**The silent failure this guards.** `next()` strips `react()`'s plugin registrations (ESLint 10 rejects two configs registering one plugin name with objects that are not `===`, and Vercel reaches `jsx-a11y` through a Babel interop helper whose object identity cannot be reproduced). So under `next()`, every `react/*` rule **implementation** comes from `eslint-config-next`'s copy; the declared pins contribute only the rule-name lists that `react()` spreads. If the two copies ever diverge, `apps/web` would lint with one version's implementations against another version's rule list, while `react()` used standalone kept using the declared copy — two different linters from one manifest, with no error. That is the scenario the fixture exists for, and it is why condition 1 above is a condition rather than a preference.

**Gained.** The discriminator is now written where both readers look: a plugin is declared where it is imported, and nowhere else. `apps/api` already followed this rule without anyone stating it, which is the evidence that it is the repository's actual convention rather than a new one.

**Unchanged.** ADR-0021's pins, its four obligations, and its fallback. R20 in [RISK_REGISTER.md](../RISK_REGISTER.md) still owns `eslint-plugin-react`'s health as a tracked risk; this ADR owns only where the three plugins are declared.
