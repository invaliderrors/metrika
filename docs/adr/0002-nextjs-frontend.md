# ADR-0002 — Next.js App Router for the web application

**Status:** Accepted · **Date:** 2026-08-07

## Context

The frontend has two very different halves: data-heavy list and detail views (projects, models, quotes, orders, admin tables) that benefit from server rendering, and a WebGL 3D viewer plus a complex configuration form that are irreducibly client-side.

## Decision

Next.js with the App Router. React Server Components for the data-heavy halves; Client Components for the viewer, forms, uploads and anything with an SSE subscription. The standard pattern is an RSC page that fetches initial data and hands it to a client component as TanStack Query `initialData` — no loading flash, no request waterfall, full interactivity.

## Alternatives

- **Vite + React SPA** — simpler mental model, no RSC complexity, and honestly adequate. Rejected because every list view would then be a client-side fetch waterfall, and the marketing surface would need separate hosting or rendering.
- **Remix / React Router** — good nested-data story, smaller ecosystem for the React Three Fiber and shadcn tooling this project leans on.
- **Astro** — excellent for the marketing surface, wrong for a heavily interactive application.

## Consequences

**Accepted:** App Router has real complexity — the server/client boundary, caching semantics that have changed across versions, and error messages that are frequently unhelpful. The 3D viewer gains nothing from RSC. There is a genuine risk of accidentally moving domain logic into server actions, which ADR-0015 addresses explicitly.

**Gained:** Fast first paint on the pages users spend most of their time on, a smaller client bundle, per-pull-request preview deployments, and one framework covering both the marketing site and the application.
