// The two primitives a repository needs and nothing outside the persistence
// zone may have.
//
// Both are behind `prismaImportBoundary`'s `ignores` glob for the same reason
// `@prisma/client` is: a branded id exists so that a `QuoteId` cannot be passed
// where an `OrderId` belongs, and a helper that mints one from a bare string
// dissolves that guarantee wherever it is reachable. ADR-0018 puts it at
// "importable only from the persistence zone, enforced by an ESLint zone";
// ADR-0041 records the paths that zone now covers.
//
// Rows crossing the boundary INTO the domain are branded here, once, at the
// point where a `string` from the driver becomes a domain value. Everywhere
// else the brand is carried by the type system and needs no helper.
import { randomFillSync } from 'node:crypto';

/**
 * Asserts a plain `string` into a branded id type.
 *
 * `as unknown as T` rather than `as T`: TypeScript rejects a direct assertion
 * from `string` to an unconstrained `T` outright, and widening through
 * `unknown` is what the brand pattern requires. That is exactly why this is one
 * function in one zone rather than an idiom people reach for — the cast is
 * genuinely unchecked, and the only thing making it safe is that it happens
 * where the value has just come out of a column declared to hold it.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T is used once ON PURPOSE: the rule is correct that this equals a cast at the call site, and a cast at the call site is exactly what ADR-0018 exists to prevent. One named helper in one lint-fenced zone is greppable and reviewable; `value as UserId` scattered through repositories is neither. Removing the parameter would mean returning `unknown` and pushing the assertion back out to every caller.
export function brandUnsafe<T>(value: string): T {
  return value as unknown as T;
}

/**
 * A UUID version 7 — 48 bits of Unix milliseconds, then the version nibble, the
 * variant bits, and a random tail.
 *
 * HAND-WRITTEN, WITH NO NEW DEPENDENCY, and the alternatives were considered
 * rather than skipped. Node 24's `crypto.randomUUID()` produces v4 only, and
 * there is no `uuid` package anywhere in this workspace — adding one for
 * sixteen bytes of assembly is a dependency nobody would review again. Said out
 * loud so that nobody reaches for `randomUUID()` and ships v4 behind a v7 name,
 * which a test asserting only "it is a UUID" would never catch.
 *
 * WHY v7 AT ALL, and what it does not buy in this slice. Task 3's `WITH CHECK`
 * predicates require a row's id to exist BEFORE its INSERT — the GUC has to
 * equal it — so provisioning mints ids here and passes them explicitly rather
 * than letting Prisma's client-side default fill them. Time-ordered ids keep
 * that insert pattern from scattering across the primary key's B-tree. The
 * ordering is only to the millisecond: within one millisecond the tail is
 * random and two ids have no defined order, which is why 1B's cursor still
 * needs an `id` tie-break rather than trusting creation order.
 *
 * A `DataView` rather than indexing the `Uint8Array`: `noUncheckedIndexedAccess`
 * is on repo-wide, so `bytes[6]` is `number | undefined` and every byte would
 * need a non-null assertion. `getUint8`/`setUint8` return and take `number`.
 */
export function newUuidV7(): string {
  const bytes = new Uint8Array(16);
  randomFillSync(bytes);

  const view = new DataView(bytes.buffer);
  const milliseconds = Date.now();

  // 48-bit big-endian timestamp, split because setUint32 cannot span 6 bytes.
  // `/ 2 ** 32` rather than `>>> 32`: bitwise operators coerce to 32 bits, so
  // the high half would be zero for every date after 1970.
  view.setUint16(0, Math.floor(milliseconds / 2 ** 32));
  view.setUint32(2, milliseconds >>> 0);

  view.setUint8(6, (view.getUint8(6) & 0x0f) | 0x70); // version 7
  view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80); // variant 10xx

  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
