import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stopDatabase, withDatabase } from './support.js';
import type { MetrikaPrismaClient } from '../src/index.js';

/**
 * The behavioural half of Plan 1A Task 3: the five policies of
 * `20260817144359_identity_and_tenancy` exercised against a live Postgres as
 * `metrika_app` (NOSUPERUSER, NOBYPASSRLS), with the application-level check
 * bypassed on purpose.
 *
 * **THERE IS DELIBERATELY NO TENANT PREDICATE ANYWHERE IN THIS FILE** — no
 * `where: { organizationId: … }`, no `where: { userId: … }`. Every scoping
 * assertion below is scoped by the policy and by nothing else, because the whole
 * point of a backstop is that it works when the primary, application-level
 * control has failed. The standing comment in `rls.integration.test.ts:41-43`
 * says the same thing about `RlsProbe`; this file inherits it. `where: { id }`
 * appears in a few places and is not an exception to the rule: it names one row,
 * it does not name a tenant.
 *
 * ISOLATION IS THIS FILE'S OWN JOB. One container serves the whole integration
 * run, the tenant-context transaction COMMITS (nothing rolls back), and Vitest
 * orders files by size rather than by declaration — so no file may assume
 * another file's rows are, or are not, present. Every organization id, user id,
 * auth provider, external id, slug and email below is derived from a
 * module-scope `randomUUID()`, which is what makes the unfiltered reads safe:
 * a row belonging to another file can never satisfy a predicate built out of
 * this suite's random ids, whatever the execution order. The only reads that
 * assert global emptiness are the ones where the emptiness IS the property
 * under test (case 6 and parts of case 7) — with the relevant GUC unset the
 * predicate matches no row in the table, not merely none of this file's.
 */

const SUITE = randomUUID();

// Five people. USER_A is the caller in almost every case below; USER_C is a
// co-member of ORG_A with them; USER_B is a stranger who shares no organization
// with USER_A. USER_D and USER_E exist so that the two cases which DESTROY or
// CLAIM a row (case 10's deletes, case 11's personal-owner writes) cannot touch
// a fixture another case asserts over — a shared container and a file-order
// Vitest makes cross-case coupling the easiest mistake in this file.
const USER_A = randomUUID();
const USER_B = randomUUID();
const USER_C = randomUUID();
const USER_D = randomUUID();
const USER_E = randomUUID();

// Seven organizations. ORG_A is the one in context; ORG_PERSONAL and ORG_B are
// two more that USER_A is a member of, so the widened read half has something
// to widen to; ORG_C is the control — it exists, it has members, and USER_A is
// not one of them. Without ORG_C, "returns everything the caller is a member
// of" is untested in the only direction that can leak.
//
// ORG_D and ORG_E belong to case 10 alone: USER_D is a member of both, which is
// what makes "visible through the widened read, and NOT deletable" measurable
// without deleting a row any other case reads. ORG_F belongs to case 11 alone,
// because that case writes `personalOwnerUserId`, and that column carries a
// GLOBAL unique index — a positive control for it consumes a slot permanently.
const ORG_PERSONAL = randomUUID();
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const ORG_C = randomUUID();
const ORG_D = randomUUID();
const ORG_E = randomUUID();
const ORG_F = randomUUID();

const ORG_B_NAME = `Org B ${SUITE}`;

// All five users share ONE provider and differ only in their external id, and
// that is load-bearing for case 7d: `User_identity_bootstrap` ANDs its two
// halves, so a context that sets only the provider matches nothing. Had the
// policy ORed them instead, the same read would return five rows — so the
// assertion distinguishes AND from OR rather than merely observing a NULL.
const AUTH_PROVIDER = `test-provider-${SUITE}`;
const EXTERNAL_A = `external-a-${SUITE}`;
const EXTERNAL_B = `external-b-${SUITE}`;
const EXTERNAL_C = `external-c-${SUITE}`;
const EXTERNAL_D = `external-d-${SUITE}`;
const EXTERNAL_E = `external-e-${SUITE}`;

/**
 * The ids of two membership rows in ORG_A — the caller's own, and a co-member's —
 * captured by the seed because case 4's UPDATE assertions have to name exactly
 * one row and `where: { userId }` is a tenant predicate this file forbids.
 * `where: { id }` names a row, not a tenant.
 */
let memberIdOfAInOrgA = '';
let memberIdOfCInOrgA = '';

/**
 * Every GUC this migration's policies read, set on one interactive transaction.
 *
 * This is test-local on purpose. `withOrganizationContext` sets exactly ONE
 * GUC (`app.current_org_id`), so it cannot express any case below that needs
 * `app.current_user_id` or the identity pair, and Task 3's file list
 * deliberately does not include `src/client.ts` — Plan 1A Task 4 owns the typed
 * `withTenantContext` / `withIdentityContext` setters and is the only place
 * either bootstrap GUC may be set in production code.
 *
 * Same mechanism as `withOrganizationContext` for the same reasons: an
 * interactive transaction, because Prisma pools connections and a session-level
 * `SET` is invisible to the next query on another backend; and
 * `set_config(name, value, is_local => true)` rather than `SET LOCAL`, because
 * `SET LOCAL` cannot take a bind parameter.
 *
 * One statement per setting, with the setting NAME written out literally: a
 * tagged template binds VALUES, not identifiers, so a loop over `[name, value]`
 * pairs would need `$executeRawUnsafe`, which is banned in this package (see
 * `eslint.config.js`). An absent key sets nothing, which is what makes "with
 * the user GUC unset" expressible as a test case rather than as a comment.
 */
