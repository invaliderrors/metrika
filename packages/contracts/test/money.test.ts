import { describe, expect, it } from 'vitest';
import { addMoney, CURRENCY_REGISTRY, Money, MoneyMismatchError, money, toBigInt } from '../src/index.js';

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
    expect(Money.safeParse({ amountMinor: '-500', currency: 'COP', exponent: 0 }).success).toBe(true);
  });

  it('rejects a non-integer amount string', () => {
    expect(Money.safeParse({ amountMinor: '1.5', currency: 'COP', exponent: 0 }).success).toBe(false);
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

  it('registry declares COP as exponent 0 — Colombian commerce uses whole pesos', () => {
    expect(CURRENCY_REGISTRY.COP.exponent).toBe(0);
  });

  // --- Additional edge cases beyond the brief ---
  // These guard the wire format's canonicality: an amount that round-trips
  // through bigint must have exactly one valid string representation, or
  // downstream equality checks and canonical hashing (Task 9) can treat two
  // serialisations of the same value as different.

  it('rejects a leading-zero amount string', () => {
    expect(Money.safeParse({ amountMinor: '0100', currency: 'COP', exponent: 0 }).success).toBe(false);
  });

  it('rejects an amount string with a leading plus sign', () => {
    expect(Money.safeParse({ amountMinor: '+500', currency: 'COP', exponent: 0 }).success).toBe(false);
  });

  it('rejects "-0" so zero has exactly one wire representation', () => {
    expect(Money.safeParse({ amountMinor: '-0', currency: 'COP', exponent: 0 }).success).toBe(false);
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

  it('rejects a non-integer exponent', () => {
    const bad = { ...money(1n, 'COP'), exponent: 2.5 };
    expect(Money.safeParse(bad).success).toBe(false);
  });

  it('rejects a negative exponent', () => {
    const bad = { ...money(1n, 'COP'), exponent: -1 };
    expect(Money.safeParse(bad).success).toBe(false);
  });
});
