# ADR-0005 — Prisma as ORM, confined to the persistence layer

**Status:** Accepted · **Date:** 2026-08-07

## Context

The schema is large and will evolve constantly. Migrations must be safe in production. Types must be generated, not hand-written. But the domain must not be shaped by the ORM.

## Decision

Prisma, with two constraints:

1. **`@prisma/client` may only be imported from `apps/api/src/infrastructure/persistence/**`**, enforced by an ESLint zone. Nothing else in the codebase knows Prisma exists.
2. **No generic `Repository<T>` wrapper.** Prisma is used directly for straightforward reads and writes. Explicit repository interfaces exist only for aggregates with invariants that must not be bypassed — `Quote`, `Order`, `ModelVersion`, `SliceJob` — and they expose intent-revealing methods (`findAcceptableQuote(id, ctx)`), never `findMany(args)`.

RLS, soft deletion and ID branding are applied through client extensions so they cannot be forgotten.

## Alternatives

- **Drizzle** — better raw SQL ergonomics, lighter runtime, no `exactOptionalPropertyTypes` friction. Its migration tooling is less mature, and migration safety matters more here than query ergonomics.
- **Kysely** — excellent types, but no migration story and no schema file as a readable source of truth.
- **TypeORM** — rejected; a long history of correctness problems.
- **Wrapping everything in generic repositories** — rejected explicitly. It adds a layer of indirection that duplicates what Prisma already provides, and produces the "meaningless interface" pattern the brief warns against.

## Consequences

**Accepted:** Prisma's generated types do not model `prop?: T` versus `prop: T | undefined`, so `exactOptionalPropertyTypes` requires conditional spreads in the mapping layer — documented once, confined to one directory. Complex analytical queries need `$queryRaw` with tagged templates. The client extension approach for RLS must be correct or nothing works.

**Gained:** A readable schema file as the single source of truth, safe generated migrations, generated types, and a hard structural boundary between persistence and everything else.