interface GucContext {
  readonly organizationId?: string;
  readonly userId?: string;
  readonly authProvider?: string;
  readonly externalAuthId?: string;
}

async function withGucs<T>(
  client: MetrikaPrismaClient,
  context: GucContext,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return client.$transaction(
    async (tx) => {
      if (context.organizationId !== undefined) {
        await tx.$executeRaw`SELECT set_config('app.current_org_id', ${context.organizationId}, true)`;
      }
      if (context.userId !== undefined) {
        await tx.$executeRaw`SELECT set_config('app.current_user_id', ${context.userId}, true)`;
      }
      if (context.authProvider !== undefined) {
        await tx.$executeRaw`SELECT set_config('app.current_auth_provider', ${context.authProvider}, true)`;
      }
      if (context.externalAuthId !== undefined) {
        await tx.$executeRaw`SELECT set_config('app.current_external_auth_id', ${context.externalAuthId}, true)`;
      }
      return fn(tx);
    },
    { timeout: 10_000 },
  );
}

/**
 * The seed demonstrates the design's most surprising property by being forced
 * to obey it: `WITH CHECK ("id" = app_current_user_id())` means a `User` row can
 * only be inserted once `app.current_user_id` ALREADY equals the id being
 * inserted, and the same for `Organization` and `app.current_org_id`. So every
 * id below is minted first, then set as context, then passed explicitly in
 * `data` — the emitted column carries no database `DEFAULT` (Prisma generates
 * the value client-side), so there is no arrangement in which the database
 * assigns the id and the policy passes. ADR-0040 records this; Task 4's
 * `newUuidV7()` is the production spelling of the minting half.
 *
 * Relations are written as scalar foreign keys, never as `connect`. A `connect`
 * makes Prisma READ the referenced row first, and under these policies that read
 * fails in exactly the contexts the writes need. Referential integrity itself is
 * checked by Postgres OUTSIDE row-level security, which is why the raw FK
 * assignment succeeds where a `connect` would not (ADR-0040, consequence 2).
 *
 * EVERY WRITE BELOW SETS BOTH TENANCY GUCS, and that is no longer merely tidy.
 * `OrganizationMember`'s write half requires `"userId" = app_current_user_id()`
 * and `Organization`'s requires `"personalOwnerUserId"` to be NULL or the caller,
 * so a seed that set only the organization GUC is refused. The narrower
 * predicates are what closed a measured escalation (see cases 4 and 11); the
 * cost lands here, on the fixture, which is the right place for it.
 *
 * THIS SEED IS ALSO THE ONLY THING THAT NOTICES A DELETED
 * `User_tenant_isolation`, and that is measured rather than assumed: removing
 * that policy removes the only INSERT-capable predicate on `User`, so
 * `person()` below fails and Vitest reports `15 tests | 15 skipped` with zero
 * failures — cases 3 and 6 never execute. Detection by SETUP, not by assertion.
 * If this seed is ever moved onto the owner/admin connection for speed (which
 * `packages/testing` exposes and which nine GUC transactions invite), that duty
 * transfers to case 3, whose co-member and self positive controls both go null
 * without the policy. Know which one you are relying on before you refactor it.
 */
