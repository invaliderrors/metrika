import { z } from 'zod';

/**
 * The five physical quantities that flow into money are branded.
 * Other quantities carry the unit in the name (`lengthMm`) but are not branded —
 * branding everything requires a units algebra and produces friction well beyond its value.
 */
export const Millimeters = z.number().finite().brand<'Millimeters'>();
export const CubicMillimeters = z.number().nonnegative().finite().brand<'CubicMillimeters'>();
export const Grams = z.number().nonnegative().finite().brand<'Grams'>();
export const Seconds = z.number().nonnegative().finite().brand<'Seconds'>();

export type Millimeters = z.infer<typeof Millimeters>;
export type CubicMillimeters = z.infer<typeof CubicMillimeters>;
export type Grams = z.infer<typeof Grams>;
export type Seconds = z.infer<typeof Seconds>;
