# Metrika

Digital manufacturing platform for professional 3D printing. Upload a 3D model, get an interactive preview and geometry diagnostics, configure manufacturing parameters at architectural scale, receive a real slicing-based quote, and place an order.

Initial market: Colombia (`es-CO`, COP). Initial customers: architects and architecture studios. The architecture is internationalisation-ready and does not hardcode Colombia-specific business rules in the domain.

> **Status: architecture blueprint.** No application code has been written yet. The complete engineering plan lives in [`docs/`](./docs/) and is intended to be executable without re-deriving fundamental decisions.

---

## Start here

| If you want to…              | Read                                                     |
| ---------------------------- | -------------------------------------------------------- |
| Understand the whole system  | [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)           |
| Know what to build next      | [docs/ROADMAP.md](./docs/ROADMAP.md)                     |
| Understand the data model    | [docs/DOMAIN_MODEL.md](./docs/DOMAIN_MODEL.md)           |
| Know why a decision was made | [docs/adr/](./docs/adr/)                                 |
| Get running locally          | [docs/LOCAL_DEVELOPMENT.md](./docs/LOCAL_DEVELOPMENT.md) |
| Contribute                   | [CONTRIBUTING.md](./CONTRIBUTING.md)                     |
| Report a vulnerability       | [SECURITY.md](./SECURITY.md)                             |

Deep dives: [3D pipeline](./docs/3D_PIPELINE.md) · [slicing](./docs/SLICING.md) · [pricing engine](./docs/PRICING_ENGINE.md) · [contracts & API](./docs/CONTRACTS_AND_API.md) · [workflows & events](./docs/WORKFLOWS.md) · [security & threat model](./docs/SECURITY.md) · [observability](./docs/OBSERVABILITY.md) · [testing](./docs/TESTING.md) · [TypeScript & tooling](./docs/TYPESCRIPT_AND_TOOLING.md) · [infrastructure](./docs/INFRASTRUCTURE.md) · [printer integration](./docs/PRINTER_INTEGRATION.md) · [risk register](./docs/RISK_REGISTER.md)

---

## The core idea

Everything in this architecture is subordinate to one property:

> For any accepted quote, the system must be able to reconstruct the exact chain of inputs that produced its price — model version, geometry analysis, slicer version, printer profile, material profile, print configuration, pricing rule set — indefinitely, after every one of those has changed.

That requirement is what drives immutable versioned configuration, content-addressed inputs, pure computation kernels, and durable orchestration. It is not scale that makes this system hard.

## Shape

```
apps/web        Next.js — customer platform + (admin) route group
apps/api        NestJS + Fastify — modular monolith, sole writer to Postgres
apps/workers    Python — geometry (Trimesh, Manifold3D) and slicing (PrusaSlicer). No database access.
packages/       contracts · pricing-engine · api-client · database · ui · printer-sdk · configs · testing
infra/          terraform · docker
```

Orchestrated by **Temporal Cloud**. Storage in **S3**. Data in **PostgreSQL** with row-level security.

## Stack

Next.js · React Three Fiber · Tailwind · shadcn/ui · TanStack Query · Zustand · NestJS · Fastify · Prisma · PostgreSQL · Redis · Temporal · Python · Trimesh · Manifold3D · PrusaSlicer · Zod · ts-rest · AWS ECS Fargate · Terraform · OpenTelemetry · Vitest · Playwright · pnpm · Turborepo · uv

## Quick start

Not yet implementable — Phase 0 has not been built. The target experience, verified by CI once it exists:

```bash
pnpm install
cp .env.example .env.local
docker compose up -d
pnpm db:migrate && pnpm db:seed
pnpm dev
```

See [docs/LOCAL_DEVELOPMENT.md](./docs/LOCAL_DEVELOPMENT.md).

## Engineering rules

Non-negotiable, enforced by types, lint rules, database constraints and CI:

1. No `any` as a shortcut. External data is `unknown` and is parsed.
2. No business logic in controllers or React components.
3. No floating-point money.
4. No heavy geometry work during an HTTP request.
5. No silently destructive model repairs.
6. No unversioned pricing or manufacturing profiles.
7. No accepted quote without a reproducible configuration.
8. No hardware-specific logic in the order domain.
9. No `process.env` outside the two config modules.
10. No database model exposed directly as an API response.
11. No random booleans for lifecycle state — enums plus a persisted transition log.
12. No microservices or distributed infrastructure without an operational reason.

The full list, with rationale, is in [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## Licence

Proprietary. All rights reserved.

Third-party licences — in particular PrusaSlicer (AGPL-3.0) — are subject to formal legal review as a launch gate. See [docs/SLICING.md](./docs/SLICING.md#3-licensing--an-open-launch-blocking-question).
