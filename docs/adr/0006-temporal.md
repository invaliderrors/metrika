# ADR-0006 — Temporal Cloud for durable workflows

**Status:** Accepted · **Date:** 2026-08-07

## Context

Model processing and quote generation are multi-minute, multi-step, failure-prone, resumable and human-interruptible, and they produce a commercially binding result. They need retries, timeouts, heartbeats, cancellation, compensation, persisted intermediate state — and, hardest of all, **workflow versioning**: changing the pipeline while executions are in flight without corrupting them.

## Decision

Temporal, on **Temporal Cloud**. Workflow code in the TypeScript SDK inside a dedicated `apps/api` worker process; geometry and slicing activities dispatched to Python workers on their own task queues.

The workflow ID is the idempotency key (`model-processing:{modelVersionId}`, `quote:{quoteId}`) with `ALLOW_DUPLICATE_FAILED_ONLY`, which makes duplicate submission a platform-level no-op before any application code runs.

## Alternatives

- **Postgres job queue (Graphile Worker / pg-boss) + hand-written state machines** — genuinely viable, one less dependency, no bill. Rejected because workflow versioning would have to be hand-written, and that is the part that is hard to get right and expensive to get wrong. This remains the fallback if Temporal proves too heavy.
- **BullMQ + Redis** — Redis is not durable enough for state that must survive; the brief's own rule that Redis is never a source of truth rules it out.
- **AWS Step Functions** — durable and managed, but Amazon States Language is a poor fit for logic this branchy, and local development is markedly worse.
- **Self-hosted Temporal** — rejected. Frontend, history, matching and worker services plus Cassandra or a large Postgres is a platform team's workload, and there is no platform team.

## Consequences

**Accepted:** A real learning investment (roughly two weeks). One more container in local development. A monthly bill that scales with actions, which makes chatty workflows genuinely more expensive. Non-determinism bugs are confusing the first time — mitigated by a dedicated ESLint profile that bans `Date`, `Math`, `crypto`, `node:*` and infrastructure imports inside `workflows/**`, so the class of bug is caught mechanically rather than at replay time.

**Gained:** Retries, timeouts, heartbeats, cancellation and versioning solved. Free idempotency at the workflow level. Human-in-the-loop steps become a signal with a timeout rather than a polling loop. Complete execution history for support forensics, queryable by business identifier.
