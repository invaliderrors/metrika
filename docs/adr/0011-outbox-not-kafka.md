# ADR-0011 — Transactional outbox in Postgres, no message broker

**Status:** Accepted · **Date:** 2026-08-07

## Context

Four operations must commit a database change **and** reliably start or signal a Temporal workflow: upload completion, quote creation, order creation, and payment webhook processing. Starting the workflow inside the transaction risks an orphan if the transaction rolls back; starting it after commit risks losing it if the process dies in between.

## Decision

A transactional outbox. The workflow start is written as an `OutboxEvent` row in the same transaction as the state change. A poller reads unprocessed rows with `FOR UPDATE SKIP LOCKED` every 500 ms and starts or signals the workflow, then marks the row processed. A partial index on `WHERE processedAt IS NULL` keeps the query O(unprocessed).

Redelivery is harmless because workflow IDs are deterministic and duplicate starts are no-ops.

## Alternatives

- **Kafka** — partitioned throughput, replay, and a real event log. Rejected: nothing here needs partitioned throughput, replay is already provided by Temporal's execution history, and operating Kafka (or paying for MSK) is a burden with no matching benefit. Introducing it would be architecture as fashion, which the brief explicitly forbids.
- **SNS/SQS** — cheaper and managed, but adds an AWS dependency for four call sites and still requires an outbox to make the write atomic. The outbox alone is strictly simpler.
- **Starting workflows directly after commit** — a lost workflow whenever the process dies in the window. Rare, silent, and it would leave a model stuck in `UPLOADED` forever with no signal.
- **Two-phase commit** — not available across Postgres and Temporal, and not desirable.

## Consequences

**Accepted:** Up to ~500 ms of latency before a workflow starts. A polling loop to operate and monitor (outbox lag is a dashboard metric). The outbox table needs periodic pruning of processed rows.

**Gained:** Atomic "state change plus workflow start" with no distributed transaction, one small table, and consumers that are idempotent by database constraint. This is the complete answer to distributed transactions in this system — there are none.