beforeAll(async () => {
  try {
    await withDatabase(async (db) => {
      const person = async (
        id: string,
        externalAuthId: string,
        displayName: string,
      ): Promise<void> => {
        await withGucs(db, { userId: id }, async (tx) => {
          await tx.user.create({
            data: {
              id,
              authProvider: AUTH_PROVIDER,
              externalAuthId,
              email: `${externalAuthId}@example.test`,
              displayName,
            },
          });
        });
      };

      await person(USER_A, EXTERNAL_A, 'Person A');
      await person(USER_B, EXTERNAL_B, 'Person B');
      await person(USER_C, EXTERNAL_C, 'Person C');
      await person(USER_D, EXTERNAL_D, 'Person D');
      await person(USER_E, EXTERNAL_E, 'Person E');

      await withGucs(db, { organizationId: ORG_PERSONAL, userId: USER_A }, async (tx) => {
        await tx.organization.create({
          data: {
            id: ORG_PERSONAL,
            kind: 'PERSONAL',
            name: `Personal ${SUITE}`,
            slug: `personal-${SUITE}`,
            countryCode: 'CO',
            defaultCurrency: 'COP',
            // Populated, so the non-recursion and read cases below run against
            // the same shape production will have — and so
            // `Organization_personal_owner_required` is satisfied rather than
            // sidestepped. This is also the positive control for the
            // `personalOwnerUserId` half of `Organization`'s WITH CHECK: it
            // passes only because the user GUC above is USER_A, which is exactly
            // what provisioning will do.
            personalOwnerUserId: USER_A,
          },
        });
      });

      const team = async (id: string, name: string, slug: string): Promise<void> => {
        await withGucs(db, { organizationId: id }, async (tx) => {
          await tx.organization.create({
            data: {
              id,
              kind: 'TEAM',
              name,
              slug,
              countryCode: 'CO',
              defaultCurrency: 'COP',
            },
          });
        });
      };

      await team(ORG_A, `Org A ${SUITE}`, `org-a-${SUITE}`);
      await team(ORG_B, ORG_B_NAME, `org-b-${SUITE}`);
      await team(ORG_C, `Org C ${SUITE}`, `org-c-${SUITE}`);
      await team(ORG_D, `Org D ${SUITE}`, `org-d-${SUITE}`);
      await team(ORG_E, `Org E ${SUITE}`, `org-e-${SUITE}`);
      await team(ORG_F, `Org F ${SUITE}`, `org-f-${SUITE}`);

      // Both GUCs, because the write half now requires `"userId" =
      // app_current_user_id()`. Which is to say: this fixture can only create
      // SELF-memberships, exactly like the app role in production — an
      // "an ADMIN adds somebody" row is not writable through this connection at
      // all, and case 4 is where that is asserted rather than assumed.
      const membership = async (
        organizationId: string,
        userId: string,
        role: 'OWNER' | 'MEMBER',
      ): Promise<string> => {
        const id = randomUUID();
        await withGucs(db, { organizationId, userId }, async (tx) => {
          await tx.organizationMember.create({ data: { id, organizationId, userId, role } });
        });
        return id;
      };

      await membership(ORG_PERSONAL, USER_A, 'OWNER');
      // Both ids kept, because case 4's UPDATE assertions have to name ONE row:
      // `where: { id }` names a row and not a tenant, which is the distinction
      // this file's standing comment draws. `where: { userId }` would be a tenant
      // predicate and is banned here.
      memberIdOfAInOrgA = await membership(ORG_A, USER_A, 'OWNER');
      memberIdOfCInOrgA = await membership(ORG_A, USER_C, 'MEMBER');
      await membership(ORG_B, USER_A, 'MEMBER');
      await membership(ORG_B, USER_B, 'OWNER');
      await membership(ORG_C, USER_B, 'OWNER');
      // Case 10's own fixture: one member, two organizations, so "visible" and
      // "deletable" are different sets and the difference is measurable.
      await membership(ORG_D, USER_D, 'OWNER');
      await membership(ORG_E, USER_D, 'OWNER');
      // Case 11's own fixture.
      await membership(ORG_F, USER_E, 'OWNER');
    });
  } catch (error) {
    // Every case below depends on this seed. A wrong predicate can make the
    // SEED fail closed, which surfaces as every test in the file failing with a
    // bare Prisma stack trace pointing at `beforeAll` — easy to misread as
    // flaky setup when it is the opposite: the backstop refusing a write before
    // any assertion got to run. Re-thrown with context rather than swallowed,
    // following `rls.integration.test.ts:19-33`.
    throw new Error(
      'Seeding the identity/tenancy fixtures failed. If this is why every test in this file ' +
        'is failing, read it as the migration itself being wrong (a policy predicate, the ' +
        'Organization_personal_owner_required CHECK, or a missing app_current_* function) ' +
        'rather than as a flaky setup step — see the cause below.',
      { cause: error },
    );
  }
});

afterAll(async () => {
  await stopDatabase();
});

describe('case 1 — the widened Organization read returns every organization the caller is in, and no other', () => {
  it("returns the organization in context plus the caller's other memberships, and not a third organization", async () => {
    const ids = await withDatabase(async (db) =>
      withGucs(db, { organizationId: ORG_A, userId: USER_A }, async (tx) =>
        (await tx.organization.findMany()).map((organization) => organization.id).sort(),
      ),
    );

    expect(ids).toEqual([ORG_A, ORG_B, ORG_PERSONAL].sort());
    // Stated separately as well as implied by the equality above, because it is
    // the assertion the widening exists to be constrained by: ORG_C has rows
    // and members, and the caller is not one of them.
    expect(ids).not.toContain(ORG_C);
  });

  it('collapses to the organization in context when the user GUC is unset — which is why case 1 sets both', async () => {
    // MEASURED during Task 3, and the reason this test exists rather than a
    // comment: the widened branch reads `OrganizationMember`, whose own policy
    // makes the subquery row visible only through `userId =
    // app_current_user_id()`. With the user GUC unset that branch is DEAD, so
    // a version of case 1 that set only the organization GUC would return one
    // row, pass its `not.toContain(ORG_C)` assertion, and measure nothing at
    // all about the widening. This pins the composition so that reordering the
    // two predicates cannot quietly restore the false pass.
    const ids = await withDatabase(async (db) =>
      withGucs(db, { organizationId: ORG_A }, async (tx) =>
        (await tx.organization.findMany()).map((organization) => organization.id).sort(),
      ),
    );

    expect(ids).toEqual([ORG_A]);
  });
});

