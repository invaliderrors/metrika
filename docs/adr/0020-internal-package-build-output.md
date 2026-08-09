# ADR-0020 — Internal packages `apps/api` depends on emit compiled `dist/`, not source-only `exports`

**Status:** Accepted · **Date:** 2026-08-08 · **Supersedes:** the source-only-packages paragraph of [ADR-0001](./0001-monorepo-strategy.md)'s Decision section. The rest of ADR-0001 — pnpm workspaces, Turborepo, the separate uv workspace for Python — stands unchanged.

## Context

ADR-0001 decided internal packages would be source-only: `"exports": { ".": "./src/index.ts" }`, consumed by Next.js through `transpilePackages`, by the API through TypeScript project references, and by Vitest natively. The stated benefit was real and is not being walked back here: a contract change is visible everywhere instantly, with no watch-mode build step in the inner loop — and ADR-0001 explicitly rejected "Built packages (tsup/tsc per package)" for exactly that friction.

That decision assumed every consumer of an internal package can either transpile TypeScript itself or resolve project references at build time. Plan 0B-1 Task 1 is the first task to build a consumer that can do neither: `apps/api` (NestJS) compiles to `dist/main.js` and runs that file directly with a plain `node` process — no `ts-node`, no `--loader`, no transpilation step in the deployed artefact. A bare-specifier `import '@metrika/contracts'` from that compiled output resolves through the package's own `exports` map, and `"." : "./src/index.ts"` sends Node straight at a TypeScript file. Node 24 strips types from a directly-executed `.ts` entry point — the top-level file itself loads — but the package's own internal specifiers (`import { brandedUuid } from './brand.js'`, inside `src/index.ts`'s dependency graph) point at compiled-looking paths that do not exist on disk; only `brand.ts` does. The module graph fails one file in, with `ERR_MODULE_NOT_FOUND`, at runtime, in production — a resolution error, not an extension error, and it surfaces identically whether the entry point is `src/index.ts` today or `dist/main.js` once `apps/api` exists.

This is not hypothetical. Plan 0A's whole-branch review recorded it as carryover item 1 in [ROADMAP.md](../ROADMAP.md), blocking every later task that depends on `apps/api`, and `packages/contracts/test/package-exports.test.ts` reproduces it as a mutation test: reverting `exports` to `{ ".": "./src/index.ts" }` makes `node -e "import '@metrika/contracts'"` fail exactly this way.

Next.js and Vitest are unaffected by any of this: `transpilePackages` and Vitest's resolver both handle `.ts` sources directly, and neither runs compiled output through a bare `node` process. The defect is specific to "a consumer that executes compiled JavaScript with no loader" — in this repository, that is `apps/api`, and nothing else so far.

## Decision

`@metrika/contracts` — and, by the same reasoning, any future internal package `apps/api` imports at runtime — gets a `build` script (`tsc -b tsconfig.build.json`) that emits `dist/`, and a conditional `exports` map pointing at the compiled output:

```jsonc
{
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./package.json": "./package.json"
  },
  "files": ["dist"]
}
```

`typecheck` (`tsc -b`, over `tsconfig.json`, never emits) and `build` (`tsc -b tsconfig.build.json`, emits to `dist/`) are separate scripts and separate Turbo tasks, so the emitting half can be cached and ordered independently of the checking half. Packages with no runtime consumer that executes compiled Node output — `packages/eslint-config`, `packages/typescript-config`, and any future package only `apps/web`/Vitest import — are unaffected: they declare no `build` script, Turbo skips the task for them without erroring, and they stay exactly as ADR-0001 described.

## Alternatives

- **Keep source-only; make `apps/api` transpile at boot** (`ts-node`, `tsx`, a custom ESM loader) — rejected. It reintroduces the "the build step didn't disappear, it moved" cost ADR-0001 rejected for the inner loop, except now it is paid on every cold start in production rather than once per edit during development.
- **Keep source-only; bundle `apps/api` (esbuild/webpack) so the whole dependency graph, including `packages/contracts`, is inlined into one artefact** — rejected for this phase. It would close the gap, but it changes how NestJS itself is built and deployed — a materially larger surface than "one package needs a `dist/`" — and [ADR-0003](./0003-nestjs-fastify-api.md) does not specify a bundler for the API.
- **Built packages everywhere, from day one** — this is the option ADR-0001 already rejected as "Built packages (tsup/tsc per package)," and that reasoning still holds for packages only Next.js and Vitest consume. This ADR deliberately narrows the reversal to packages with a compiled-Node runtime consumer, not a blanket policy change.

## Consequences

**Accepted:** `packages/contracts` — and any future package `apps/api` depends on — now has a build step in the task graph: `pnpm build` runs before `test:unit`, wired through Turbo's `dependsOn`. Editing `packages/contracts` while iterating on `apps/api` requires that build to have run; it is Turbo-cached, so an unchanged package costs nothing to rebuild, but it is no longer literally zero steps for that pairing. There is now a `dist/` artefact that can go stale relative to `src/` if a script bypasses the task graph — `test/package-exports.test.ts` guards the specific failure mode a broken `exports` map produces, `dist/` is gitignored so a stale copy can never be committed, and `turbo.json`'s `build.outputs` names `tsconfig.build.tsbuildinfo` exactly (never a `*.tsbuildinfo` glob) so a `build` cache hit can never also restore a stale `typecheck` state file and cause `tsc -b` to skip checking entirely.

**Gained:** `apps/api` can run in production at all. `node dist/main.js` resolves `@metrika/contracts` the same way any published npm package resolves from compiled output — through `main`/`types`/`exports` pointing at compiled JavaScript — because that is the only resolution mode a bare-specifier import into already-compiled Node code supports. Packages Next.js and Vitest consume directly, and packages with no runtime import at all, keep ADR-0001's zero-build inner loop unchanged: this decision is scoped to the specific consumer that needed it, not applied as a blanket reversal.
