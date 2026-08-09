# ADR-0009 — Zod as the single source of truth, delivered via ts-rest

**Status:** Superseded by [ADR-0019](./0019-nestjs-zod-contracts.md) · **Date:** 2026-08-07

## Context

The conventional NestJS stack maintains four definitions of every concept: a class-validator DTO, a Swagger annotation, a frontend interface, and a worker-side model. They drift, and every drift is a production bug that types did not catch because each side was internally consistent.

## Decision

Define each concept once, in Zod, in `packages/contracts`. Derive everything else: TypeScript types via `z.infer`, runtime validation and server type-checking via `@ts-rest/nest`, OpenAPI 3.1 via `@ts-rest/open-api`, a typed client with TanStack Query bindings via `@ts-rest/react-query`, and pydantic models for the Python workers via JSON Schema emission verified in CI.

## Alternatives

- **`nestjs-zod` + `orval`** — Zod for validation and OpenAPI, with the client generated from the emitted spec. More conventional, more replaceable, but adds a codegen step and produces a less pleasant client. **This is the documented fallback.**
- **class-validator + `@nestjs/swagger`** — the default NestJS path. Rejected: it requires a second schema definition alongside Zod, which is precisely the duplication being eliminated.
- **tRPC** — excellent end-to-end types, but it abandons REST and OpenAPI, which closes off a future public API and makes the service harder to consume from anything that is not our own TypeScript client.

## Consequences

**Accepted:** ts-rest has a smaller community than `@nestjs/swagger`, and it constrains the API shape to what its router can express. Abandonment is a real if unlikely risk.

**Why the risk is bounded:** the source of truth is Zod, not ts-rest. The contract objects are thin structural wrappers around schemas that would survive unchanged. Migrating off means hand-writing controllers and generating a client from the emitted OpenAPI — roughly a week, not a rewrite.

**Spike gate.** Before committing, Phase 0 verifies compatibility with the chosen Zod major version, NestJS on the Fastify adapter, and valid OpenAPI 3.1 emission. If any of those fail, take the fallback. This ADR is superseded rather than edited if that happens.

**Gained:** One definition per concept, across four consumers and two languages. A response missing a field does not compile.
