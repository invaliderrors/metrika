# ADR-0024 — `@types/node` tracks the Node major in `.nvmrc`, not the registry's latest

**Status:** Accepted · **Date:** 2026-08-09 · **Scopes:** the `@types/node` row of [ADR-0021](./0021-next-major-and-frontend-stack.md)'s "Registry state" table, and the version named in its obligation 1. ADR-0021's other pins, its remaining three obligations, and its fallback stand unchanged.

## Context

ADR-0021 measured the frontend stack against the npm registry on 2026-08-09 and pinned each package at its latest published version. For fifteen of the sixteen rows that was the right rule. For `@types/node` it was not, and the ADR states `26.2.0` in three places:

- the registry table (`| @types/node | 26.2.0 | 26.2.0 | yes (devDep) — **mandatory** |`),
- obligation 1: "**`@types/node@26.2.0` is a declared devDependency of `apps/web`.** Not optional, not inherited",
- and the "What did not work" narrative: "Declaring `@types/node@26.2.0` up front removes the install and the cold build exits 0."

`@types/node` is not like the other fifteen. Its major version is not a feature level to be kept current — it is a **statement about which Node runtime the code runs on**. Plan 0B-2 Task 3 wrote `apps/web/package.json` reading ADR-0021, pinned `24.13.3` to match the rest of the workspace, and flagged the divergence rather than following the table. This ADR records why that was correct, so the next reader neither "fixes" a correct manifest back to `26.2.0` nor re-derives the argument from scratch.

The distinction ADR-0021 blurred is between _which version_ and _whether it is declared at all_. Only the second is what its spike actually proved.

## What was measured

Node 24.19.0, pnpm 11.20.0, this workspace. Exit codes read from `$?` directly.

**1. This repository can only run Node 24, and enforces it.**

| Where                                | Value                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `.nvmrc`                             | `24.19.0`                                                                                  |
| root `package.json` → `engines.node` | `>=24 <25`                                                                                 |
| `scripts/check-node-version.mjs`     | wired as root `preinstall`; reads `.nvmrc`, compares majors, `process.exit(1)` on mismatch |

The guard is binding rather than advisory — `.npmrc`'s `engine-strict` does not make pnpm 11.20.0 fail an install on a Node mismatch, which is the whole reason that script exists. `@types/node@26.2.0` describes APIs this repository is structurally prevented from running.

**2. The major tracks the runtime major — this is DefinitelyTyped's own convention, not an inference.** From the installed package's README:

```
Files were exported from
https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node/v24
```

The version directory is `v24`. There is a `v24` line precisely so that projects on Node 24 do not have to take types for a newer runtime.

**3. Every workspace package that declares it already agrees.**

```
package.json:32           "@types/node": "24.13.3"
apps/api/package.json:33  "@types/node": "24.13.3"
apps/web/package.json:26  "@types/node": "24.13.3"
```

**4. A second declared major would put two sets of global declarations into one program — and one of them is a set `apps/web` augments.** The store today holds two copies:

```
@types+node@18.19.130
@types+node@24.13.3
```

The `18.19.130` copy is **transitive and confined**: it is a dependency of `@types/ssh2@1.15.5`, which arrives through testcontainers in `packages/testing`. No workspace package declares it, and it is on no workspace package's resolution path — verified directly:

```
require.resolve('@types/node/package.json', { paths: ['apps/web'] })
→ node_modules/.pnpm/@types+node@24.13.3/node_modules/@types/node/package.json
```

That is the difference that matters. `@types/node` declares `NodeJS.ProcessEnv` in the **global** scope, and `apps/web/src/config/process-env.d.ts` augments exactly that interface to make the two `NEXT_PUBLIC_` reads compile under `noPropertyAccessFromIndexSignature`. Two declared majors in one TypeScript program is two competing global scopes under an augmentation — a class of failure that is confusing to diagnose and that buys nothing here.

**5. Obligation 1's actual requirement holds at `24.13.3`.** A cold build in `apps/web`, with both `.next` and `next-env.d.ts` removed and turbo bypassed:

