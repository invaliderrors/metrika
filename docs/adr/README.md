# Architecture Decision Records

An ADR captures a decision, the alternatives considered, and the consequences accepted — including the bad ones.

**ADRs are immutable.** A decision is superseded by a new ADR, never edited. If the reasoning here turns out to be wrong, that is itself worth preserving.

| #                                                 | Decision                                                                                 | Status                                |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------- |
| [0001](./0001-monorepo-strategy.md)               | pnpm workspaces + Turborepo, source-only internal packages                               | Accepted                              |
| [0002](./0002-nextjs-frontend.md)                 | Next.js App Router for the web application                                               | Accepted                              |
| [0003](./0003-nestjs-fastify-api.md)              | NestJS on Fastify as a modular monolith                                                  | Accepted                              |
| [0004](./0004-postgresql.md)                      | PostgreSQL as the single operational database                                            | Accepted                              |
| [0005](./0005-prisma.md)                          | Prisma as ORM, confined to the persistence layer                                         | Accepted                              |
| [0006](./0006-temporal.md)                        | Temporal Cloud for durable workflows                                                     | Accepted                              |
| [0007](./0007-python-workers.md)                  | Python for both geometry and slicing workers; workers have no database access            | Accepted                              |
| [0008](./0008-prusaslicer.md)                     | PrusaSlicer CLI behind a `SlicerEngine` port                                             | Superseded by ADR-0022                |
| [0009](./0009-ts-rest-contracts.md)               | Zod as the single source of truth, delivered via ts-rest                                 | Superseded by ADR-0019                |
| [0010](./0010-rest-and-sse.md)                    | REST over GraphQL; SSE over WebSockets until printer telemetry                           | Accepted                              |
| [0011](./0011-outbox-not-kafka.md)                | Transactional outbox in Postgres, no message broker                                      | Accepted                              |
| [0012](./0012-authentication.md)                  | Clerk for authentication only; Metrika owns organizations                                | Accepted                              |
| [0013](./0013-authorization.md)                   | Pure policy functions + `AuthContext` repositories + Postgres RLS                        | Accepted                              |
| [0014](./0014-money-representation.md)            | Integer minor units + explicit exponent + versioned rounding policy                      | Accepted                              |
| [0015](./0015-server-actions.md)                  | Server Actions restricted to three non-domain uses                                       | Accepted                              |
| [0016](./0016-aws-terraform-vercel.md)            | AWS + Terraform for backend; Vercel for the web app                                      | Accepted                              |
| [0017](./0017-admin-in-web.md)                    | Admin as a route group in `apps/web` until Phase 11                                      | Accepted                              |
| [0018](./0018-branded-types.md)                   | Brand entity IDs and money-adjacent units; nothing else                                  | Accepted                              |
| [0019](./0019-nestjs-zod-contracts.md)            | Zod as the single source of truth, delivered via `nestjs-zod`                            | Accepted, supersedes ADR-0009         |
| [0020](./0020-internal-package-build-output.md)   | Internal packages `apps/api` depends on emit compiled `dist/`, not source-only `exports` | Accepted, supersedes part of ADR-0001 |
| [0021](./0021-next-major-and-frontend-stack.md)   | Next.js 16 and the pinned frontend stack, gated on a measured spike                      | Accepted                              |
| [0022](./0022-orcaslicer.md)                      | OrcaSlicer CLI behind the `SlicerEngine` port                                            | Accepted, supersedes ADR-0008         |
| [0023](./0023-eslint-plugin-resolution.md)        | An ESLint plugin is declared where it is imported, and nowhere else                      | Accepted, scopes part of ADR-0021     |
| [0024](./0024-types-node-pin.md)                  | `@types/node` tracks the Node major in `.nvmrc`, not the registry's latest               | Accepted, scopes part of ADR-0021     |
| [0025](./0025-radix-umbrella.md)                  | `radix-ui` umbrella over `@radix-ui/react-slot`, because the shadcn registry emits it    | Accepted                              |
| [0026](./0026-web-consumes-compiled-contracts.md) | `apps/web` consumes compiled `dist/` too, so ADR-0020's scoping sentence is wrong        | Accepted, scopes part of ADR-0020     |
| [0027](./0027-python-toolchain.md)                | Python 3.12 and the pinned worker toolchain, gated on a measured spike                   | Accepted, scopes part of ADR-0007     |
