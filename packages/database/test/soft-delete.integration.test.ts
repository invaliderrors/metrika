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

  it('filters a findMany called with no arguments at all — the guard is fail-closed', async () => {
    await seed('dead-noargs', new Date());

    const labels = await withDatabase(async (db) =>
      withOrganizationContext(db, ORG, async (tx) =>
        // No argument object whatsoever. If the extension treats an absent
        // `args` as "nothing to filter" and passes it through, this is the
        // call that leaks — and it is the most common call in the codebase.
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
