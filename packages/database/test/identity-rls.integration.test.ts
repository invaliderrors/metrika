import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stopDatabase, withDatabase } from './support.js';
import type { MetrikaPrismaClient } from '../src/index.js';

/**
 * The behavioural half of Plan 1A Task 3: the four policies of
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

// Three people. USER_A is the caller in almost every case below; USER_C is a
// co-member of ORG_A with them; USER_B is a stranger who shares no organization
// with USER_A.
const USER_A = randomUUID();
const USER_B = randomUUID();
const USER_C = randomUUID();

// Four organizations. ORG_A is the one in context; ORG_PERSONAL and ORG_B are
// two more that USER_A is a member of, so the widened read half has something
// to widen to; ORG_C is the control — it exists, it has members, and USER_A is
// not one of them. Without ORG_C, "returns everything the caller is a member
// of" is untested in the only direction that can leak.
const ORG_PERSONAL = randomUUID();
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const ORG_C = randomUUID();

const ORG_B_NAME = `Org B ${SUITE}`;

// All three users share ONE provider and differ only in their external id, and
// that is load-bearing for case 7d: `User_identity_bootstrap` ANDs its two
// halves, so a context that sets only the provider matches nothing. Had the
// policy ORed them instead, the same read would return three rows — so the
// assertion distinguishes AND from OR rather than merely observing a NULL.
const AUTH_PROVIDER = `test-provider-${SUITE}`;
const EXTERNAL_A = `external-a-${SUITE}`;
const EXTERNAL_B = `external-b-${SUITE}`;
const EXTERNAL_C = `external-c-${SUITE}`;

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

      await withGucs(db, { organizationId: ORG_PERSONAL }, async (tx) => {
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
            // sidestepped.
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

      const membership = async (
        organizationId: string,
        userId: string,
        role: 'OWNER' | 'MEMBER',
      ): Promise<void> => {
        await withGucs(db, { organizationId }, async (tx) => {
          await tx.organizationMember.create({
            data: { id: randomUUID(), organizationId, userId, role },
          });
        });
      };

      await membership(ORG_PERSONAL, USER_A, 'OWNER');
      await membership(ORG_A, USER_A, 'OWNER');
      await membership(ORG_A, USER_C, 'MEMBER');
      await membership(ORG_B, USER_A, 'MEMBER');
      await membership(ORG_B, USER_B, 'OWNER');
      await membership(ORG_C, USER_B, 'OWNER');
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

describe('case 4 — the OrganizationMember write half is not widened', () => {
  it('rejects a membership row stamped with another organization id', async () => {
    // The row is legal in every other respect: both foreign keys resolve and
    // `(ORG_B, USER_C)` is not taken, so the only thing that can refuse it is
    // `WITH CHECK ("organizationId" = app_current_org_id())`. Note that the
    // caller CAN read ORG_B (case 1) and their own membership of it (case 2) —
    // the read half being wide is exactly what makes this the interesting
    // rejection.
    await expect(
      withDatabase(async (db) =>
        withGucs(db, { organizationId: ORG_A, userId: USER_A }, async (tx) =>
          tx.organizationMember.create({
            data: { id: randomUUID(), organizationId: ORG_B, userId: USER_C, role: 'MEMBER' },
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
    const owned = randomUUID();
    const created = await withDatabase(async (db) =>
      withGucs(db, { organizationId: owned }, async (tx) =>
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