| Check                                                  | Result     |
| ------------------------------------------------------ | ---------- |
| `pnpm --filter @metrika/web build`                     | exit **0** |
| `grep -ci "Installing devDependencies"` over the log   | **0**      |
| `InvariantError: Expected workStore to be initialized` | absent     |

**6. `next@16.3.0` declares no `@types/node` dependency, peer or optional peer.** Its `peerDependencies` are `@opentelemetry/api`, `@playwright/test`, `babel-plugin-react-compiler`, `react`, `react-dom` and `sass` — nothing else. So there is no upstream version constraint to satisfy, and never was one. Obligation 1 is entirely about Next's _behaviour_ — it detects TypeScript, finds no `@types/node`, and runs `pnpm add -D @types/node` while its own build workers are running — not about a particular version.

## Decision

**`@types/node`'s major tracks the Node major in `.nvmrc`. Its pin is `24.13.3` today, in every package that declares it.**

Bumping it is part of a Node upgrade — `.nvmrc`, `engines`, CI's `node-version-file`, and this pin move together — and is not something to do because the registry moved.

**ADR-0021 obligation 1 is restated as:** `@types/node` is a **declared devDependency** of `apps/web`. Not optional, not inherited. The version is governed by this ADR. The obligation's purpose is that Next never runs `pnpm add -D @types/node` mid-build; it is satisfied by the declaration existing, at any version compatible with the runtime, and measurement 5 confirms it holds at `24.13.3`.

Two conditions attach:

1. **One `@types/node` major across all workspace packages that declare it.** A package needing a different major is a signal that it targets a different runtime, which is a decision needing its own ADR — not a version bump.
2. **A transitive copy at another major is acceptable** and needs no action, as long as no workspace package declares it and no workspace package resolves to it (measurement 4). `@types/ssh2@1.15.5` → `@types/node@18.19.130` is the current instance.

## Alternatives

- **Follow ADR-0021 and pin `26.2.0`.** Rejected on measurement: it describes a runtime `preinstall` refuses to let anyone use, and it would be the only declared second global-declaration set in the workspace, under the one interface `apps/web` augments. It also buys nothing — measurement 6 shows nothing upstream asks for it.
- **Bump `.nvmrc` to Node 26 so the ADR-0021 pin becomes correct.** Rejected as tail-wagging-dog, and out of scope for a types pin: the Node version is chosen by what the runtime targets (`ARCHITECTURE.md`, the Docker images, Vercel's supported runtimes), not by what DefinitelyTyped published most recently. If Node 26 is wanted, that is its own ADR and this pin follows it.
- **Amend ADR-0021 in place.** Not available. ADRs are immutable (CLAUDE.md); an accepted decision is superseded by a new one, never edited.
- **Leave the divergence recorded only in the Task 3 report.** Rejected, and this is the failure mode the ADR is really for: a manifest that contradicts an accepted ADR is a silent divergence, and a task report is not where a reader of ADR-0021 looks. The concrete risk is someone reading obligation 1's "Not optional, not inherited" as covering the _version_ and "correcting" three manifests.

## Consequences

**Accepted.** ADR-0021's registry table now has one row that must be read together with this document. That is the cost of immutable ADRs and is paid deliberately; the `Scopes:` header above is what makes it findable from either direction.

**Nothing here weakens obligation 1.** The cold-build failure it exists to prevent — `InvariantError: Expected workStore to be initialized`, which passes on every warm rebuild and only ever fires on a cold CI run — is prevented by the declaration, and that was verified on a cold tree at this pin rather than assumed.

**Gained.** The rule is now stated as a rule rather than as a version number: `@types/node` follows the runtime, and moves when the runtime moves. That survives the next registry release, which a pinned number does not.

**Unchanged.** Every other pin in ADR-0021's table, obligations 2 (`agentRules: false`), 3 (`settings.react.version`) and 4 (`allowBuilds`), and the Next 15 fallback. R20 in [RISK_REGISTER.md](../RISK_REGISTER.md) still owns `eslint-plugin-react`'s health.
