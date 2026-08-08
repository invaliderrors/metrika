import { z } from 'zod';

/**
 * Money is bigint minor units plus an explicit currency and exponent.
 * Never a float, never a `number`, never an implicit exponent
 * (COP renders wrong without it — COP has 2 displayed decimals by
 * convention but the legal unit has no minor denomination in circulation).
 */
export const CurrencyCode = z.enum(['COP', 'USD']);
export type CurrencyCode = z.infer<typeof CurrencyCode>;

export const MinorUnits = z.bigint().brand<'MinorUnits'>();
export type MinorUnits = z.infer<typeof MinorUnits>;

export const Money = z
  .object({
    minorUnits: MinorUnits,
    currency: CurrencyCode,
    /**
     * Number of decimal places between the major and minor unit.
     * COP=2 (displayed), USD=2. Must be carried explicitly because
     * the wire format is decimal-string — a missing exponent renders wrong.
     */
    exponent: z.number().int().min(0).max(6),
  })
  .strict();
export type Money = z.infer<typeof Money>;

/**
 * Wire format: decimal string with the exponent applied.
 * E.g. { minorUnits: 12345n, currency: 'COP', exponent: 2 } → "123.45".
 */
export const moneyToDecimalString = (m: Money): string => {
  const negative = m.minorUnits < 0n;
  const abs = negative ? -m.minorUnits : m.minorUnits;
  const s = abs.toString().padStart(m.exponent + 1, '0');
  const intPart = s.slice(0, -m.exponent) || '0';
  const fracPart = m.exponent > 0 ? s.slice(-m.exponent) : '';
  const body = m.exponent > 0 ? `${intPart}.${fracPart}` : intPart;
  return negative ? `-${body}` : body;
};

export const moneyFromDecimalString = (
  s: string,
  currency: CurrencyCode,
  exponent: number,
): Money => {
  const trimmed = s.trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) throw new Error(`Invalid decimal string: ${s}`);
  const [, sign, intPart, fracPartRaw] = match;
  const fracPart = (fracPartRaw ?? '').padEnd(exponent, '0').slice(0, exponent);
  const combined = (intPart ?? '0') + fracPart;
  const minorUnits = BigInt(combined) * (sign === '-' ? -1n : 1n);
  return Money.parse({ minorUnits, currency, exponent });
};
