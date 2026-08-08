# ADR-0007 — Python for both workers; workers have no database access

**Status:** Accepted · **Date:** 2026-08-07

## Context

Geometry analysis requires Trimesh, NumPy, SciPy and Manifold3D — mature Python libraries with no adequate JavaScript equivalent. The slicing worker mostly invokes a binary and parses text, which any language does well.

## Decision

**Both workers in Python**, in one uv workspace with a shared `metrika_core` library and separate container images.

**Neither worker has database credentials.** Workers receive fully-formed inputs as Temporal activity arguments, read and write S3 under their own prefix-scoped IAM roles, and return structured results. The API is the only writer to Postgres.

## Alternatives

- **Slicer worker in Node** — arguably a better language fit for subprocess management and text parsing, and it would reuse the existing TypeScript contracts directly. Rejected because a second Temporal SDK, a second dependency toolchain, a second test harness and a second container base cost more than the marginal language fit — especially with agent-written code, where every additional runtime is another set of idioms to get wrong.
- **Everything in TypeScript with a WASM mesh library** — the available options are materially less capable than Trimesh, and mesh analysis correctness is not where to economise.
- **Workers writing directly to Postgres** — rejected. It would create dual schema ownership (Prisma and SQLAlchemy disagreeing), and it would put database credentials in the process most exposed to hostile input.

## Consequences

**Accepted:** A polyglot repository with two toolchains and two type systems. Contracts must cross the language boundary, handled by emitting JSON Schema from `packages/contracts` and generating pydantic models, verified in CI with `git diff --exit-code`. Python's memory behaviour under large meshes needs hard rlimits.

**Gained:** The best available mesh libraries. One worker runtime, one toolchain, one test harness. And the security property that matters most: an attacker achieving code execution in the mesh parser lands in a task with no network, no database credentials, a read-only filesystem and nothing but the file they already uploaded.
