import { z } from 'zod';

/**
 * Accepts UUID variants 1-8 (RFC 9562), which includes v7 — the version this
 * schema uses for time-sortable primary keys. Written as an explicit regex
 * rather than Zod's `.uuid()` so behaviour does not shift across Zod majors,
 * which have differed on which versions they accept.
 * The nil UUID is deliberately rejected: it is never a valid identifier here.
 */
/**
 * Case is spelled into the character classes rather than carried by an `/i`
 * flag, and that is a correctness requirement, not a style choice.
 *
 * `z.toJSONSchema()` emits the pattern SOURCE and silently drops the flags.
 * MEASURED: with `/i`, Zod accepts `A1B2C3D4-…` while the emitted pattern —
 * and therefore the generated pydantic model on the Python side — rejects it.
 * That is the same class of divergence as the digit class in money.ts, in the
 * opposite direction, and it would affect every branded ID in the system.
 *
 * The two forms are equivalent in JavaScript: measured identical across
 * lower, upper, mixed, wrong-version, wrong-variant and malformed inputs.
 * `test/brand.test.ts` asserts on the EMITTED pattern, which is where the
 * difference is observable at all.
 */
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

export function brandedUuid<B extends string>(brand: B) {
  return z.string().regex(UUID_PATTERN, `must be a UUID (${brand})`).brand<B>();
}
