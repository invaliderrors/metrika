import { afterAll, describe, expect, it } from 'vitest';
import { startTestDatabase, stopDatabase, withDatabase } from './support.js';

afterAll(async () => {
  await stopDatabase();
});

describe('the shared test database', () => {
  it('exposes two URLs on two different roles', async () => {
    const handle = await startTestDatabase();
    expect(handle.applicationUrl).toContain('metrika_app:');
    expect(handle.adminUrl).toContain('metrika:');
  });

  it('has applied the migrations, so the schema is queryable', async () => {
    const rows = await withDatabase(async (db) => db.healthCheck.findMany());
    expect(rows).toEqual([]);
  });

  it('round-trips a write through the real database', async () => {
    const created = await withDatabase(async (db) => db.healthCheck.create({ data: {} }));
    const found = await withDatabase(async (db) =>
      db.healthCheck.findUnique({ where: { id: created.id } }),
    );
    expect(found?.id).toBe(created.id);
  });

  it('connects as a role that cannot bypass row-level security', async () => {
    const [role] = await withDatabase(
      async (db) =>
        db.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
        SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
      `,
    );
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});
