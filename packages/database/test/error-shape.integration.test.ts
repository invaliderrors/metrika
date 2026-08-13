import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, stopDatabase, withDatabase } from './support.js';
import { createPrismaClient } from '../src/index.js';

afterAll(async () => {
  await stopDatabase();
});

/**
 * What a unique-constraint violation looks like on Prisma 7, pinned because
 * ADR-0037 §4 tells the next implementer where to read it and nothing else in
 * this repository would catch that instruction being wrong.
 *
 * CLAUDE.md requires that every async operation be idempotent by a DATABASE
 * UNIQUE CONSTRAINT rather than an application check, so the first outbox row,
 * job or upload dedupe in Phase 1 arrives with a handler that reads one of
 * these errors. Three things about that handler are invisible to every other
 * gate here:
 *
 *   1. `meta.target` — the field pre-7 code reads to learn WHICH constraint
 *      fired — is gone. `PrismaClientKnownRequestError` declares
 *      `meta?: Record<string, unknown>`, so reading it is not a type error and
 *      `tsc` cannot report the field's absence. It reads `undefined` forever.
 *   2. The identity moved under `meta.driverAdapterError.cause`.
 *   3. The discriminator is `cause.kind`, NOT the Prisma error code. The same
 *      violation surfaces as `P2002` through a model delegate and as `P2010`
 *      through `$executeRaw`, and `kind` is `UniqueConstraintViolation` for
 *      both. A handler keyed on `code === 'P2002'` silently misses every
 *      violation raised by raw SQL.
 *
 * MEASURED on 7.9.1 — these three tests are the measurement, re-run on every
 * integration pass.
 */
describe('Prisma 7 unique-violation error shapes', () => {
  /**
   * A composite unique constraint, which no model in this schema has yet.
   * Created here rather than by a migration, in this suite's own schema, so no
   * other file can see it and this file adds exactly one row to `public`.
   *
   * The constraint is deliberately named the way Prisma names `@@unique([a,
   * b])` — `<Model>_<field>_<field>_key` — so what is measured below is the
   * shape a real composite unique constraint produces, not an artefact of an
   * ad-hoc name. The DDL spells the identifiers out because a tagged template
   * interpolates VALUES, not identifiers, and `Prisma.raw` is the unsafe-SQL
   * shape this package bans. Same constraint as adapter.integration.test.ts.
   */
  const PAIR_A = 'left';
  const PAIR_B = 'right';
  /** Fixed rather than random, so a failure names a row you can go and find. */
  const HEALTH_CHECK_ROW_ID = '44444444-4444-4444-8444-444444444444';

  /**
   * Returns the rejection rather than asserting on a promise, so the same
   * error object can be interrogated several ways — including for a property
   * that must be ABSENT, which `.rejects.toMatchObject` cannot express.
   */
  async function captureError(operation: () => Promise<unknown>): Promise<unknown> {
    try {
      await operation();
    } catch (error: unknown) {
      return error;
    }
    throw new Error('expected the operation to fail with a unique violation, but it succeeded');
  }

  beforeAll(async () => {
    const handle = await startTestDatabase();

    // The owner's URL: creating a schema needs CREATE on the database, and
    // metrika_app deliberately has no DDL rights at all.
    const admin = createPrismaClient({ databaseUrl: handle.adminUrl });
    try {
      await admin.$executeRaw`CREATE SCHEMA IF NOT EXISTS "metrika_error_probe"`;
      await admin.$executeRaw`
        CREATE TABLE IF NOT EXISTS "metrika_error_probe"."UniquePair" (
          "a" TEXT NOT NULL,
          "b" TEXT NOT NULL,
          CONSTRAINT "UniquePair_a_b_key" UNIQUE ("a", "b")
        )
      `;
      // sql/00-app-role.sql's ALTER DEFAULT PRIVILEGES covers `public` only.
      await admin.$executeRaw`GRANT USAGE ON SCHEMA "metrika_error_probe" TO metrika_app`;
      await admin.$executeRaw`
        GRANT SELECT, INSERT ON "metrika_error_probe"."UniquePair" TO metrika_app
      `;
      await admin.$executeRaw`
        INSERT INTO "metrika_error_probe"."UniquePair" ("a", "b")
        VALUES (${PAIR_A}, ${PAIR_B})
        ON CONFLICT DO NOTHING
      `;
    } finally {
      await admin.$disconnect();
    }

    // The row every violation below collides with.
    await withDatabase(
      async (db) =>
        db.$executeRaw`
        INSERT INTO "HealthCheck" ("id") VALUES (${HEALTH_CHECK_ROW_ID}::uuid)
        ON CONFLICT DO NOTHING
      `,
    );
  });

  it('reports P2002 with no meta.target, and the constraint under driverAdapterError.cause', async () => {
    const error = await captureError(async () =>
      withDatabase(async (db) => db.healthCheck.create({ data: { id: HEALTH_CHECK_ROW_ID } })),
    );

    expect(error).toMatchObject({
      code: 'P2002',
      meta: {
        modelName: 'HealthCheck',
        driverAdapterError: {
          cause: {
            originalCode: '23505',
            kind: 'UniqueConstraintViolation',
            constraint: { fields: ['id'] },
          },
        },
      },
    });

    // The whole reason §4 of the ADR exists. Pre-7 code reads `meta.target`;
    // on 7 it is absent, and absent reads as `undefined` with no complaint
    // from tsc, ESLint or any other gate in this repository.
    expect(error).not.toHaveProperty('meta.target');
  });

  it('reports the same violation as P2010 when it comes from $executeRaw', async () => {
    const error = await captureError(async () =>
      withDatabase(
        async (db) =>
          db.$executeRaw`INSERT INTO "HealthCheck" ("id") VALUES (${HEALTH_CHECK_ROW_ID}::uuid)`,
      ),
    );

    // A DIFFERENT Prisma code for the SAME database event. This is the trap:
    // an idempotency handler keyed on `code === 'P2002'` does not fire here,
    // and raw SQL is exactly where a bulk insert or an outbox claim ends up.
    expect(error).toMatchObject({
      code: 'P2010',
      meta: {
        driverAdapterError: {
          cause: {
            originalCode: '23505',
            kind: 'UniqueConstraintViolation',
            constraint: { fields: ['id'] },
          },
        },
      },
    });

    // `kind` is what both codes agree on, which is why the ADR keys its table
    // on `cause.kind` rather than on the Prisma code.
    expect(error).not.toHaveProperty('meta.target');
  });

  it('names every column of a composite unique constraint', async () => {
    const error = await captureError(async () =>
      withDatabase(
        async (db) =>
          db.$executeRaw`
            INSERT INTO "metrika_error_probe"."UniquePair" ("a", "b")
            VALUES (${PAIR_A}, ${PAIR_B})
          `,
      ),
    );

    // Both fields, in declaration order. Before this ran, ADR-0037 recorded the
    // composite case as UNVERIFIED — the single-column measurement it had could
    // not tell whether `fields` generalises or whether a composite reports an
    // index name instead.
    expect(error).toMatchObject({
      code: 'P2010',
      meta: {
        driverAdapterError: {
          cause: {
            originalCode: '23505',
            kind: 'UniqueConstraintViolation',
            constraint: { fields: ['a', 'b'] },
          },
        },
      },
    });
  });
});
