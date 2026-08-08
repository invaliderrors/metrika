import { describe, expectTypeOf, it } from 'vitest';
import {
  grams,
  mm,
  mm2,
  mm3,
  seconds,
  type CubicMillimeters,
  type Grams,
  type Millimeters,
  type Seconds,
  type SquareMillimeters,
} from '../src/index.js';

describe('units are nominally distinct', () => {
  it('does not let Grams satisfy Millimeters', () => {
    expectTypeOf<Grams>().not.toEqualTypeOf<Millimeters>();
  });

  it('does not let Millimeters satisfy Grams', () => {
    expectTypeOf<Millimeters>().not.toEqualTypeOf<Grams>();
  });

  it('does not let CubicMillimeters satisfy Grams — the mix-up that becomes a wrong price', () => {
    expectTypeOf<CubicMillimeters>().not.toEqualTypeOf<Grams>();
  });

  it('does not let a bare number satisfy Seconds', () => {
    expectTypeOf<number>().not.toEqualTypeOf<Seconds>();
  });

  // --- Additional edge cases beyond the brief ---

  it('does not let SquareMillimeters satisfy CubicMillimeters — two non-negative brands are still distinct', () => {
    expectTypeOf<SquareMillimeters>().not.toEqualTypeOf<CubicMillimeters>();
  });

  it('lets a Millimeters value be used as a plain number', () => {
    expectTypeOf<Millimeters>().toExtend<number>();
  });

  // Pairwise `not.toEqualTypeOf` checks between two *still-branded* types
  // pass trivially even if one of the pair silently lost its brand (a plain
  // `number` is still "not equal" to a branded sibling). That gap is exactly
  // what let `Grams` losing its `.brand()` slip past every test above during
  // verification. Comparing each type against plain `number` is what
  // actually catches a single type quietly degrading to unbranded — see the
  // task report's break-and-restore section for the reproduction.
  it('does not let Millimeters satisfy a bare number', () => {
    expectTypeOf<Millimeters>().not.toEqualTypeOf<number>();
  });

  it('does not let SquareMillimeters satisfy a bare number', () => {
    expectTypeOf<SquareMillimeters>().not.toEqualTypeOf<number>();
  });

  it('does not let CubicMillimeters satisfy a bare number', () => {
    expectTypeOf<CubicMillimeters>().not.toEqualTypeOf<number>();
  });

  it('does not let Grams satisfy a bare number', () => {
    expectTypeOf<Grams>().not.toEqualTypeOf<number>();
  });

  // Constructor return types are ungated by every check above: widening, say,
  // `mm(value: number): Millimeters` to `: number` compiles cleanly, every
  // runtime test in units.test.ts still passes (they only assert on the
  // *value*, never the static type of the constructor's return), and none of
  // the schema-vs-schema checks above touch the constructors at all. One
  // assertion per constructor closes that gap — see the task report's
  // break-and-restore section for a reproduction of the failure this catches.

  it('mm returns Millimeters, not a bare number', () => {
    expectTypeOf(mm(1)).toEqualTypeOf<Millimeters>();
  });

  it('mm2 returns SquareMillimeters, not a bare number', () => {
    expectTypeOf(mm2(1)).toEqualTypeOf<SquareMillimeters>();
  });

  it('mm3 returns CubicMillimeters, not a bare number', () => {
    expectTypeOf(mm3(1)).toEqualTypeOf<CubicMillimeters>();
  });

  it('grams returns Grams, not a bare number', () => {
    expectTypeOf(grams(1)).toEqualTypeOf<Grams>();
  });

  it('seconds returns Seconds, not a bare number', () => {
    expectTypeOf(seconds(1)).toEqualTypeOf<Seconds>();
  });
});
