# ADR-0017 — Admin as a route group in `apps/web` until Phase 11

**Status:** Accepted · **Date:** 2026-08-07

## Context

The brief proposes `apps/admin` as a separate application. Metrika will eventually need a real operations platform for manufacturing operators, finance and support. It does not need one before there are orders to operate on.

## Decision

Admin lives in `apps/web` as an `(admin)` route group with its own layout, its own middleware, and a platform-role gate. **`AdminModule` in the API is a separate module from day one** — that is where the isolation actually matters.

Extraction to `apps/admin` is scheduled for Phase 11 (full ops platform) or earlier if a concrete need arises. The extraction path is explicit: the route group moves, the shared `packages/ui` and `packages/api-client` already exist, and the API needs no change at all.

## Alternatives

- **Separate `apps/admin` from Phase 0** — doubles the build, deploy, environment and authentication surface immediately, to buy an isolation benefit that only becomes real when non-engineering staff use it daily. For a solo builder that is a meaningful, permanent tax paid up front.
- **Admin as API endpoints with no UI** — workable for a while, but manufacturing operators need a real interface by Phase 11, and building it under time pressure later is worse.

## Consequences

**Accepted:** The admin bundle ships within the same application. This is mitigated by route-group code splitting, so a customer never downloads admin code, but it is not the hard separation a distinct deployment gives. The blast radius of a frontend deployment covers both audiences.

**Gained:** One deployment, one authentication integration, one environment configuration, one CI pipeline. Shared components without an extra package boundary. Admin capability arrives incrementally alongside the features it administers rather than as a large separate project.

**The security-relevant part is already separated:** `AdminModule` in the API is distinct, platform roles live in their own table, elevated database access is a separate client that always audits, and none of that changes when the frontend is eventually split.
