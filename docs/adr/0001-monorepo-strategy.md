# ADR-0001 — Monorepo: pnpm workspaces + Turborepo, source-only internal packages

**Status:** Accepted · **Date:** 2026-08-07

## Context

Metrika spans a Next.js app, a NestJS API, two Python workers, shared TypeScript packages, Terraform and documentation. Contracts must stay synchronised across all of them. A single engineer working with AI agents needs changes to propagate immediately and boundaries to be enforced mechanically.

## Decision

One repository. pnpm workspaces for Node packages; a separate uv workspace rooted at `apps/workers/` for Python, invoked through Turbo via thin `package.json` shims. Turborepo for task orchestration with remote caching enabled from day one.

**Internal packages are source-only**: `"exports": { ".": "./src/index.ts" }`, consumed by Next through `transpilePackages`, by the API through TypeScript project references, and by Vitest natively. Correctness comes from a separate cached `typecheck` task (`tsc -b`), not from a build step in the inner loop.

## Alternatives

- **Polyrepo** — rejected. Cross-repo contract synchronisation is exactly the failure mode this design is built to avoid.
- **Nx** — better generators and built-in module-boundary enforcement, but a larger surface to learn and configure. Boundary enforcement here is done with ESLint `no-restricted-imports` zones, which are explicit, readable and version-controlled as plain rules.
- **Built packages (tsup/tsc per package)** — rejected for the inner loop. Editing a contract would require a watch-mode rebuild before it was visible, which is friction paid on every single change.
- **pnpm managing Python** — rejected. uv owns Python dependency resolution; pretending otherwise produces two lockfiles that disagree.

## Consequences

**Accepted:** Turbo's cache invalidation has subtleties that will occasionally confuse. Source-only packages mean consumers must be able to transpile TypeScript, which constrains what can consume them. Two dependency managers means two lockfiles to keep current.

**Gained:** A contract change is visible everywhere instantly. CI on an unchanged package costs nothing. Package boundaries are enforced by module resolution (`exports` blocks deep imports) rather than by convention.
