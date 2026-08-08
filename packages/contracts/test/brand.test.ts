import { describe, expect, it } from 'vitest';
import { brandedUuid } from '../src/index.js';

// Exercises the shared UUID_PATTERN in src/brand.ts directly, through a
// throwaway brand, rather than through one of the real IDs in src/ids.ts —
// this file is about hardening the regex itself, not any particular ID.
const ProbeId = brandedUuid('ProbeId');

describe('brandedUuid — UUID_PATTERN hostile-string hardening', () => {
  const validV4 = '9f1c2b3a-4d5e-4f60-8a1b-2c3d4e5f6071';
  const validV7 = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4051';

  it('accepts a valid UUIDv4', () => {
    expect(ProbeId.safeParse(validV4).success).toBe(true);
  });

  it('accepts a valid UUIDv7', () => {
    expect(ProbeId.safeParse(validV7).success).toBe(true);
  });

  it('rejects a non-UUID', () => {
    expect(ProbeId.safeParse('not-a-uuid').success).toBe(false);
  });

  it('rejects the nil UUID', () => {
    expect(ProbeId.safeParse('00000000-0000-0000-0000-000000000000').success).toBe(false);
  });

  // The four checks below each kill exactly one of the four independent
  // loosenings a copy-paste or a careless edit could introduce into
  // UUID_PATTERN. The nil-UUID test above fails both the version and variant
  // character classes at once, so on its own it cannot tell "the version
  // class is too wide" apart from "the variant class is too wide" — each
  // mutation below is chosen to trip exactly one class or one anchor.

  it('rejects a UUID with a prefix before it — kills a dropped leading `^` anchor', () => {
    // Without `^`, the regex can match starting anywhere in the string, and
    // the trailing `$` alone would still accept this because a match
    // starting at index 1 reaches the end of the string.
    expect(ProbeId.safeParse(`x${validV4}`).success).toBe(false);
  });

  it('rejects a UUID with a suffix after it — kills a dropped trailing `$` anchor', () => {
    // Without `$`, the regex only needs to match a prefix of the string, so
    // trailing garbage after a genuine UUID would still be accepted.
    expect(ProbeId.safeParse(`${validV4}x`).success).toBe(false);
  });

  it('rejects an out-of-range version nibble (0) — kills a widened version class', () => {
    // Position 15 (the first character of the third group) must be in
    // `[1-8]`. `0` is adjacent to that range but outside it.
    expect(ProbeId.safeParse('9f1c2b3a-4d5e-0f60-8a1b-2c3d4e5f6071').success).toBe(false);
  });

  it('rejects an out-of-range version nibble (9) — kills a widened version class', () => {
    // `9` is the other neighbour of `[1-8]`, catching a class widened in
    // either direction (e.g. to `[0-9]` or to any hex digit).
    expect(ProbeId.safeParse('9f1c2b3a-4d5e-9f60-8a1b-2c3d4e5f6071').success).toBe(false);
  });

  it('rejects an out-of-range variant nibble (c) — kills a widened variant class', () => {
    // Position 20 (the first character of the fourth group) must be in
    // `[89ab]`. `c` is the adjacent hex digit just outside that set.
    expect(ProbeId.safeParse('9f1c2b3a-4d5e-4f60-ca1b-2c3d4e5f6071').success).toBe(false);
  });
});
