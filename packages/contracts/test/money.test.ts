import { describe, expect, it } from 'vitest';
import {
  addMoney,
  CURRENCY_REGISTRY,
  CurrencyCode,
  Money,
  MoneyMismatchError,
  money,
  toBigInt,
} from '../src/index.js';

describe('Money', () => {
  it('constructs COP with exponent 0 from the registry', () => {
    const m = money(350_000n, 'COP');
    expect(m).toEqual({ amountMinor: '350000', currency: 'COP', exponent: 0 });
  });

  it('constructs USD with exponent 2', () => {
    expect(money(1999n, 'USD').exponent).toBe(2);
  });

  it('round-trips through bigint without precision loss beyond Number.MAX_SAFE_INTEGER', () => {
    const huge = 9_007_199_254_740_993n; // MAX_SAFE_INTEGER + 2
    expect(toBigInt(money(huge, 'COP'))).toBe(huge);
  });

  it('serialises the amount as a string, never a number', () => {
    expect(typeof money(1n, 'COP').amountMinor).toBe('string');
  });

  it('parses a valid wire representation', () => {
    expect(Money.safeParse({ amountMinor: '-500', currency: 'COP', exponent: 0 }).success).toBe(
      true,
    );
  });

  it('rejects a non-integer amount string', () => {
    expect(Money.safeParse({ amountMinor: '1.5', currency: 'COP', exponent: 0 }).success).toBe(
      false,
    );
  });

  it('rejects a numeric amount', () => {
    expect(Money.safeParse({ amountMinor: 100, currency: 'COP', exponent: 0 }).success).toBe(false);
  });

  it('adds amounts of the same currency', () => {
    expect(addMoney(money(100n, 'COP'), money(250n, 'COP')).amountMinor).toBe('350');
  });

  it('throws when currencies differ', () => {
    expect(() => addMoney(money(1n, 'COP'), money(1n, 'USD'))).toThrow(MoneyMismatchError);
  });

  it('throws when exponents differ for the same currency', () => {
    const odd = { ...money(1n, 'COP'), exponent: 2 };
    expect(() => addMoney(money(1n, 'COP'), odd)).toThrow(MoneyMismatchError);
  });

  it('names the thrown error MoneyMismatchError, not the generic Error', () => {
    // toThrow(MoneyMismatchError) checks `instanceof`, which passes even if
    // `.name` regresses to the inherited "Error" — a divergence that would
    // silently corrupt every serialised log line. Assert `.name` directly.
    try {
      addMoney(money(1n, 'COP'), money(1n, 'USD'));
      expect.unreachable('addMoney should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MoneyMismatchError);
      expect((err as MoneyMismatchError).name).toBe('MoneyMismatchError');
    }
  });

  it('preserves both operands on the thrown error for diagnostics', () => {
    const a = money(1n, 'COP');
    const b = money(1n, 'USD');
    try {
      addMoney(a, b);
      expect.unreachable('addMoney should have thrown');
    } catch (err) {
      expect((err as MoneyMismatchError).a).toEqual(a);
      expect((err as MoneyMismatchError).b).toEqual(b);
    }
  });

  it('registry declares COP as exponent 0 — Colombian commerce uses whole pesos', () => {
    expect(CURRENCY_REGISTRY.COP.exponent).toBe(0);
  });

  // --- Additional edge cases beyond the brief ---
  // These guard the wire format's canonicality: an amount that round-trips
  // through bigint must have exactly one valid string representation, or
  // downstream equality checks and canonical hashing (Task 9) can treat two
  // serialisations of the same value as different.

  it('rejects a leading-zero amount string', () => {
    expect(Money.safeParse({ amountMinor: '0100', currency: 'COP', exponent: 0 }).success).toBe(
      false,
    );
  });

  it('rejects an amount string with a leading plus sign', () => {
    expect(Money.safeParse({ amountMinor: '+500', currency: 'COP', exponent: 0 }).success).toBe(
      false,
    );
  });

  it('rejects "-0" so zero has exactly one wire representation', () => {
    expect(Money.safeParse({ amountMinor: '-0', currency: 'COP', exponent: 0 }).success).toBe(
      false,
    );
  });

  it('accepts and round-trips a zero amount', () => {
    expect(Money.safeParse({ amountMinor: '0', currency: 'COP', exponent: 0 }).success).toBe(true);
    expect(toBigInt(money(0n, 'COP'))).toBe(0n);
  });

  it('sums to the canonical "0", never "-0", when amounts cancel out', () => {
    const sum = addMoney(money(500n, 'COP'), money(-500n, 'COP'));
    expect(sum.amountMinor).toBe('0');
  });

  it('adds a negative amount correctly, for refunds and adjustments', () => {
    expect(addMoney(money(1000n, 'COP'), money(-300n, 'COP')).amountMinor).toBe('700');
  });

  it('adds two amounts well beyond Number.MAX_SAFE_INTEGER without precision loss', () => {
    // toBigInt/money round-tripping a single huge value beyond 2^53 is
    // covered above, but addMoney does its own bigint arithmetic — a
    // regression to Number-based addition here would corrupt the result
    // only above 2^53, exactly where a naive test using small numbers would
    // never catch it.
    const big1 = 9_007_199_254_740_993n; // MAX_SAFE_INTEGER + 2
    const big2 = 9_007_199_254_740_995n; // MAX_SAFE_INTEGER + 4
    expect(addMoney(money(big1, 'COP'), money(big2, 'COP')).amountMinor).toBe('18014398509481988');
  });

  it('rejects a non-integer exponent', () => {
    const bad = { ...money(1n, 'COP'), exponent: 2.5 };
    expect(Money.safeParse(bad).success).toBe(false);
  });

  it('rejects a negative exponent', () => {
    const bad = { ...money(1n, 'COP'), exponent: -1 };
    expect(Money.safeParse(bad).success).toBe(false);
  });

  it('rejects an exponent above the declared upper bound', () => {
    const bad = { ...money(1n, 'COP'), exponent: 5 };
    expect(Money.safeParse(bad).success).toBe(false);
  });

  // `Money.currency: CurrencyCode` widening to `z.string()` survives every
  // test above unnoticed: every fixture here already uses a real currency
  // code, so nothing exercises the boundary of the enum itself. As with
  // `DomainErrorCode` (see result.test.ts), the closed-set membership needs
  // an independent, hard-coded assertion — `.options` trivially equals
  // itself on any enum, including a widened `z.string()` masquerading as one.

  it('CurrencyCode is exactly this set of four codes, in this order', () => {
    expect(CurrencyCode.options).toEqual(['COP', 'USD', 'EUR', 'MXN']);
  });

  it('rejects an unlisted currency code', () => {
    expect(Money.safeParse({ amountMinor: '0', currency: 'GBP', exponent: 0 }).success).toBe(
      false,
    );
  });
});
