import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { stopDatabase, withDatabase } from './support.js';
import { HardDeleteForbiddenError, withDeleted, withOrganizationContext } from '../src/index.js';

const ORG = randomUUID();

afterAll(async () => {
  await stopDatabase();
});

async function seed(label: string, deletedAt: Date | null): Promise<string> {
  return withDatabase(async (db) =>
    withOrganizationContext(db, ORG, async (tx) => {
      const row = await tx.rlsProbe.create({
        data: { organizationId: ORG, label, ...(deletedAt !== null && { deletedAt }) },
      });
      return row.id;
    }),
  );
}

describe('soft-delete extension', () => {
  it('hides soft-deleted rows from findMany', async () => {
    await seed('live-row', null);
    await seed('dead-row', new Date());

    const labels = await withDatabase(async (db) =>
      withOrganizationContext(db, ORG, async (tx) =>
        (await tx.rlsProbe.findMany()).map((r) => r.label),
      ),
    );

    expect(labels).toContain('live-row');
    expect(labels).not.toContain('dead-row');
  });

  it('hides soft-deleted rows from findUnique', async () => {
    const id = await seed('dead-unique', new Date());

    const found = await withDatabase(async (db) =>
      withOrganizationContext(db, ORG, async (tx) => tx.rlsProbe.findUnique({ where: { id } })),
    );

    expect(found).toBeNull();
  });

  it('hides soft-deleted rows from count', async () => {
    const before = await withDatabase(async (db) =>
      withOrganizationContext(db, ORG, async (tx) => tx.rlsProbe.count()),
    );
    await seed('dead-count', new Date());
    const after = await withDatabase(async (db) =>
      withOrganizationContext(db, ORG, async (tx) => tx.rlsProbe.count()),
    );

    expect(after).toBe(before);
  });

  it('filters a findMany called with no arguments at all', async () => {
    // No argument object whatsoever — the most common call in the codebase.
    // This pins the observable behaviour rather than proving the
    // `isQueryArgs` fallback branch specifically: Prisma normalises an
    // absent `args` to `{}` before the extension ever sees it, so this
    // exercises the same injection path as every other filtered test here.
    // The fallback-to-`{}` branch itself has no known Prisma input that
    // reaches it today; it stays as defence in depth for a future Prisma
    // that stops normalising, not as something this test can red/green gate.
    await seed('dead-noargs', new Date());

    const labels = await withDatabase(async (db) =>
      withOrganizationContext(db, ORG, async (tx) =>
        (await tx.rlsProbe.findMany()).map((r) => r.label),
      ),
    );

    expect(labels).not.toContain('dead-noargs');
  });

  it('lets an explicit deletedAt filter through as the narrow inline escape hatch', async () => {
    const id = await seed('dead-explicit', new Date());

    const found = await withDatabase(async (db) =>
      withOrganizationContext(db, ORG, async (tx) =>
        tx.rlsProbe.findFirst({ where: { id, deletedAt: { not: null } } }),
      ),
    );

    expect(found?.id).toBe(id);
  });

  it('still filters when the where carries a physically-present deletedAt: undefined key', async () => {
    // Reproduces a reachable footgun the type system does not block:
    // `'deletedAt' in where` is true for a key that is PRESENT with value
    // `undefined`, and Prisma treats `undefined` as "no filter" — so the
    // naive `in` check would step aside and inject nothing.
    //
    // `buildWhere` takes `deletedAt` as an ordinary `Date | undefined`
    // parameter — exactly the shape a caller has after destructuring an
    // optional field, or after this repo's own conditional-spread partial-
    // update idiom (docs/TYPESCRIPT_AND_TOOLING.md) is used to build a
    // filter instead of a write payload — and returns a plain
    // `Record<string, unknown>`, which is genuinely what the extension
    // itself sees at runtime (`QueryArgs.where` in
    // src/extensions/soft-delete.ts). No cast is needed to pass it to
    // Prisma: `exactOptionalPropertyTypes` restricts the OPTIONAL (`?:`)
    // shorthand, not a required property typed `T | undefined`, and
    // `findFirst`'s `where` accepts this shape unmodified — proof the
    // guard cannot lean on the type system to rule this input out.
    function buildWhere(rowId: string, deletedAt: Date | undefined): Record<string, unknown> {
      return { id: rowId, deletedAt };
    }

    const id = await seed('dead-spread-undefined', new Date());

    const found = await withDatabase(async (db) =>
      withOrganizationContext(db, ORG, async (tx) =>
        tx.rlsProbe.findFirst({ where: buildWhere(id, undefined) }),
      ),
    );

    expect(found).toBeNull();
  });

  it('shows soft-deleted rows inside withDeleted() — the explicit admin escape hatch', async () => {
    const id = await seed('dead-admin', new Date());

    const found = await withDeleted(async () =>
      withDatabase(async (db) =>
        withOrganizationContext(db, ORG, async (tx) => tx.rlsProbe.findUnique({ where: { id } })),
      ),
    );

    expect(found?.id).toBe(id);
  });

  it('re-enables filtering as soon as withDeleted() returns', async () => {
    const id = await seed('dead-admin-scope', new Date());

    await withDeleted(async () => Promise.resolve());

    const found = await withDatabase(async (db) =>
      withOrganizationContext(db, ORG, async (tx) => tx.rlsProbe.findUnique({ where: { id } })),
    );

    expect(found).toBeNull();
  });

  it('refuses a hard delete on a soft-deletable model', async () => {
    const id = await seed('to-delete', null);

    await expect(
      withDatabase(async (db) =>
        withOrganizationContext(db, ORG, async (tx) => tx.rlsProbe.delete({ where: { id } })),
      ),
    ).rejects.toThrow(HardDeleteForbiddenError);
  });

  it('names the correct call in the refusal, so the fix is obvious', async () => {
    const id = await seed('to-delete-message', null);

    await expect(
      withDatabase(async (db) =>
        withOrganizationContext(db, ORG, async (tx) => tx.rlsProbe.delete({ where: { id } })),
      ),
    ).rejects.toThrow(/deletedAt/);
  });

  it('does not filter models that are not soft-deletable', async () => {
    const created = await withDatabase(async (db) => db.healthCheck.create({ data: {} }));
    const found = await withDatabase(async (db) =>
      db.healthCheck.findUnique({ where: { id: created.id } }),
    );
    expect(found?.id).toBe(created.id);
  });
});
