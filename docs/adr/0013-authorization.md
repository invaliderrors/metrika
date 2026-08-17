# ADR-0013 — Pure policy functions + `AuthContext` repositories + Postgres RLS

**Status:** Accepted · **Date:** 2026-08-07 · Scoped in part by [ADR-0041](./0041-repository-location.md)

## Context

IDOR is the most likely real vulnerability in a multi-tenant application, and the consequence here is a leaked architectural design — the highest-value asset in the system. There is no second pair of human eyes to catch a query missing its tenant predicate.

## Decision

Three independent layers, all required.

1. **Pure policy functions** — one file per resource, taking the **loaded resource** rather than an ID. Load-then-authorize forces the tenancy predicate into the query. 100% branch coverage.
2. **`AuthContext` in every repository signature** — there is no method signature that permits forgetting who is asking.
3. **Postgres row-level security** — `app.current_org_id` set per transaction by a Prisma client extension. A query escaping both application layers returns zero rows.

Platform staff roles live in a separate `PlatformRoleAssignment` table, so an internal account can never be confused with a customer membership.

## Alternatives

- **CASL** — capable, but ability construction becomes muddy as rules grow, and it is harder to test exhaustively than a plain function.
- **OpenFGA / Cedar / SpiceDB** — the right answer at a scale with complex relationship-based permissions. Overkill now, and additional infrastructure.
- **Checks in controllers** — the pattern the brief explicitly rejects, and correctly.
- **Application checks alone, without RLS** — rejected. Retrofitting RLS later means auditing every query ever written; adding it now costs one client extension.

## Consequences

**Accepted:** RLS adds a client extension that must be correct or nothing works, and it surprises anyone connecting with raw `psql` (deliberately — local development should behave like production). Load-then-authorize means one extra fetch before some denials. Three layers is genuine redundancy.

**Gained:** Policies are pure functions, so they are exhaustively testable as truth tables. The automated cross-tenant IDOR suite is generated from the route table and runs on every pull request, so adding an unprotected route fails CI immediately. And RLS is proven independently, with the application check bypassed — because the point of a backstop is that it works when the primary control has failed.