describe("case 2 — the widened OrganizationMember read is the caller's own memberships plus this organization's roster", () => {
  it('returns both branches of the OR, and neither another member of another organization nor an organization the caller is not in', async () => {
    const rows = await withDatabase(async (db) =>
      withGucs(db, { organizationId: ORG_A, userId: USER_A }, async (tx) =>
        (await tx.organizationMember.findMany())
          .map((member) => `${member.organizationId}|${member.userId}`)
          .sort(),
      ),
    );

    expect(rows).toEqual(
      [
        // organizationId = app_current_org_id(): the roster of the organization
        // in context, including other people.
        `${ORG_A}|${USER_A}`,
        `${ORG_A}|${USER_C}`,
        // userId = app_current_user_id(): the caller's OWN membership rows in
        // organizations that are not in context. This is the branch /me needs.
        `${ORG_PERSONAL}|${USER_A}`,
        `${ORG_B}|${USER_A}`,
      ].sort(),
    );

    // The two exclusions the OR must not reach. The first is the sharper one:
    // USER_B's membership of ORG_B is a row in an organization the caller IS a
    // member of — the policy grants the caller their own rows there, not
    // everybody's.
    expect(rows).not.toContain(`${ORG_B}|${USER_B}`);
    expect(rows).not.toContain(`${ORG_C}|${USER_B}`);
  });
});

describe('case 3 — User is readable only as yourself or as a co-member of the organization in context', () => {
  it('returns null for a stranger while still returning the caller and a co-member', async () => {
    const seen = await withDatabase(async (db) =>
      withGucs(db, { organizationId: ORG_A, userId: USER_A }, async (tx) => ({
        // USER_B shares no organization with the caller.
        stranger: await tx.user.findUnique({ where: { id: USER_B } }),
        // Positive controls, without which `null` proves nothing: a `null` from
        // a broken connection, a wrong id or an over-tight predicate looks
        // identical to a `null` from correct isolation.
        coMember: await tx.user.findUnique({ where: { id: USER_C } }),
        self: await tx.user.findUnique({ where: { id: USER_A } }),
      })),
    );

    expect(seen.stranger).toBeNull();
    expect(seen.coMember?.id).toBe(USER_C);
    expect(seen.self?.id).toBe(USER_A);
  });
});

/**
 * CASE 4 — the `OrganizationMember` write half, which constrains BOTH columns.
 *
 * Two rejections, not one, and the second is the one that closes a measured
 * privilege escalation rather than restating the tenant boundary. This table is
 * the set the `User` policy reads THROUGH: a row here whose `userId` is X makes
 * X's whole `User` row readable to anybody scoped to that organization. So
 * `"organizationId" = app_current_org_id()` on its own bounded the widening by a
 * table the app role can write, which is no bound at all.
 *
 * MEASURED before the fix, as `metrika_app` scoped to ORG_A as USER_A:
 * `SELECT … FROM "User" WHERE id = <stranger>` returned 0 rows; the INSERT of
 * `(ORG_A, <stranger>)` returned `INSERT 0 1`; the same SELECT then returned the
 * stranger's id, email, displayName, authProvider AND externalAuthId.
 */
