import { describe, expect, it } from 'vitest';
import { newUuidV7 } from '../src/infrastructure/persistence/branding.js';

/**
 * This file imports from inside the persistence zone, which
 * `prismaImportBoundary` otherwise forbids — `apps/api`'s lint script is
 * `eslint .` and ignores only `dist/`, `coverage/` and `openapi/`, so `test/**`
 * is linted like anything else.
 *
 * The exemption is a second config object in `packages/eslint-config`'s
 * `prismaImportBoundary` scoped to this exact path, and it CARRIES EVERY ENTRY
 * IT DISPLACES: flat config replaces a rule's options wholesale, so an
 * exemption that named only `branding` would silently drop the `@prisma/client`
 * and `@metrika/database` bans for this file. The negative-control fixture row
 * in `packages/eslint-config/test/rules.test.ts` is what proves it did not —
 * a narrowing without one is the same bug the `slice(1)` comment in
 * `boundaries.js` describes.
 *
 * Co-location inside the zone was the alternative and costs more: it needs
 * `vitest.config.ts`'s include to gain `src/**\/*.test.ts` AND
 * `tsconfig.build.json`'s include to stop matching it, or the test compiles
 * into `dist/` and ships with the application.
 */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('newUuidV7', () => {
  it('sets the version nibble to 7 and the variant bits to 10', () => {
    // The whole point of the hand-written implementation: `randomUUID()` would
    // satisfy "is a UUID" and fail this, which is why the assertion is on the
    // two fields rather than on the shape.
    for (let i = 0; i < 50; i += 1) {
      const id = newUuidV7();
      expect(id, id).toMatch(UUID_V7);
      expect(id[14], `version nibble of ${id}`).toBe('7');
      expect(['8', '9', 'a', 'b'], `variant nibble of ${id}`).toContain(id[19]);
    }
  });

  it('sorts lexicographically in generation order across milliseconds', async () => {
    const first = newUuidV7();
    await new Promise((resolve) => setTimeout(resolve, 3));
    const second = newUuidV7();
    await new Promise((resolve) => setTimeout(resolve, 3));
    const third = newUuidV7();

    expect([third, first, second].sort()).toEqual([first, second, third]);
  });

  it('does NOT guarantee order within a single millisecond — which is why a cursor needs a tie-break', () => {
    // Asserted rather than left implied, because the negative is the load-bearing
    // half: 1B's cursor pagination cannot use creation order alone, and a reader
    // who saw only the test above would reasonably assume it could.
    const sameMillisecond = Array.from({ length: 200 }, () => newUuidV7());
    const timestampPrefixes = new Set(sameMillisecond.map((id) => id.slice(0, 13)));

    // If every id landed in one millisecond, the tails are random and sorted
    // order is not generation order. Guard against a slow machine spreading
    // them: the claim is only meaningful when a prefix actually repeats.
    const repeated = timestampPrefixes.size < sameMillisecond.length;
    expect(repeated, 'expected at least two ids to share a millisecond').toBe(true);

    const withinOne = sameMillisecond.filter((id) =>
      id.startsWith([...timestampPrefixes][0] ?? ''),
    );
    expect(withinOne.length).toBeGreaterThan(1);
    expect(new Set(withinOne).size, 'ids within a millisecond must still be unique').toBe(
      withinOne.length,
    );
  });
});
