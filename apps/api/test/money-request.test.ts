import { describe, expect, it } from 'vitest';
import { MoneyRequest } from '../src/shared/http/money-request.schema.js';

describe('MoneyRequest', () => {
  it('accepts COP at exponent 0, as Colombian commerce uses it', () => {
    expect(
      MoneyRequest.safeParse({ amountMinor: '350000', currency: 'COP', exponent: 0 }).success,
    ).toBe(true);
  });

  it('rejects COP at exponent 2 — ISO 4217 says two, the registry says nought, and $3,500.00 is wrong', () => {
    expect(
      MoneyRequest.safeParse({ amountMinor: '350000', currency: 'COP', exponent: 2 }).success,
    ).toBe(false);
  });

  it('accepts USD at exponent 2', () => {
    expect(
      MoneyRequest.safeParse({ amountMinor: '1999', currency: 'USD', exponent: 2 }).success,
    ).toBe(true);
  });

  it('rejects USD at exponent 0', () => {
    expect(
      MoneyRequest.safeParse({ amountMinor: '1999', currency: 'USD', exponent: 0 }).success,
    ).toBe(false);
  });

  it('names the exponent in the issue path, so the error is actionable', () => {
    const result = MoneyRequest.safeParse({ amountMinor: '1', currency: 'COP', exponent: 2 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['exponent']);
    }
  });

  it('still rejects everything base Money rejects', () => {
    expect(MoneyRequest.safeParse({ amountMinor: 100, currency: 'COP', exponent: 0 }).success).toBe(
      false,
    );
    expect(
      MoneyRequest.safeParse({ amountMinor: '1.5', currency: 'COP', exponent: 0 }).success,
    ).toBe(false);
  });
});