describe('case 4 — the OrganizationMember write half constrains the organization AND the user', () => {
  it('rejects a membership row stamped with another organization id, through a path that cannot be a USING filter', async () => {
    // The row is legal in every other respect: both foreign keys resolve and
    // `(ORG_B, USER_C)` is not taken. Note that the caller CAN read ORG_B (case
    // 1) and their own membership of it (case 2) — the read half being wide is
    // exactly what makes this the interesting rejection.
    //
    // TWO WRITE PATHS, BECAUSE THEY MEASURE DIFFERENT HALVES, and an earlier
    // version of this case measured the wrong one without knowing it. Prisma's
    // `create` emits `INSERT … RETURNING`, so the returned row is subject to the
    // SELECT policy — MEASURED: under a mutated `WITH CHECK (true)` the same row
    // inserted by raw SQL with no RETURNING SUCCEEDED while `create` still threw
    // 42501, and the two Postgres messages are byte-identical (`new row violates
    // row-level security policy for table "OrganizationMember"`, with no
    // `(USING expression)` marker and no policy name in either). So `create`
    // alone cannot distinguish a WITH CHECK rejection from the SELECT policy
    // refusing the RETURNING row, and a cross-organization row would have stayed
    // plantable through `createMany` or raw SQL.
    //
    // `createMany` emits no RETURNING, so its refusal can only be WITH CHECK.
    // `create` is kept beside it because it is the shape production code uses.
    await expect(
      withDatabase(async (db) =>
        withGucs(db, { organizationId: ORG_A, userId: USER_A }, async (tx) =>
          tx.organizationMember.create({
            data: { id: randomUUID(), organizationId: ORG_B, userId: USER_C, role: 'MEMBER' },
          }),
        ),
      ),
    ).rejects.toThrow(/row-level security/i);

    await expect(
      withDatabase(async (db) =>
        withGucs(db, { organizationId: ORG_A, userId: USER_A }, async (tx) =>
          tx.organizationMember.createMany({
            data: [{ id: randomUUID(), organizationId: ORG_B, userId: USER_C, role: 'MEMBER' }],
          }),
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('rejects a membership row for a stranger in the caller’s OWN organization, and the stranger stays unreadable', async () => {
    // The escalation, as a fixture. Everything about this row is in-tenant: the
    // organization IS the one in context, so `"organizationId" =
    // app_current_org_id()` passes, and only `"userId" = app_current_user_id()`
    // can refuse it.
    await expect(
      withDatabase(async (db) =>
        withGucs(db, { organizationId: ORG_A, userId: USER_A }, async (tx) =>
          tx.organizationMember.createMany({
            data: [{ id: randomUUID(), organizationId: ORG_A, userId: USER_B, role: 'OWNER' }],
          }),
        ),
      ),
    ).rejects.toThrow(/row-level security/i);

    // The consequence, asserted rather than argued: the point of the rejection
    // is that USER_B's `User` row does not become readable. Without this, the
    // test above would pass for a reason nobody checked.
    const stranger = await withDatabase(async (db) =>
      withGucs(db, { organizationId: ORG_A, userId: USER_A }, async (tx) =>
        tx.user.findUnique({ where: { id: USER_B } }),
      ),
    );
    expect(stranger).toBeNull();
  });

  it('rejects re-pointing the caller’s OWN membership row at a stranger, while the same row’s role is writable', async () => {
    // The same escalation through UPDATE rather than INSERT, which is a separate
    // reachable path — MEASURED as `UPDATE 1` before the fix. `updateMany`
    // reports a count rather than rows, so it shares none of `create`'s
    // RETURNING ambiguity.
    //
    // The caller's OWN row on purpose, not a co-member's: WITH CHECK is applied
    // to the whole NEW row, so an update of a co-member's row is refused
    // whatever it changes (see the next assertion), and using one here would
    // make this rejection prove nothing about `userId` in particular.
    await expect(
      withDatabase(async (db) =>
        withGucs(db, { organizationId: ORG_A, userId: USER_A }, async (tx) =>
          tx.organizationMember.updateMany({
            where: { id: memberIdOfAInOrgA },
            data: { userId: USER_B },
          }),
        ),
      ),
    ).rejects.toThrow(/row-level security/i);

    // Positive control on the SAME row in the SAME context: it is reachable and
    // writable, so the rejection above is a WITH CHECK refusal of the new
    // `userId` rather than a `where` that matched nothing or a USING half that
    // hid the row.
    const reachable = await withDatabase(async (db) =>
      withGucs(db, { organizationId: ORG_A, userId: USER_A }, async (tx) =>
        tx.organizationMember.updateMany({
          where: { id: memberIdOfAInOrgA },
          data: { role: 'BILLING' },
        }),
      ),
    );
    expect(reachable.count).toBe(1);
  });

  it('refuses ANY update to a co-member’s membership row, which is what the narrowed write half costs', async () => {
    // THE PRICE OF THE FIX, ASSERTED RATHER THAN DISCOVERED. `WITH CHECK` is
    // evaluated against the whole new row, so requiring
    // `"userId" = app_current_user_id()` makes every row belonging to somebody
    // else unwritable — including a role change an ADMIN would legitimately make.
    // RLS therefore admits SELF-membership writes only, and Plan 1C owns the
    // choice between widening this clause and routing administrative membership
    // writes through Plan 1D's audited elevated client. It is deliberately the
    // narrow direction: widening a shipped predicate is an `ALTER POLICY`,
    // narrowing one is a data migration.
    //
    // This is here so that a 1C author who trips over it reads a test that
    // expected it rather than concluding the policy is broken.
    await expect(
      withDatabase(async (db) =>
        withGucs(db, { organizationId: ORG_A, userId: USER_A }, async (tx) =>
          tx.organizationMember.updateMany({
            where: { id: memberIdOfCInOrgA },
            data: { role: 'BILLING' },
          }),
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe('case 5 — the Organization read half is widened and the write half is not', () => {
  it('reads another organization the caller belongs to and is still refused when it writes to it', async () => {
    const visible = await withDatabase(async (db) =>
      withGucs(db, { organizationId: ORG_A, userId: USER_A }, async (tx) =>
        tx.organization.findUnique({ where: { id: ORG_B } }),
      ),
    );
    // Asserted first and in the same context as the rejection below, so the
    // rejection cannot be explained by the row being invisible. Nothing else in
    // this suite asserts that the two halves came apart on purpose.
    expect(visible?.id).toBe(ORG_B);

    await expect(
      withDatabase(async (db) =>
        withGucs(db, { organizationId: ORG_A, userId: USER_A }, async (tx) =>
          // `updateMany`, not `update`: `updateMany` cannot report "record not
          // found", so a green result here is unambiguously a WITH CHECK
          // rejection of a row the statement genuinely reached, rather than a
          // USING filter that removed it first.
          tx.organization.updateMany({ where: { id: ORG_B }, data: { name: 'stolen' } }),
        ),
      ),
    ).rejects.toThrow(/row-level security/i);

    const after = await withDatabase(async (db) =>
      withGucs(db, { organizationId: ORG_A, userId: USER_A }, async (tx) =>
        tx.organization.findUnique({ where: { id: ORG_B } }),
      ),
    );
    expect(after?.name).toBe(ORG_B_NAME);
  });
});

describe('case 6 — deny by default', () => {
  it('returns zero rows from all three tables with no context set at all', async () => {
    // A global emptiness assertion, and safe for the reason
    // `rls.integration.test.ts:110-115` gives: with nothing set, every
    // `app_current_*()` is NULL and NULL never equals anything, so no predicate
    // on any of the three tables matches ANY row — not just none of this
    // file's. That is a property of the policies, not a claim about table
    // contents, which is why it survives every other file's writes in the
    // shared container.
    const counts = await withDatabase(async (db) => ({
      users: (await db.user.findMany()).length,
      organizations: (await db.organization.findMany()).length,
      members: (await db.organizationMember.findMany()).length,
    }));

    expect(counts).toEqual({ users: 0, organizations: 0, members: 0 });
  });
});

/**
 * CASE 7 — the identity-bootstrap policy, in both directions.
 *
 * This is the case whose absence would have shipped a product where nobody can
 * sign in twice. `User_identity_bootstrap` is the only predicate that can answer
 * the `(authProvider, externalAuthId) → User` lookup every request begins with,
 * because at that moment `app.current_user_id` is what the lookup exists to
 * COMPUTE and `app.current_org_id` is read from a membership row nobody has
 * found yet. `metrika_app` is NOBYPASSRLS, so without this policy the lookup
 * returns zero rows for every RETURNING user, every sign-in after the first
 * falls into the provisioning path, and it violates
 * `User_authProvider_externalAuthId_key`.
 *
 * Split into one assertion per direction rather than bundled into a single
 * `it`, so a failure names which direction broke.
 *
 * WHERE THE MARGIN IS THIN HERE, measured rather than guessed, so that a future
 * author trimming "redundant-looking" cases knows which ones are load-bearing
 * alone. Deleting the whole policy is caught by 7a and ONLY 7a — 7b, 7c, 7d, 7e
 * and 7f all assert emptiness or refusal, and a deleted policy preserves both.
 * And the AND is pinned asymmetrically: dropping the PROVIDER half of it is
 * caught by 7c alone, while dropping the external-id half is caught by 7a, 7b
 * and 7d. Both directions do go red; two of them by a single `it` each.
 */
describe('case 7 — the identity-bootstrap policy', () => {
  it('7a — finds exactly the one row matching both halves, with neither tenancy GUC set', async () => {
    const ids = await withDatabase(async (db) =>
      withGucs(db, { authProvider: AUTH_PROVIDER, externalAuthId: EXTERNAL_A }, async (tx) =>
        (await tx.user.findMany()).map((user) => user.id),
      ),
    );

    // `findMany`, not `findFirst`: "returns the matching row" and "returns
    // EXACTLY the matching row" are different claims, and only the second one
    // rules out a predicate that is too wide.
    expect(ids).toEqual([USER_A]);
  });

  it('7b — finds nothing for a provider that matches and an external id that does not', async () => {
    const ids = await withDatabase(async (db) =>
      withGucs(
        db,
        { authProvider: AUTH_PROVIDER, externalAuthId: `no-such-identity-${SUITE}` },
        async (tx) => (await tx.user.findMany()).map((user) => user.id),
      ),
    );

    expect(ids).toEqual([]);
  });

  it('7c — finds nothing with only the external id set', async () => {
    const ids = await withDatabase(async (db) =>
      withGucs(db, { externalAuthId: EXTERNAL_A }, async (tx) =>
        (await tx.user.findMany()).map((user) => user.id),
      ),
    );

    expect(ids).toEqual([]);
  });

  it('7d — finds nothing with only the provider set, which is what distinguishes AND from OR', async () => {
    // All three seeded users share AUTH_PROVIDER. So a policy that ORed its two
    // halves instead of ANDing them would return THREE rows here, and a policy
    // that ANDs them returns none. That is what makes this assertion a
    // measurement rather than an observation that some NULL propagated.
    const ids = await withDatabase(async (db) =>
      withGucs(db, { authProvider: AUTH_PROVIDER }, async (tx) =>
        (await tx.user.findMany()).map((user) => user.id),
      ),
    );

    expect(ids).toEqual([]);
  });

  it('7e — cannot INSERT a User in bootstrap context', async () => {
    // Deliberately a FRESH external id and email, so the rejection cannot be a
    // unique-constraint violation wearing an RLS costume.
    const planted = randomUUID();
    await expect(
      withDatabase(async (db) =>
        withGucs(db, { authProvider: AUTH_PROVIDER, externalAuthId: EXTERNAL_A }, async (tx) =>
          tx.user.create({
            data: {
              id: planted,
              authProvider: AUTH_PROVIDER,
              externalAuthId: `planted-${planted}`,
              email: `planted-${planted}@example.test`,
              displayName: 'Planted',
            },
          }),
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('7f — cannot UPDATE a User in bootstrap context, and the row is untouched afterwards', async () => {
    // The mechanism, stated precisely because "rejected" undersells it: a
    // `FOR SELECT` policy contributes nothing to an UPDATE's USING, and
    // Postgres applies SELECT policies to a write only as an ADDITIONAL
    // restriction, never as a widening. So the only USING in force here is
    // `User_tenant_isolation`'s `"id" = app_current_user_id()`, which is NULL —
    // the row is not visible to the statement at all, and the write never
    // reaches a WITH CHECK. `updateMany` reports that as a zero count rather
    // than as an error, which is the honest shape to assert.
    const updated = await withDatabase(async (db) =>
      withGucs(db, { authProvider: AUTH_PROVIDER, externalAuthId: EXTERNAL_A }, async (tx) =>
        tx.user.updateMany({ where: { id: USER_A }, data: { displayName: 'stolen' } }),
      ),
    );
    expect(updated.count).toBe(0);

    // A zero count is also what a broken `where` produces, so the row is read
    // back through a context that CAN see it. Without this, 7f would pass for a
    // reason that has nothing to do with the policy.
    const after = await withDatabase(async (db) =>
      withGucs(db, { userId: USER_A }, async (tx) => tx.user.findUnique({ where: { id: USER_A } })),
    );
    expect(after?.displayName).toBe('Person A');
  });
});

describe('case 8 — Organization_personal_owner_required', () => {
  it('rejects a PERSONAL organization with a NULL personalOwnerUserId, and admits one with an owner', async () => {
    const orphan = randomUUID();
    await expect(
      withDatabase(async (db) =>
        // The organization GUC is set to the id being inserted, so RLS's
        // WITH CHECK passes and the CHECK constraint is the only thing left
        // that can refuse the row. Without that, this test would go green on an
        // RLS rejection and prove nothing about the constraint.
        withGucs(db, { organizationId: orphan }, async (tx) =>
          tx.organization.create({
            data: {
              id: orphan,
              kind: 'PERSONAL',
              name: `Orphan ${orphan}`,
              slug: `orphan-${orphan}`,
              countryCode: 'CO',
              defaultCurrency: 'COP',
            },
          }),
        ),
      ),
    ).rejects.toThrow(/Organization_personal_owner_required/);

    // Positive control: the identical insert with the column populated
    // succeeds, so the rejection above is about the NULL and not about
    // `kind: 'PERSONAL'`, the slug, or the context. USER_C holds no personal
    // organization, so `Organization_personalOwnerUserId_key` is free.
    //
    // The user GUC is USER_C, not absent: `Organization`'s WITH CHECK now
    // requires `personalOwnerUserId` to be NULL or the caller (case 11), so this
    // control has to be written the way provisioning writes it — mint the ids,
    // set both GUCs, pass both explicitly.
    const owned = randomUUID();
    const created = await withDatabase(async (db) =>
      withGucs(db, { organizationId: owned, userId: USER_C }, async (tx) =>
        tx.organization.create({
          data: {
            id: owned,
            kind: 'PERSONAL',
            name: `Owned ${owned}`,
            slug: `owned-${owned}`,
            countryCode: 'CO',
            defaultCurrency: 'COP',
            personalOwnerUserId: USER_C,
          },
        }),
      ),
    );
    expect(created.id).toBe(owned);
  });
});

describe('case 10 — DELETE is narrowed back to the organization in context', () => {
  it('deletes only the in-context row and leaves the caller’s membership of another organization intact', async () => {
    // THE GAP THIS CLOSES WAS REACHABLE AND UNMITIGATED. `DELETE` is filtered by
    // `USING` and has no `WITH CHECK` half, so the widened read half widened
    // DELETE too — and neither of the two things that make that unreachable on
    // `User` and `Organization` covers this table: it has no `deletedAt`, so it
    // is absent from `SOFT_DELETABLE_MODELS` and `deleteMany` passes straight
    // through the extension, and no table carries a foreign key to it, so there
    // is nothing to restrict. MEASURED before the fix, as `metrika_app` scoped to
    // one organization: a bare `DELETE FROM "OrganizationMember"` removed 4 rows
    // spanning THREE organizations. `OrganizationMember_delete_in_context` — the
    // only `AS RESTRICTIVE` policy in the tree — is what takes it back.
    //
    // No `where` at all on the delete, deliberately: the point is that the
    // POLICY, not the query, is what bounds the statement.
    const visibleBefore = await withDatabase(async (db) =>
      withGucs(db, { organizationId: ORG_D, userId: USER_D }, async (tx) =>
        (await tx.organizationMember.findMany()).map((member) => member.organizationId).sort(),
      ),
    );
    // Both rows are VISIBLE — one through each branch of the widened USING —
    // which is what makes the count below a measurement of the restrictive
    // policy rather than of the read half.
    expect(visibleBefore).toEqual([ORG_D, ORG_E].sort());

    const deleted = await withDatabase(async (db) =>
      withGucs(db, { organizationId: ORG_D, userId: USER_D }, async (tx) =>
        tx.organizationMember.deleteMany({}),
      ),
    );
    // 1, not 2: the in-context row went, the other organization's did not.
    // A non-zero count is also the positive control — deletes are narrowed, not
    // forbidden, so a policy that denied everything would fail here too.
    expect(deleted.count).toBe(1);

    const survivor = await withDatabase(async (db) =>
      withGucs(db, { organizationId: ORG_E, userId: USER_D }, async (tx) =>
        (await tx.organizationMember.findMany()).map((member) => member.organizationId),
      ),
    );
    expect(survivor).toEqual([ORG_E]);
  });
});

describe('case 11 — the Organization write half constrains personalOwnerUserId, not only id', () => {
  it('refuses a stranger as personal owner, refuses a personal organization fabricated for one, and admits the caller’s own', async () => {
    // MEASURED before the fix, with `WITH CHECK ("id" = app_current_org_id())`
    // alone: `UPDATE "Organization" SET "personalOwnerUserId" = <stranger>`
    // returned `UPDATE 1`, permanently consuming that stranger's
    // `Organization_personalOwnerUserId_key` slot so their real personal
    // organization could never be created; and with the organization GUC set to
    // a fresh uuid, an INSERT of `kind = 'PERSONAL'` owned by that stranger
    // succeeded too. `User.personalOrganization` is the back-relation of this
    // column, so Task 6's find-or-create would have resolved the victim into an
    // attacker-controlled tenant.
    await expect(
      withDatabase(async (db) =>
        withGucs(db, { organizationId: ORG_F, userId: USER_E }, async (tx) =>
          tx.organization.updateMany({
            where: { id: ORG_F },
            data: { personalOwnerUserId: USER_B },
          }),
        ),
      ),
    ).rejects.toThrow(/row-level security/i);

    const fabricated = randomUUID();
    await expect(
      withDatabase(async (db) =>
        withGucs(db, { organizationId: fabricated, userId: USER_E }, async (tx) =>
          tx.organization.create({
            data: {
              id: fabricated,
              kind: 'PERSONAL',
              name: `Fabricated ${fabricated}`,
              slug: `fabricated-${fabricated}`,
              countryCode: 'CO',
              defaultCurrency: 'COP',
              personalOwnerUserId: USER_B,
            },
          }),
        ),
      ),
    ).rejects.toThrow(/row-level security/i);

    // Positive control, and the shape provisioning uses: the caller's OWN id is
    // accepted. Without it the two rejections above would also be satisfied by a
    // predicate that refused every write to the column.
    const own = await withDatabase(async (db) =>
      withGucs(db, { organizationId: ORG_F, userId: USER_E }, async (tx) =>
        tx.organization.updateMany({
          where: { id: ORG_F },
          data: { personalOwnerUserId: USER_E },
        }),
      ),
    );
    expect(own.count).toBe(1);

    // And the NULL branch, which is Plan 1C's convert-a-personal-organization
    // path: clearing the column is permitted, so the clause does not turn 1C's
    // UPDATE into a constraint fight.
    const cleared = await withDatabase(async (db) =>
      withGucs(db, { organizationId: ORG_F, userId: USER_E }, async (tx) =>
        tx.organization.updateMany({ where: { id: ORG_F }, data: { personalOwnerUserId: null } }),
      ),
    );
    expect(cleared.count).toBe(1);
  });
});

describe('case 12 — the two format constraints the column types cannot express', () => {
  it('rejects a mixed-case email and admits the lowercased form', async () => {
    // "One email, one user" was an application convention wearing a
    // constraint's name. MEASURED before `User_email_lowercase`:
    // `Probe-A@example.test` inserted happily alongside `probe-a@example.test`,
    // because `User_email_key` is a plain unique index and Postgres has no
    // case-insensitive text type without `citext`. Task 6 normalises; this is
    // what makes forgetting to a refused write rather than a second account for
    // the same person.
    const id = randomUUID();
    await expect(
      withDatabase(async (db) =>
        withGucs(db, { userId: id }, async (tx) =>
          tx.user.create({
            data: {
              id,
              authProvider: AUTH_PROVIDER,
              externalAuthId: `mixed-${id}`,
              email: `Mixed-${id}@example.test`,
              displayName: 'Mixed',
            },
          }),
        ),
      ),
    ).rejects.toThrow(/User_email_lowercase/);

    // The same row with the address lowercased, so the rejection above is about
    // the case and not about the context, the provider or the id.
    const created = await withDatabase(async (db) =>
      withGucs(db, { userId: id }, async (tx) =>
        tx.user.create({
          data: {
            id,
            authProvider: AUTH_PROVIDER,
            externalAuthId: `mixed-${id}`,
            email: `mixed-${id}@example.test`,
            displayName: 'Mixed',
          },
        }),
      ),
    );
    expect(created.id).toBe(id);
  });

  it('rejects a countryCode that is not two uppercase letters and admits one that is', async () => {
    // `@db.Char(2)` is a MAXIMUM width and nothing more: MEASURED, `'c'` was
    // accepted and stored blank-padded at length 1. The MEMBER set is still an
    // API-boundary check — there is no ISO-3166 vocabulary in
    // `packages/contracts` — but the FORMAT is now the database's business.
    const wrong = randomUUID();
    await expect(
      withDatabase(async (db) =>
        withGucs(db, { organizationId: wrong }, async (tx) =>
          tx.organization.create({
            data: {
              id: wrong,
              kind: 'TEAM',
              name: `Lowercase code ${wrong}`,
              slug: `lowercase-code-${wrong}`,
              countryCode: 'co',
              defaultCurrency: 'COP',
            },
          }),
        ),
      ),
    ).rejects.toThrow(/Organization_country_code_format/);

    const right = randomUUID();
    const created = await withDatabase(async (db) =>
      withGucs(db, { organizationId: right }, async (tx) =>
        tx.organization.create({
          data: {
            id: right,
            kind: 'TEAM',
            name: `Uppercase code ${right}`,
            slug: `uppercase-code-${right}`,
            countryCode: 'CO',
            defaultCurrency: 'COP',
          },
        }),
      ),
    );
    expect(created.id).toBe(right);
  });
});

describe('case 9 — the role these cases ran as', () => {
  it('is neither a superuser nor BYPASSRLS, so every assertion above measured a policy', async () => {
    // `sql/00-app-role.sql:9-15` names a superuser connection as "the single
    // most likely way for the tenant-isolation backstop to be silently absent",
    // and it is not a hypothetical: the local compose `metrika` role IS a
    // bootstrap superuser, so a psql probe against the compose stack proves
    // nothing. A superuser bypasses every policy including FORCE, which would
    // turn every rejection above into a pass for the wrong reason — this is the
    // assertion that makes the other eight cases mean what they say.
    const [role] = await withDatabase(
      async (db) =>
        db.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
        SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
      `,
    );

    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});
