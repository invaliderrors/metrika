import { z } from 'zod';

/**
 * Accepts UUID variants 1-8 (RFC 9562), which includes v7 — the version this
 * schema uses for time-sortable primary keys. Written as an explicit regex
 * rather than Zod's `.uuid()` so behaviour does not shift across Zod majors,
 * which have differed on which versions they accept.
 * The nil UUID is deliberately rejected: it is never a valid identifier here.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function brandedUuid<B extends string>(brand: B) {
  return z.string().regex(UUID_PATTERN, `must be a UUID (${brand})`).brand<B>();
}
