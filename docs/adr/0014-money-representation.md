# ADR-0014 — Integer minor units + explicit exponent + versioned rounding policy

**Status:** Accepted · **Date:** 2026-08-07

## Context

Colombian pesos are the initial currency. ISO 4217 assigns COP two minor units, but Colombian commerce operates in whole pesos and commonly rounds to the nearest 50. Future currencies will have different exponents. Prices are built from many multiplications of rates and factors.

## Decision

```ts
Money = { amountMinor: bigint, currency: CurrencyCode, exponent: number }
```

- `BigInt` in Postgres, `bigint` in TypeScript, **decimal strings on the wire** (JSON has no integer type wide enough to trust).
- **The exponent travels with the amount.** Every money-bearing row stores `currencyExponent`; every `Money` object carries it.
- **Rounding is a versioned policy** on `PricingRuleSetVersion` — mode, exponent, and an optional `totalRoundToNearestMinor` — not a constant in code.
- Arithmetic happens in `Decimal` at full precision and rounds at exactly two declared points: once per displayed line, once on the authoritative total.
- Because `sum(round(lines)) ≠ round(sum(lines))`, the total is authoritative and an explicit `ROUNDING_ADJUSTMENT` trace line reconciles the displayed lines to it.

## Alternatives

- **Floating point** — forbidden by rule §105.8 and by arithmetic.
- **`Decimal` columns for money** — better than float, but invites reintroducing float at the JSON boundary and leaves the exponent implicit.
- **Minor units without a stored exponent** — the tempting shortcut, and the one that guarantees someone eventually renders 350000 COP as `$3,500.00`.
- **A money library (dinero.js)** — reasonable, but the rounding policy must be versioned data rather than library configuration, and the arithmetic surface actually needed here is small.

## Consequences

**Accepted:** `bigint` does not serialise to JSON natively, so contract schemas carry decimal strings and the boundary conversion must be tested. Storing the exponent per money-bearing row is mild denormalisation. Two rounding points plus a reconciliation line is more machinery than a naive implementation.

**Gained:** No floating-point money anywhere. Currency-correct display driven by data rather than by a hardcoded assumption. Deterministic, reproducible, auditable rounding — and a reconciliation line that explains the discrepancy rather than leaving it to generate support tickets forever.

**Residual risk:** `Money.exponent` is deliberately not cross-checked against `CURRENCY_REGISTRY` at parse time — pinning a stored value to today's registry would make an old quote unparseable the moment a currency's used exponent changes, which breaks the reconstruct-indefinitely property that carrying the exponent per value exists to protect. That leaves a gap: nothing in `packages/contracts` stops a request from supplying an `exponent` that doesn't match the `currency` it claims. Closing that gap is `apps/api`'s job, not `Money`'s: validate `exponent` against `CURRENCY_REGISTRY` at the API request boundary, where "today's registry" is exactly the right authority, and leave already-persisted `Money` values unvalidated against it.
