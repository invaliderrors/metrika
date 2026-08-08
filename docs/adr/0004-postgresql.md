# ADR-0004 — PostgreSQL as the single operational database

**Status:** Accepted · **Date:** 2026-08-07

## Context

The system needs: multi-statement transactions (quote acceptance → order creation), row-level tenant isolation, semi-structured storage for heuristics and pricing traces, exact decimal arithmetic, partial and expression indexes, and a durable outbox.

## Decision

PostgreSQL 16 on RDS. One database. No secondary operational datastore beyond Redis for ephemeral concerns.

## Alternatives

- **MySQL** — no row-level security, weaker JSONB, weaker partial indexes. RLS alone decides it.
- **MongoDB** — the domain is deeply relational and correctness depends on transactional integrity across entities. Wrong tool.
- **CockroachDB / Aurora** — real horizontal scaling, but nothing here needs it and both add cost and operational nuance. Aurora is a plausible upgrade path later without a schema change.
- **A separate analytics store** — premature. Postgres handles the reporting volume this business will have for years.

## Consequences

**Accepted:** A single write primary is eventually a scaling ceiling. Postgres enum changes require care (adding is safe; removing needs expand/contract). Connection count needs PgBouncer once Fargate tasks scale.

**Gained:** Every feature this architecture relies on in one system: RLS for tenant isolation, JSONB for heuristics and traces, `numeric` for exact decimals, partial indexes for the outbox poller and quote sweeper, `FOR UPDATE SKIP LOCKED` for the outbox, and real transactions for the one atomic operation that matters most.
