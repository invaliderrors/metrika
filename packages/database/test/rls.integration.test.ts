import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, stopDatabase, withDatabase } from './support.js';
import { createPrismaClient, withOrganizationContext } from '../src/index.js';
import type { MetrikaPrismaClient } from '../src/index.js';

const ORG_A = randomUUID();
const ORG_B = randomUUID();

let ownerClient: MetrikaPrismaClient;

beforeAll(async () => {
  const handle = await startTestDatabase();
  // A second client on the OWNER role. See the "the table owner is a local
  // superuser" describe block below for why this connection cannot be used
  // to prove FORCE ROW LEVEL SECURITY the way the task brief originally
  // asked for.
  ownerClient = createPrismaClient({ databaseUrl: handle.adminUrl });

  await withDatabase(async (db) => {
    await withOrganizationContext(db, ORG_A, async (tx) => {
      await tx.rlsProbe.create({ data: { organizationId: ORG_A, label: 'belongs-to-a' } });
    });
    await withOrganizationContext(db, ORG_B, async (tx) => {
      await tx.rlsProbe.create({ data: { organizationId: ORG_B, label: 'belongs-to-b' } });
    });
  });
});

afterAll(async () => {
  await ownerClient.$disconnect();
  await stopDatabase();
});

describe('the application role cannot bypass RLS', () => {
  it('is neither a superuser nor BYPASSRLS', async () => {
    const [role] = await withDatabase(
      async (db) =>
        db.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
        SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
      `,
    );
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});

describe('tenant isolation, with the application check bypassed', () => {
  // Deliberately no `where: { organizationId: ... }` anywhere below: the
  // whole point of a backstop is that it works when the primary,
  // application-level control has failed.

  it('returns only org A rows for an unfiltered read in org A context', async () => {
    // No `where` clause: RLS itself is what scopes this to ORG_A, via the
    // session's `app.current_org_id`, so this stays order-independent
    // against every other file sharing the container — a row from an
    // unrelated file belongs to a different, also-random organization id
    // and never matches this session's policy predicate, regardless of
    // execution order.
    const labels = await withDatabase(async (db) =>
      withOrganizationContext(db, ORG_A, async (tx) =>
        (await tx.rlsProbe.findMany()).map((r) => r.label),
      ),
    );

    expect(labels).toEqual(['belongs-to-a']);
  });

  it('returns null for a findUnique on another organization row', async () => {
    const foreign = await withDatabase(async (db) =>
      withOrganizationContext(db, ORG_B, async (tx) =>
        tx.rlsProbe.findFirst({ where: { label: 'belongs-to-b' } }),
      ),
    );
    expect(foreign).not.toBeNull();

    const leaked = await withDatabase(async (db) =>
      withOrganizationContext(db, ORG_A, async (tx) =>
        tx.rlsProbe.findUnique({ where: { id: foreign?.id ?? '' } }),
      ),
    );

    expect(leaked).toBeNull();
  });

  it('cannot update another organization row', async () => {
    const foreign = await withDatabase(async (db) =>
      withOrganizationContext(db, ORG_B, async (tx) =>
        tx.rlsProbe.findFirst({ where: { label: 'belongs-to-b' } }),
      ),
    );

    const updated = await withDatabase(async (db) =>
      withOrganizationContext(db, ORG_A, async (tx) =>
        tx.rlsProbe.updateMany({
          where: { id: foreign?.id ?? '' },
          data: { label: 'stolen' },
        }),
      ),
    );

    expect(updated.count).toBe(0);
  });

  it('cannot insert a row stamped with another organization id — this is what WITH CHECK buys', async () => {
    await expect(
      withDatabase(async (db) =>
        withOrganizationContext(db, ORG_A, async (tx) =>
          tx.rlsProbe.create({ data: { organizationId: ORG_B, label: 'planted' } }),
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('sees nothing at all when no organization context is set — deny by default', async () => {
    // Also no `where` clause, and safe for the same reason: with no context
    // set, `app_current_org_id()` is NULL and the policy predicate
    // `organizationId = NULL` matches no row in the table — not just none of
    // this file's rows, ANY row's, from any file — so this is not a global
    // emptiness assertion about table contents, it is a property of the
    // policy itself.
    const rows = await withDatabase(async (db) => db.rlsProbe.findMany());
    expect(rows).toEqual([]);
  });
});

// The brief this file was written from (Plan 0B-1, Task 8) asked for a
// `describe('the table owner is not exempt')` block asserting that
// `ownerClient` — connected as the migration/DDL owner role `metrika` — is
// filtered by RLS the same way `metrika_app` is. That assertion does not
// hold in this harness and was proven wrong empirically rather than adjusted
// until it passed (see task-8-report.md, "brief defect"):
//
//   docker run postgres:16-alpine with POSTGRES_USER=metrika, then
//   `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'metrika'`
//   returns `t | t`. The `postgres` image's entrypoint runs `initdb` with
//   `--username=$POSTGRES_USER`, which makes that role Postgres's bootstrap
//   superuser. A superuser bypasses row security unconditionally — with or
//   without FORCE, and regardless of what `app.current_org_id` is set to
//   (confirmed directly: setting the session context to org B's id before
//   querying as the owner still returned both organizations' rows). FORCE
//   ROW LEVEL SECURITY only removes the plain *table-owner* exemption; it
//   was never able to touch the *superuser* exemption, and in this
//   container the owner is both.
//
// This is exactly the caveat already recorded in
// packages/database/prisma/migrations/20260809024512_init/migration.sql:
// FORCE is correct and load-bearing in production, where Terraform (Plan 0D)
// provisions a non-superuser owner — it is simply untestable behaviourally
// against *this* local/CI container. The regression coverage for FORCE
// itself already exists and does not need a live database: it is
// packages/database/test/migration-sql.test.ts's
// "FORCES row-level security for every table that ENABLEs it" (a static
// check over the committed migration SQL, part of `test:unit`).
//
// What IS true here, and worth pinning as a real test rather than leaving
// as a comment: the owner connection's bypass is unconditional, so it can be
// used to plant cross-tenant fixtures (as `beforeAll` above does via
// `ownerClient` implicitly, through `adminUrl` — see support.ts) but must
// never be mistaken for a filtered connection.
describe('the table owner is a local superuser, not merely RLS-exempt', () => {
  it('bypasses RLS unconditionally — FORCE does not apply to a superuser owner', async () => {
    const [role] = await ownerClient.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `;
    expect(role?.rolsuper).toBe(true);

    // Not scoped to `[ORG_A, ORG_B]` and not asserting emptiness of
    // anything global: this asserts the owner sees BOTH of the two rows
    // this file itself created, proving the bypass is real rather than
    // relying on the owner's `findMany()` being merely non-empty.
    const labels = (
      await ownerClient.rlsProbe.findMany({
        where: { organizationId: { in: [ORG_A, ORG_B] } },
      })
    )
      .map((r) => r.label)
      .sort();

    expect(labels).toEqual(['belongs-to-a', 'belongs-to-b']);
  });

  it('bypasses RLS even with an organization context set, because the bypass ignores the policy entirely', async () => {
    const labels = await withOrganizationContext(ownerClient, ORG_B, async (tx) =>
      (await tx.rlsProbe.findMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }))
        .map((r) => r.label)
        .sort(),
    );

    expect(labels).toEqual(['belongs-to-a', 'belongs-to-b']);
  });
});
