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
    // Asserts the table is QUERYABLE, not that it is empty. A global
    // emptiness claim here coupled this file to running before any other
    // integration file that writes a HealthCheck row with no cleanup —
    // true only by file-ordering luck, and Vitest's default sequencer does
    // not preserve declaration order (see vitest.integration.config.ts
    // history). Step 11's missing-migration mutation still fails the whole
    // run in globalSetup before this assertion is reached, so no coverage
    // is lost by not asserting emptiness.
    const rows = await withDatabase(async (db) => db.healthCheck.findMany());
    expect(Array.isArray(rows)).toBe(true);
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
