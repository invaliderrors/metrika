# ADR-0015 — Server Actions restricted to three non-domain uses

**Status:** Accepted · **Date:** 2026-08-07

## Context

Next.js Server Actions make it trivial to write a server-side mutation from a component. That convenience is precisely the risk: the NestJS API is the business API, and a second mutation path would be a second, untyped, unauthorized-by-default entry point into the domain.

## Decision

Server Actions are used for **exactly three things**:

1. Cookie and session mutations (locale preference, UI settings).
2. The SSE relay route, where a Next route handler proxies the API stream to preserve same-origin semantics.
3. Form posts touching only Vercel-side concerns.

**No domain mutation uses a Server Action.** Uploads, configuration, quotes, acceptance, checkout and admin operations all go through `packages/api-client` to the NestJS API.

## Alternatives

- **Server Actions for everything** — would duplicate authorization, validation, rate limiting, audit logging and error mapping in a second runtime, or would proxy to the API anyway with an extra hop. Either way it violates "one source of truth per concept".
- **Never use them** — cleaner as a rule, but cookie mutations genuinely need a server round trip and a route handler for each is more ceremony than value.

## Consequences

**Accepted:** Two mutation mechanisms exist in the codebase, and the boundary between them must be understood. This is exactly why it is written down and why the list is closed at three rather than described as a principle.

**Gained:** One place where business rules live. Authorization, validation, rate limiting, idempotency and audit logging happen once. The API remains fully usable by a future mobile client or public API without any logic living in the Next.js layer.

**Enforcement:** a lint rule flags `'use server'` outside `apps/web/src/app/**/actions.ts` and `apps/web/src/lib/session/**`. New files in those locations are the review trigger.
