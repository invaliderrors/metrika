import { z } from 'zod';

export const CurrencyCode = z.enum(['COP', 'USD', 'EUR', 'MXN']);
export type CurrencyCode = z.infer<typeof CurrencyCode>;

/**
 * `exponent` is how many minor units make one major unit, as USED, not as ISO
 * 4217 declares it. ISO assigns COP two minor units; Colombian commerce
 * operates in whole pesos, and rendering 350000 as "$3,500.00" would be wrong.
 */
export const CURRENCY_REGISTRY: Readonly<
  Record<CurrencyCode, { readonly exponent: number; readonly symbol: string }>
> = {
  COP: { exponent: 0, symbol: '$' },
  USD: { exponent: 2, symbol: 'US$' },
  EUR: { exponent: 2, symbol: '€' },
  MXN: { exponent: 2, symbol: 'MX$' },
};

/**
 * Matches a canonical integer string: no leading zeros (other than the bare
 * "0" itself), no leading "+", and no "-0" — zero has exactly one valid
 * representation. Without this, two wire strings ("0" and "-0", or "5" and
 * "+5") would decode to the same bigint yet fail to compare equal as
 * strings, which is exactly the kind of divergence that breaks equality
 * checks and canonical hashing downstream.
 */
const INTEGER_STRING = /^(0|-?[1-9]\d*)$/;

export const Money = z.object({
  amountMinor: z.string().regex(INTEGER_STRING, 'must be an integer string'),
  currency: CurrencyCode,
  exponent: z.number().int().min(0).max(4),
});
export type Money = z.infer<typeof Money>;

export class MoneyMismatchError extends Error {
  constructor(
    readonly a: Money,
    readonly b: Money,
  ) {
    super(
      `Cannot combine ${a.currency}/${String(a.exponent)} with ${b.currency}/${String(b.exponent)}`,
    );
    this.name = 'MoneyMismatchError';
  }
}

export function money(amountMinor: bigint, currency: CurrencyCode): Money {
  return {
    amountMinor: amountMinor.toString(),
    currency,
    exponent: CURRENCY_REGISTRY[currency].exponent,
  };
}

export function toBigInt(value: Money): bigint {
  return BigInt(value.amountMinor);
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency || a.exponent !== b.exponent) {
    throw new MoneyMismatchError(a, b);
  }
  return {
    amountMinor: (toBigInt(a) + toBigInt(b)).toString(),
    currency: a.currency,
    exponent: a.exponent,
  };
}
