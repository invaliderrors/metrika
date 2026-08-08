# ADR-0003 — NestJS on Fastify as a modular monolith

**Status:** Accepted · **Date:** 2026-08-07

## Context

The API needs clear module boundaries that can eventually become separate services, dependency injection for testability, and enough structure that an AI agent editing one module does not accidentally reach into another.

## Decision

NestJS with the Fastify adapter, structured as a modular monolith. One module per bounded context, each with the same internal shape: `api/` (transport), `application/` (use cases), `domain/` (pure), `infrastructure/` (adapters), `policies/` (pure authorization). Modules form a DAG; where a lower module must react to a higher one it subscribes to a domain event rather than being injected.

## Alternatives

- **Fastify alone** — faster and far less magic, but every boundary would be a convention rather than a structure. With no code reviewer, structure that the framework enforces is worth more than the overhead it costs.
- **Express** — slower, weaker TypeScript story, no reason to prefer it.
- **Hono / Elysia** — excellent and modern, but no established modular architecture for a system this size.
- **Microservices from the start** — rejected outright. No independent scaling need, no team boundaries to mirror, and it would make quote acceptance → order creation a distributed transaction for no benefit.

## Consequences

**Accepted:** NestJS is decorator-heavy and its documentation assumes Jest and class-validator, both of which this project rejects (Vitest and Zod respectively) — expect to adapt examples. DI adds indirection when reading code cold. The framework has opinions that occasionally fight `verbatimModuleSyntax`.

**Gained:** Module boundaries the framework enforces, trivially mockable dependencies, a natural place for guards and interceptors (authorization, request context, exception mapping), and Fastify's throughput and schema-based serialisation. Extracting a module into its own service later is a deployment change, not a rewrite.
