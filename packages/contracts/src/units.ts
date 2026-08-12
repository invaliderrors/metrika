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
/**
 * The finite range of an IEEE-754 double, written out so that FINITENESS
 * CROSSES THE LANGUAGE BOUNDARY. On this side these bounds are a no-op —
 * `z.number()` already rejects `NaN` and `±Infinity`, and no finite double
 * exceeds `Number.MAX_VALUE` — which is exactly why they are easy to leave out
 * and exactly why they must not be.
 *
 * JSON Schema has no way to say "finite". `{ "type": "number" }` generates a
 * bare pydantic `float`, and MEASURED on the pinned pydantic 2.13.4 that float
 * ACCEPTS `NaN`, `+inf` and `-inf` — while the Zod schema defining it rejects
 * all three. `minimum`/`maximum` DO cross, and `-MAX ≤ x ≤ MAX` is precisely
 * the set of finite doubles: `±inf` fall outside it and `NaN` fails every
 * comparison. So the one constraint JSON Schema cannot express is expressed
 * through the two it can.
 *
 * The four non-negative quantities were partly protected by accident before
 * this — `ge=0` happens to filter `NaN` and `-inf` — and `Millimeters`, which
 * has no lower bound, was not protected at all. Accidental protection on four
 * of five is the shape this repository keeps meeting.
 *
 * `docs/CONTRACTS_AND_API.md` §5 and
 * `apps/workers/.../tests/test_generated_contracts.py` carry the other halves.
 */
const FINITE_MIN = -Number.MAX_VALUE;
const FINITE_MAX = Number.MAX_VALUE;

export const Millimeters = z.number().min(FINITE_MIN).max(FINITE_MAX).brand<'Millimeters'>();
export const SquareMillimeters = z
  .number()
  .nonnegative()
  .max(FINITE_MAX)
  .brand<'SquareMillimeters'>();
export const CubicMillimeters = z
  .number()
  .nonnegative()
  .max(FINITE_MAX)
  .brand<'CubicMillimeters'>();
export const Grams = z.number().nonnegative().max(FINITE_MAX).brand<'Grams'>();
export const Seconds = z.number().nonnegative().max(FINITE_MAX).brand<'Seconds'>();

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
