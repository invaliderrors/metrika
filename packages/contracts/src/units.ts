import { z } from 'zod';

/**
 * Canonical internal units: millimetres, grams, seconds. Branding is applied
 * only to the quantities that flow into money, where a mix-up becomes a wrong
 * invoice. Everything else relies on the naming convention (`lengthMm`,
 * `massG`, `durationS`) — see docs/DOMAIN_MODEL.md §4.
 *
 * Length may be negative (coordinates); mass, area, volume and duration may
 * not. All five reject `NaN` and `±Infinity` — a slicer result must be an
 * exact number or absent, never an unbounded one. `z.number()` rejects both
 * by default as of Zod 4 (verified against the pinned 4.4.3), so `.finite()`
 * is deliberately omitted: it is a deprecated no-op on this version and is
 * lint-blocked (`@typescript-eslint/no-deprecated`) — see the Task 7 report.
 *
 * `-0` is deliberately accepted by the non-negative quantities: `-0 >= 0` is
 * `true`, so `.nonnegative()` lets it through, and that is the right call —
 * unlike Money's `amountMinor` wire string, there is no separate string
 * encoding step at this layer where "-0" and "0" could diverge into two
 * different canonical spellings. `-0` here is a floating-point sign
 * artifact, not a real negative value.
 */
export const Millimeters = z.number().brand<'Millimeters'>();
export const SquareMillimeters = z.number().nonnegative().brand<'SquareMillimeters'>();
export const CubicMillimeters = z.number().nonnegative().brand<'CubicMillimeters'>();
export const Grams = z.number().nonnegative().brand<'Grams'>();
export const Seconds = z.number().nonnegative().brand<'Seconds'>();

export type Millimeters = z.infer<typeof Millimeters>;
export type SquareMillimeters = z.infer<typeof SquareMillimeters>;
export type CubicMillimeters = z.infer<typeof CubicMillimeters>;
export type Grams = z.infer<typeof Grams>;
export type Seconds = z.infer<typeof Seconds>;

export const mm = (value: number): Millimeters => Millimeters.parse(value);
export const mm2 = (value: number): SquareMillimeters => SquareMillimeters.parse(value);
export const mm3 = (value: number): CubicMillimeters => CubicMillimeters.parse(value);
export const grams = (value: number): Grams => Grams.parse(value);
export const seconds = (value: number): Seconds => Seconds.parse(value);
