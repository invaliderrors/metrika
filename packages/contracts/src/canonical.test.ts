import { describe, expect, it } from 'vitest';

import { canonicalJson, sha256Canonical } from './canonical.js';
import { moneyFromDecimalString, moneyToDecimalString } from './money.js';

describe('canonicalJson', () => {
  it('sorts object keys', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('drops undefined fields', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('is order-stable across equivalent objects', () => {
    const a = canonicalJson({ x: [1, 2], y: { p: 'q', r: 3 } });
    const b = canonicalJson({ y: { r: 3, p: 'q' }, x: [1, 2] });
    expect(a).toBe(b);
  });

  it('renders bigint as decimal string', () => {
    expect(canonicalJson({ n: 42n })).toBe('{"n":"42"}');
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow();
  });

  it('sha256Canonical is deterministic', () => {
    expect(sha256Canonical({ a: 1 })).toBe(sha256Canonical({ a: 1 }));
    expect(sha256Canonical({ a: 1 })).not.toBe(sha256Canonical({ a: 2 }));
  });
});

describe('money', () => {
  it('round-trips COP with exponent 2', () => {
    const m = { minorUnits: 123456n, currency: 'COP' as const, exponent: 2 };
    const s = moneyToDecimalString(m);
    expect(s).toBe('1234.56');
    expect(moneyFromDecimalString(s, 'COP', 2)).toEqual(m);
  });

  it('handles negative', () => {
    const m = { minorUnits: -50n, currency: 'USD' as const, exponent: 2 };
    expect(moneyToDecimalString(m)).toBe('-0.50');
  });

  it('handles zero exponent', () => {
    const m = { minorUnits: 7n, currency: 'USD' as const, exponent: 0 };
    expect(moneyToDecimalString(m)).toBe('7');
  });
});
