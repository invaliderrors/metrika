import type { Money } from '@metrika/contracts';
import { describe, expect, it } from 'vitest';
import {
  formatDurationS,
  formatLengthMm,
  formatMassG,
  formatMoney,
} from '../src/lib/formatting/index.js';

/**
 * `Money.amountMinor` is an INTEGER STRING on the wire, not a `bigint` — see
 * `packages/contracts/src/money.ts`. The bigint literals below are what the
 * assertions are about, so they are written as bigints and converted here
 * rather than being spelled out as quoted digits at every call site: a test
 * whose fixture reads `'123456789012345678'` hides the very quantity the
 * MAX_SAFE_INTEGER case exists to talk about.
 */
const cop = (amountMinor: bigint): Money => ({
  amountMinor: amountMinor.toString(),
  currency: 'COP',
  exponent: 2,
});

describe('formatMoney', () => {
  it('renders COP with the exponent it was given', () => {
    // 350000 minor units at exponent 2 is 3 500,00 COP — NOT 350 000.
    expect(formatMoney(cop(350_000n), 'es-CO')).toMatch(/3[.\s]500,00/);
  });

  it('honours an exponent of 0 rather than assuming two decimals', () => {
    const whole: Money = { amountMinor: '350000', currency: 'COP', exponent: 0 };
    expect(formatMoney(whole, 'es-CO')).toMatch(/350[.\s]000/);
    expect(formatMoney(whole, 'es-CO')).not.toContain(',00');
  });

  it('renders a negative amount', () => {
    const formatted = formatMoney(cop(-350_000n), 'es-CO');
    // The digits, not just the sign. `toContain('-')` alone is satisfied by an
    // implementation that emits a minus and then the wrong number — including
    // one that loses the sign on the amount and picks it up from somewhere
    // else. Exactly one minus, and the same digits the positive case pins.
    expect(formatted).toContain('-');
    expect(formatted.match(/-/g)).toHaveLength(1);
    expect(formatted).toMatch(/3[.\s]500,00/);
  });

  it('renders zero without a sign', () => {
    const formatted = formatMoney(cop(0n), 'es-CO');
    expect(formatted).not.toContain('-');
    expect(formatted).toMatch(/0,00/);
  });

  it('is exact beyond Number.MAX_SAFE_INTEGER', () => {
    // 123456789012345678 minor units at exponent 2 is 1234567890123456.78.
    //
    // The float path loses this: Number(123456789012345678n) is
    // 123456789012345680, and dividing by 100 gives ...3456.8, which renders
    // with minor digits "80". The assertion below is the one that forbids the
    // float implementation — it fails on the minor digits, not on a separator.
    const formatted = formatMoney(cop(123_456_789_012_345_678n), 'es-CO');
    expect(formatted).toMatch(/56,78$/);
    expect(formatted).not.toMatch(/56,80$/);
    expect(formatted).not.toContain('e+');
  });

  /**
   * The two assertions above are each other's only backstop, and the
   * exponent-0 one is the weaker of the pair: a float implementation still
   * renders 350000 as "350.000" once ICU is told to use zero fraction digits,
   * so `not.toContain(',00')` alone passes against `Number(...) / 10 ** 0`.
   * What it cannot survive is the fraction-digit options being dropped
   * altogether, which is what the tempting one-liner does — ICU then falls back
   * to the LOCALE'S default for COP (two digits) and emits "350.000,00".
   *
   * This case adds the other half: an exponent of 0 carrying digits that a
   * double cannot hold. It fails on a digit under the float path whichever way
   * the fraction options are written, so neither of the two mutations can leave
   * the suite green by chance.
   */
  it('is exact beyond Number.MAX_SAFE_INTEGER at an exponent of 0 too', () => {
    const whole: Money = { amountMinor: '123456789012345678', currency: 'COP', exponent: 0 };
    const formatted = formatMoney(whole, 'es-CO');
    expect(formatted).toMatch(/345[.\s]678$/);
    expect(formatted).not.toContain('e+');
  });
});

describe('unit formatting', () => {
  it('formats a length in millimetres with its unit', () => {
    expect(formatLengthMm(125.5, 'es-CO')).toMatch(/125,5\s?mm/);
  });

  it('formats a mass in grams with its unit', () => {
    expect(formatMassG(48.25, 'es-CO')).toMatch(/48,25?\s?g/);
  });

  it('formats a duration as hours and minutes, not raw seconds', () => {
    expect(formatDurationS(5_400)).toBe('1 h 30 min');
  });

  it('formats a sub-hour duration without a leading zero hour', () => {
    expect(formatDurationS(600)).toBe('10 min');
  });

  it('drops the minutes on a whole number of hours', () => {
    expect(formatDurationS(7_200)).toBe('2 h');
  });

  /**
   * The edges, pinned rather than left to fall out of the arithmetic. Both of
   * these were unasserted and one of them was wrong: `-600` rendered
   * `"-1 h -10 min"`, because `Math.floor(-10 / 60)` is -1 and `-10 % 60` is
   * -10, so the hours branch fired with a minus on each component.
   */
  it('renders a sub-minute duration at minute resolution, not as seconds', () => {
    expect(formatDurationS(0)).toBe('0 min');
    expect(formatDurationS(29)).toBe('0 min');
    expect(formatDurationS(30)).toBe('1 min');
  });

  it('applies the sign once on a negative duration', () => {
    expect(formatDurationS(-600)).toBe('-10 min');
    expect(formatDurationS(-5_400)).toBe('-1 h 30 min');
    expect(formatDurationS(-7_200)).toBe('-2 h');
  });
});
