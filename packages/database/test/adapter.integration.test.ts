import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, stopDatabase, withDatabase } from './support.js';
import { createPrismaClient } from '../src/index.js';

afterAll(async () => {
  await stopDatabase();
});

/**
 * `?schema=` in the connection URL is INERT on Prisma 7 behind a driver
 * adapter. Measured against a URL naming a schema that does not exist:
 *
 *     prisma 7.9.1 : QUERY SUCCEEDED — ?schema= was IGNORED
 *     prisma 6.19.3: QUERY FAILED    — ?schema= was honoured
 *
 * Nothing in this repository breaks today, because every URL says
 * `?schema=public` and `public` is what `pg` would use anyway. It breaks
 * silently the first time a URL points somewhere else: no error, no warning,
 * queries quietly served from the wrong schema.
 *
 * The schema now belongs to `PrismaPg`'s second argument, and that is what the
 * second test proves — by content, not by a query that merely succeeded.
 */
describe('the Prisma 7 driver adapter', () => {
  /**
   * A schema of this suite's own, created here rather than by a migration.
   * One container serves the whole run and nothing rolls back, so owning a
   * separate schema is also this suite's isolation: no other file can see
   * these rows, and this file writes exactly one row into `public`.
   */
  const PROBE_SCHEMA = 'metrika_adapter_probe';
  /** Fixed rather than random, so a failure names a row you can go and find. */
  const PROBE_SCHEMA_ROW_ID = '11111111-1111-4111-8111-111111111111';

  let applicationUrl = '';
  let publicRowId = '';

  beforeAll(async () => {
    const handle = await startTestDatabase();
    applicationUrl = handle.applicationUrl;

    // The owner's URL, because creating a schema needs CREATE on the database
    // and metrika_app deliberately has neither that nor any other DDL right.
    const admin = createPrismaClient({ databaseUrl: handle.adminUrl });
    try {
      await admin.$executeRaw`CREATE SCHEMA IF NOT EXISTS "metrika_adapter_probe"`;
      // Column names and types copied from migration 20260809024512_init, so
      // the generated query the scoped client sends is the same query it would
      // send against `public`. A near-miss here would fail as "column does not
      // exist", which looks like the adapter option not working and is not.
      await admin.$executeRaw`
        CREATE TABLE IF NOT EXISTS "metrika_adapter_probe"."HealthCheck" (
          "id" UUID NOT NULL,
          "checkedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "HealthCheck_probe_pkey" PRIMARY KEY ("id")
        )
      `;
      // sql/00-app-role.sql's ALTER DEFAULT PRIVILEGES covers schema `public`
      // only, so this schema's grants are explicit.
      await admin.$executeRaw`GRANT USAGE ON SCHEMA "metrika_adapter_probe" TO metrika_app`;
      await admin.$executeRaw`
        GRANT SELECT, INSERT, UPDATE, DELETE
        ON "metrika_adapter_probe"."HealthCheck" TO metrika_app
      `;
      await admin.$executeRaw`
        INSERT INTO "metrika_adapter_probe"."HealthCheck" ("id")
        VALUES (${PROBE_SCHEMA_ROW_ID}::uuid)
        ON CONFLICT DO NOTHING
      `;
    } finally {
      await admin.$disconnect();
    }

    // One row in `public."HealthCheck"`, which the scoped client must NOT see.
    const created = await withDatabase(async (db) => db.healthCheck.create({ data: {} }));
    publicRowId = created.id;
  });

  it('ignores ?schema= in the connection URL', async () => {
    // "Does not exist" is load-bearing, so it is asserted rather than assumed:
    // if some future migration ever created a schema by this name, the query
    // below would succeed for a reason that has nothing to do with Prisma and
    // this test would pass while measuring nothing.
    const [namespace] = await withDatabase(
      async (db) =>
        db.$queryRaw<{ present: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_namespace WHERE nspname = 'definitely_not_a_real_schema'
          ) AS present
        `,
    );
    expect(namespace?.present).toBe(false);

    // A schema that does not exist. On Prisma 6 this made every query fail;
    // on 7 the parameter never reaches pg, so the query succeeds against
    // pg's default search_path instead. Red here means URL handling came
    // back and every ?schema= in the repo means something again.
    const url = new URL(applicationUrl);
    url.searchParams.set('schema', 'definitely_not_a_real_schema');
    // The harness's URL still carries `?schema=public` — packages/testing is
    // the one place this plan did not strip it from — so `searchParams.set`
    // is a REPLACEMENT here, not an append. Asserted rather than reasoned
    // about, because a probe URL that quietly still said `public` would pass
    // this test while proving nothing. Both assertions hold either way, so
    // they survive the follow-up that removes it there too.
    expect(url.toString()).toContain('schema=definitely_not_a_real_schema');
    expect(url.toString()).not.toContain('schema=public');

    const probe = createPrismaClient({ databaseUrl: url.toString() });
    try {
      await expect(probe.$queryRaw`SELECT 1 AS one`).resolves.toEqual([{ one: 1 }]);
    } finally {
      await probe.$disconnect();
    }
  });

  it('selects a schema through the adapter, not the URL', async () => {
    // The correct spelling on Prisma 7. `PrismaPg`'s second argument is
    // constructed here rather than through createPrismaClient because
    // DatabaseConfig deliberately carries no schema: nothing in this
    // repository runs outside `public`, and the point of this fixture is to
    // record WHERE the option lives now, not to add a knob nobody turns.
    const scoped = new PrismaClient({
      adapter: new PrismaPg({ connectionString: applicationUrl }, { schema: PROBE_SCHEMA }),
    });
    const unscoped = createPrismaClient({ databaseUrl: applicationUrl });

    try {
      // Both directions, because a query that merely succeeded would not
      // distinguish "the adapter option worked" from "the option was ignored
      // a second time and this is `public` answering". `public` and
      // `metrika_adapter_probe` hold DIFFERENT rows in identically shaped
      // tables, so only one of them can produce each result below.
      await expect(
        scoped.healthCheck.findUnique({ where: { id: PROBE_SCHEMA_ROW_ID } }),
      ).resolves.toMatchObject({ id: PROBE_SCHEMA_ROW_ID });
      await expect(
        scoped.healthCheck.findUnique({ where: { id: publicRowId } }),
      ).resolves.toBeNull();

      // The control: the same query on a client with no schema option reads
      // `public`, and gets the mirror image. Without this pair, a bug that
      // made every findUnique return its argument would look like a pass.
      await expect(
        unscoped.healthCheck.findUnique({ where: { id: publicRowId } }),
      ).resolves.toMatchObject({ id: publicRowId });
      await expect(
        unscoped.healthCheck.findUnique({ where: { id: PROBE_SCHEMA_ROW_ID } }),
      ).resolves.toBeNull();
    } finally {
      await scoped.$disconnect();
      await unscoped.$disconnect();
    }
  });
});
