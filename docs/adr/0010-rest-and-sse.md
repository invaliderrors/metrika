# ADR-0010 — REST over GraphQL; SSE over WebSockets until printer telemetry

**Status:** Accepted · **Date:** 2026-08-07

## Context

The API has one first-party consumer with well-known access patterns. It also needs to push processing progress — upload, analysis, preview, slicing, pricing — to the browser.

## Decision

**REST** at `/api/v1`, resource-oriented, cursor-paginated, with a generated typed client.

**Server-Sent Events** for progress. WebSockets are introduced at Phase 14 for printer telemetry, where bidirectional communication is genuinely required.

## Alternatives

- **GraphQL** — flexible querying and no over-fetching, but the flexibility solves a problem we do not have (one consumer, known patterns) while adding resolver N+1 risk, query-complexity limiting, and a harder authorization story where every field is an access-control decision.
- **tRPC** — see ADR-0009.
- **WebSockets for progress** — bidirectional capability that progress does not need, plus connection state to manage, sticky sessions or a pub/sub fan-out, and proxies that mishandle upgrades. SSE reconnects automatically and rides plain HTTP.
- **Polling** — simple, but either wasteful or laggy, and it makes a multi-minute pipeline feel broken.

## Consequences

**Accepted:** REST means some over-fetching and occasionally multiple round trips where GraphQL would do one. SSE is unidirectional, is limited to six concurrent connections per origin on HTTP/1.1 (a non-issue on HTTP/2), and needs a heartbeat to survive idle-connection timeouts.

**Gained:** OpenAPI for free, straightforward caching and authorization, trivial debuggability with `curl`, and a progress channel with automatic browser reconnection, `Last-Event-ID` resume, and no additional infrastructure.

**Implementation notes that are load-bearing:** the stream always sends current state first so a late client is immediately correct; it closes on a terminal state so finished models do not leak file descriptors; and on the client, events write into the TanStack Query cache rather than a parallel store, so there is one cache and one read path.
