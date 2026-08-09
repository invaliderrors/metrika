import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stopDatabase, withDatabase } from './support.js';
import { withOrganizationContext } from '../src/index.js';

const ORG_A = randomUUID();
const ORG_B = randomUUID();

beforeAll(async () => {
  try {
    await withDatabase(async (db) => {
      await withOrganizationContext(db, ORG_A, async (tx) => {
        await tx.rlsProbe.create({ data: { organizationId: ORG_A, label: 'belongs-to-a' } });
      });
      await withOrganizationContext(db, ORG_B, async (tx) => {
        await tx.rlsProbe.create({ data: { organizationId: ORG_B, label: 'belongs-to-b' } });
      });
    });
  } catch (error) {
    // Every test below depends on this seed succeeding. A dropped policy (or
    // RLS disabled outright) can make the SEED itself fail closed, which
    // then shows up as every test in this file skipping with a bare Prisma
    // stack trace pointing at `beforeAll` — easy to misread as a flaky setup
    // step. It is usually the opposite: the backstop failing before any
    // assertion got to run. Re-thrown with context, not swallowed.
    throw new Error(
      'Seeding RlsProbe fixtures for the RLS suite failed. If this is why every test in ' +
        'this file is failing, treat it as the backstop itself being broken (policy dropped, ' +
        'RLS disabled, or app_current_org_id() missing) rather than a flaky test — see the ' +
        'cause below.',
      { cause: error },
    );
  }
});

afterAll(async () => {
  await stopDatabase();
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
    // execution order. `.sort()` for the same reason every other multi-row
    // assertion in this file sorts: safe today at one row, and stays safe
    // if a future test in this describe block adds a second ORG_A row.
    const labels = await withDatabase(async (db) =>
      withOrganizationContext(db, ORG_A, async (tx) =>
        (await tx.rlsProbe.findMany()).map((r) => r.label).sort(),
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

// A previous version of this file had a `describe('the table owner is not
// exempt')` block (what the original task brief for this file asked for),
// then a `describe('the table owner is a local superuser, not merely
// RLS-exempt')` block in its place. Both are gone now — deleted, not
// reframed — after a coordinator review (task-8-report.md, "Fix round 1")
// found the second one passed for the wrong reason (it went red only
// *collaterally*, when an attribute mutation happened to also break the
// insert-rejection assertion above, never for the FORCE- or
// superuser-related reason it claimed to test) and would go red the day
// this harness's owner role stops being a bootstrap superuser — which would
// be an improvement, and a test that punishes an improvement is pressure to
// revert it, not a safeguard.
//
// The claim that used to justify the owner-based block anyway — that FORCE
// is "simply untestable behaviourally against this local/CI container" — was
// too broad and has been corrected. FORCE *is* observable in this exact
// container; it is only unobservable through *this harness's own owner
// connection*, because that connection is a bootstrap superuser and
// superusers bypass RLS unconditionally, FORCE or not. Verified directly,
// against a table owned by a plain NOSUPERUSER role created for the purpose
// (not `metrika`, not `metrika_app`) inside a `postgres:16-alpine` container:
//
//   non-superuser owner, ENABLE only (no FORCE): 2 rows visible  — exempt
//   non-superuser owner, FORCE applied:          0 rows visible  — enforced
//   metrika (this harness's actual owner), FORCE: 2 rows visible — bypass,
//     unconditional, unaffected by FORCE, and unaffected by session context
//     (confirmed separately: setting `app.current_org_id` before querying as
//     `metrika` changes nothing)
//
// So FORCE genuinely does something in this Postgres image; the local harness
// just cannot exercise that specific fact through an owner connection, because
// its owner is never the plain-non-superuser case the mechanism is for. That
// caveat is also recorded where the SQL itself lives:
// packages/database/prisma/migrations/20260809024512_init/migration.sql.
//
// None of this leaves FORCE or WITH CHECK actually unverified against the
// live, applied database, though — see the two describe blocks below, which
// replace the deleted owner-connection tests with a strictly better proof:
// reading Postgres's own catalog as `metrika_app`, which requires no
// privileged connection and, unlike a behavioural probe, cannot be fooled by
// which role happens to be asking.
describe('the applied database actually enforces FORCE and WITH CHECK — not just the migration source', () => {
  it('has relforcerowsecurity set on RlsProbe, independent of any owner exemption', async () => {
    // `pg_class` is a system catalog, readable by any role without a grant —
    // this needs no owner or superuser connection, unlike a behavioural
    // owner-exemption probe. `relforcerowsecurity` is exactly the bit
    // `ALTER TABLE ... FORCE ROW LEVEL SECURITY` sets, and it reads back true
    // or false regardless of who is asking, which is what makes this
    // verification immune to the bootstrap-superuser problem documented
    // above: metrika_app never needs to BE the owner to see whether the
    // owner is forced.
    const [row] = await withDatabase(
      async (db) =>
        db.$queryRaw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        SELECT relrowsecurity, relforcerowsecurity
        FROM pg_class
        WHERE oid = '"RlsProbe"'::regclass
      `,
    );
    expect(row).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('has a non-null WITH CHECK equal to USING on the applied policy — not just present in the migration source', async () => {
    // migration-sql.test.ts's `WITH CHECK (...)` substring check proves the
    // clause was once WRITTEN; it says nothing about what got APPLIED, and
    // cannot see an out-of-band `ALTER POLICY`/`DROP POLICY` + recreate that
    // never touches the committed migration file. `pg_policies.with_check`
    // is NULL when a policy has no explicit WITH CHECK — even though reads
    // and writes still behave identically, because Postgres reuses `qual`
    // (the USING expression) as the effective check in that case (see the
    // Step 5 mutation evidence in task-8-report.md: a USING-only policy
    // still rejects the cross-org insert, for exactly this reason). This
    // assertion pins the *applied, catalog-visible* shape, not just the
    // observed behaviour, so a future migration that silently drops the
    // explicit WITH CHECK is caught even though nothing about tenant
    // isolation would visibly break yet.
    const [row] = await withDatabase(
      async (db) =>
        db.$queryRaw<{ qual: string; with_check: string | null }[]>`
        SELECT qual, with_check FROM pg_policies WHERE tablename = 'RlsProbe'
      `,
    );
    expect(row?.with_check).not.toBeNull();
    expect(row?.with_check).toBe(row?.qual);
  });
});

describe('the application role cannot read _prisma_migrations', () => {
  it('is rejected with the Postgres permission-denied code, not merely an empty result', async () => {
    // Guards migration `20260809030000_revoke_prisma_migrations_from_app_role`,
    // which had no fixture anywhere before this test (Task 6's report
    // explicitly deferred it to this task). `.rejects.toThrow(...)` alone
    // would pass for the wrong reason too (a table that doesn't exist yet,
    // a typo'd name), so this asserts Prisma's own error code (`P2010`,
    // "raw query failed") AND the wrapped Postgres SQLSTATE (`42501`,
    // insufficient_privilege) it carries in `meta.code` — the actual "rejection
    // with the correct error code" CLAUDE.md asks a security-control fixture
    // for. Verified directly against a live container before writing this
    // assertion: `PrismaClientKnownRequestError { code: 'P2010', meta: {
    // code: '42501', message: 'ERROR: permission denied for table
    // _prisma_migrations' } }`.
    await expect(
      withDatabase(async (db) => db.$queryRaw`SELECT 1 FROM "_prisma_migrations"`),
    ).rejects.toMatchObject({
      code: 'P2010',
      meta: { code: '42501' },
    });
  });
});
