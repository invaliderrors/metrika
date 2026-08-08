import { describe, expect, it } from 'vitest';
import {
  CubicMillimeters,
  Grams,
  Millimeters,
  Seconds,
  SquareMillimeters,
  grams,
  mm,
  mm2,
  mm3,
  seconds,
} from '../src/index.js';

describe('physical units', () => {
  it('accepts a finite non-negative value', () => {
    expect(Grams.parse(148.2)).toBe(148.2);
  });

  it('rejects NaN', () => {
    expect(Grams.safeParse(Number.NaN).success).toBe(false);
  });

  it('rejects Infinity', () => {
    expect(Grams.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
  });

  it('rejects negative mass', () => {
    expect(Grams.safeParse(-1).success).toBe(false);
  });

  it('rejects negative duration', () => {
    expect(Seconds.safeParse(-1).success).toBe(false);
  });

  it('allows negative length — coordinates can be negative', () => {
    expect(Millimeters.safeParse(-12.5).success).toBe(true);
  });

  it('rejects negative volume', () => {
    expect(CubicMillimeters.safeParse(-1).success).toBe(false);
  });

  // --- Additional edge cases beyond the brief ---
  // The brief's list is a minimum; these close gaps that would let a
  // genuinely wrong value through, or are needed to actually exercise every
  // exported schema and constructor (required for the 100% coverage gate).

  it('SquareMillimeters accepts a finite non-negative value', () => {
    expect(SquareMillimeters.parse(2500)).toBe(2500);
  });

  it('rejects negative area', () => {
    expect(SquareMillimeters.safeParse(-1).success).toBe(false);
  });

  it('rejects NaN area', () => {
    expect(SquareMillimeters.safeParse(Number.NaN).success).toBe(false);
  });

  it('rejects infinite area', () => {
    expect(SquareMillimeters.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
  });

  it('rejects NaN volume', () => {
    expect(CubicMillimeters.safeParse(Number.NaN).success).toBe(false);
  });

  it('rejects infinite volume', () => {
    expect(CubicMillimeters.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
  });

  it('rejects NaN duration', () => {
    expect(Seconds.safeParse(Number.NaN).success).toBe(false);
  });

  it('rejects infinite duration', () => {
    expect(Seconds.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
  });

  it('rejects NaN length', () => {
    // Millimeters allows negatives but must still reject non-finite values —
    // the brief never asserts this, so a schema that dropped `.finite()`
    // while keeping the sign open would slip through unnoticed.
    expect(Millimeters.safeParse(Number.NaN).success).toBe(false);
  });

  it('rejects positive Infinity length', () => {
    expect(Millimeters.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
  });

  it('rejects negative Infinity length', () => {
    // Length's sign is open, so a bug that only bounds the lower end (e.g. a
    // stray `.nonnegative()`-shaped check on one side) or that forgets to
    // reject the negative extreme would only be caught by testing this
    // direction specifically, not by the positive-Infinity case above.
    expect(Millimeters.safeParse(Number.NEGATIVE_INFINITY).success).toBe(false);
  });

  it('accepts zero for each quantity — a zero-mass or zero-duration result is meaningful, not an error', () => {
    expect(Grams.safeParse(0).success).toBe(true);
    expect(Seconds.safeParse(0).success).toBe(true);
    expect(SquareMillimeters.safeParse(0).success).toBe(true);
    expect(CubicMillimeters.safeParse(0).success).toBe(true);
    expect(Millimeters.safeParse(0).success).toBe(true);
  });

  it('accepts -0 for non-negative quantities — a sign artifact of floating-point math, not a real negative value', () => {
    // -0 >= 0 is true, so Zod's `.nonnegative()` accepts it, and that is the
    // right call here: unlike Money's `amountMinor` wire string (Task 6),
    // there is no separate string encoding step at this layer where "-0"
    // and "0" could diverge into two different canonical spellings — see
    // the units.ts module doc and the task report for the full reasoning.
    expect(Grams.safeParse(-0).success).toBe(true);
    expect(Seconds.safeParse(-0).success).toBe(true);
    expect(SquareMillimeters.safeParse(-0).success).toBe(true);
    expect(CubicMillimeters.safeParse(-0).success).toBe(true);
  });

  it('accepts a very large finite value — there is no arbitrary upper bound', () => {
    expect(Grams.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true);
    expect(Millimeters.safeParse(-Number.MAX_SAFE_INTEGER).success).toBe(true);
  });

  it('mm constructs a valid Millimeters value, including negative ones', () => {
    expect(mm(-12.5)).toBe(-12.5);
  });

  it('mm2 constructs a valid SquareMillimeters value', () => {
    expect(mm2(2500)).toBe(2500);
  });

  it('mm3 constructs a valid CubicMillimeters value', () => {
    expect(mm3(15000)).toBe(15000);
  });

  it('grams constructs a valid Grams value', () => {
    expect(grams(148.2)).toBe(148.2);
  });

  it('seconds constructs a valid Seconds value', () => {
    expect(seconds(3600)).toBe(3600);
  });

  it('mm throws on a non-finite value, matching Millimeters.parse', () => {
    expect(() => mm(Number.NaN)).toThrow();
  });

  it('grams throws on a negative value, matching Grams.parse', () => {
    expect(() => grams(-1)).toThrow();
  });
});
