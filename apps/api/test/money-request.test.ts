import { Money } from '@metrika/contracts';
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

  it('refines Money rather than replacing it — a STORED stale exponent still parses', () => {
    // The other direction, and the reason this schema exists in apps/api instead
    // of in packages/contracts. An accepted quote must be reconstructible
    // indefinitely, so a value persisted when a currency's used exponent was
    // different has to keep parsing through the unrefined `Money` forever;
    // pinning the stored type to today's CURRENCY_REGISTRY would make that quote
    // unreadable the day the registry changes. The registry is the right
    // authority for INBOUND data only.
    //
    // This fails the day somebody "fixes" the apparent gap by moving the check
    // into `Money` — at which point MoneyRequest is redundant and the
    // reproducibility property is gone, with every other test in this file
    // still green.
    const stale = { amountMinor: '350000', currency: 'COP', exponent: 2 };
    expect(Money.safeParse(stale).success).toBe(true);
    expect(MoneyRequest.safeParse(stale).success).toBe(false);
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
