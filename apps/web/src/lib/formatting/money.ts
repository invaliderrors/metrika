import { toBigInt, type Money } from '@metrika/contracts';
import type { SupportedLocale } from '../../config/env';

/**
 * Builds the decimal STRING the amount represents, then hands that string to
 * `Intl.NumberFormat`.
 *
 * `Intl.NumberFormat.prototype.format` accepts a string and formats it at
 * arbitrary precision (ECMA-402 "Intl.NumberFormat V3"). That is the whole
 * reason this function does not divide.
 *
 * The obvious implementation — `Number(amountMinor) / 10 ** exponent` — is
 * wrong twice over: it is a float, which this project forbids for money, and
 * it silently rounds above Number.MAX_SAFE_INTEGER. A quote total in COP minor
 * units reaches that range at roughly ninety trillion pesos, which is absurd
 * today and is exactly the kind of assumption that stops being absurd.
 *
 * The return type is `Intl.StringNumericLiteral` (`${number}` plus the three
 * infinities), which is what `format` accepts, and reaching it needs one
 * assertion: a template literal built from two `string` operands infers as
 * `string`, and no arrangement of this arithmetic makes the compiler see the
 * pattern. The assertion is discharged by construction rather than by faith —
 * `digits` comes from `BigInt.prototype.toString`, so it is digits only; the
 * padding guarantees at least one digit on each side of the point; the sign is
 * the only other character emitted.
 */
function toDecimalString(amountMinor: bigint, exponent: number): Intl.StringNumericLiteral {
  const negative = amountMinor < 0n;
  const digits = (negative ? -amountMinor : amountMinor).toString();
  const sign = negative ? '-' : '';

  if (exponent === 0) return `${sign}${digits}` as Intl.StringNumericLiteral;

  const padded = digits.padStart(exponent + 1, '0');
  const whole = padded.slice(0, padded.length - exponent);
  const fraction = padded.slice(padded.length - exponent);
  return `${sign}${whole}.${fraction}` as Intl.StringNumericLiteral;
}

/**
 * `exponent` comes off the `Money` itself and is never looked up in
 * `CURRENCY_REGISTRY`. `packages/contracts/src/money.ts` declines to
 * cross-check the two on purpose: pinning a stored value to today's registry
 * would make an old quote unparseable the moment a currency's used exponent
 * changes, and an accepted quote must be reconstructible indefinitely. A
 * formatter that consulted the registry would reintroduce exactly that pin at
 * the last possible moment, where it would look like a rendering detail.
 */
export function formatMoney(money: Money, locale: SupportedLocale): string {
  const { currency, exponent } = money;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    // Driven by the amount's OWN exponent, never by the locale's default for
    // the currency. Omitting these two is not a smaller version of the same
    // thing: ICU would then apply its own idea of COP's fraction digits and
    // render a whole-peso amount with a ",00" that the stored value does not
    // claim.
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(toDecimalString(toBigInt(money), exponent));
}
