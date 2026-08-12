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
 *
 * `[0-9]` and not `\d`, and this is NOT a style preference. In JavaScript the
 * two are identical, so nothing on this side of the boundary can tell them
 * apart. In Python they are not: `\d` is Unicode-aware, so the ASCII-digit
 * assumption silently stops holding the moment this schema is emitted as JSON
 * Schema and generated into a pydantic model.
 *
 * MEASURED on the string `"3\u0665\u0660"` — an ASCII 3 followed by two
 * Arabic-Indic digits:
 *
 *   /^(0|-?[1-9]\d*)$/      JS: rejects   Python: ACCEPTS
 *   /^(0|-?[1-9][0-9]*)$/    JS: rejects   Python: rejects
 *
 * and `int("3\u0665\u0660")` is `350` in Python while `BigInt` on the same
 * string throws. So the `\d` form lets Python accept a money amount that
 * TypeScript refuses and read it as a different number — a divergence in the
 * one direction that matters, across the one boundary no test on either side
 * observes on its own. `test/money.test.ts` guards the source text, because a
 * behavioural test here would pass against both forms.
 */
const INTEGER_STRING = /^(0|-?[1-9][0-9]*)$/;

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
