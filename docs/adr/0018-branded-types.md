# ADR-0018 — Brand entity IDs and money-adjacent units; nothing else

**Status:** Accepted · **Date:** 2026-08-07 · Scoped in part by [ADR-0041](./0041-repository-location.md)

## Context

Two mix-ups in this system cause real damage: passing a `ProjectId` where a `ModelId` belongs (which the type system would otherwise permit, since both are strings), and passing grams where cubic millimetres belong (which produces a wrong price). Branding everything would prevent more, at a cost.

## Decision

Brand **every entity ID** and **the five physical quantities that flow into money**: `Millimeters`, `CubicMillimeters`, `Grams`, `Seconds`, `MinorUnits`. Defined once via Zod `.brand()` in `packages/contracts`, so the runtime schema and the compile-time type cannot drift.

Do **not** brand ordinary strings, emails, names, or arbitrary numbers.

Database strings become branded IDs at exactly one place: a single `brandUnsafe` helper, importable only from `apps/api/src/infrastructure/persistence/**`, enforced by an ESLint zone.

## Alternatives

- **Brand everything** — requires a units algebra (`add`, `mul`, `div` helpers for every pair of quantities) because arithmetic on branded numbers does not type-check. That is real, permanent friction on every calculation, for benefit concentrated in a small number of quantities.
- **Brand nothing** — the mix-ups above become runtime bugs, and the pricing ones become wrong invoices. Rejected.
- **Parse every ID from the database with Zod** — correct, but wasteful on every read for values the database already guarantees.
- **Nominal types via a class wrapper** — heavier, worse ergonomics, and it does not survive JSON serialisation.

## Consequences

**Accepted:** One controlled type assertion exists in the codebase. It is deliberately named `brandUnsafe` so nobody reaches for it casually, it is confined to one directory by lint, and it is the documented exception to "no unsafe assertions as routine practice". Branded quantities need explicit construction at boundaries.

**Gained:** `computePrice` cannot be called with a raw number where `Grams` is expected. A repository method cannot be handed the wrong entity's ID. Both failures become compile errors rather than a wrong price or a leaked record — and the branding investment is concentrated exactly where the consequences are financial.
