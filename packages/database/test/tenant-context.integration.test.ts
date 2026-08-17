import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { startTestDatabase, stopDatabase } from './support.js';
import { createPrismaClient, withIdentityContext, withTenantContext } from '../src/index.js';

afterAll(async () => {
  await stopDatabase();
});

/**
 * One row of `current_setting(name, true)`. `true` is the missing_ok flag: an
 * unset GUC returns NULL rather than raising, which is the same property every
 * RLS predicate depends on and the reason an unset context denies rather than
 * errors.
 */
interface Settings {
  readonly org: string | null;
  readonly user: string | null;
  readonly provider: string | null;
  readonly external: string | null;
}

async function settings(tx: {
  $queryRaw: <T>(q: TemplateStringsArray, ...v: unknown[]) => Promise<T>;
}): Promise<Settings> {
  const [row] = await tx.$queryRaw<
    { org: string | null; user: string | null; provider: string | null; external: string | null }[]
  >`
    SELECT NULLIF(current_setting('app.current_org_id', true), '')          AS org,
           NULLIF(current_setting('app.current_user_id', true), '')         AS user,
           NULLIF(current_setting('app.current_auth_provider', true), '')   AS provider,
           NULLIF(current_setting('app.current_external_auth_id', true), '') AS external
  `;
  return {
    org: row?.org ?? null,
    user: row?.user ?? null,
    provider: row?.provider ?? null,
    external: row?.external ?? null,
  };
}

describe('withTenantContext', () => {
  it('sets both tenancy GUCs inside the callback', async () => {
    const scope = { organizationId: randomUUID(), userId: randomUUID() };
    const handle = await startTestDatabase();
    const db = createPrismaClient({ databaseUrl: handle.applicationUrl });

    try {
      const seen = await withTenantContext(db, scope, async (tx) => settings(tx));
      expect(seen.org).toBe(scope.organizationId);
      expect(seen.user).toBe(scope.userId);
    } finally {
      await db.$disconnect();
    }
  });

  it('does not leak past its scope on a reused client', async () => {
    // The mutation this exists for is `is_local: false` on either set_config —
    // see Step 6 mutation 2. Under that mutation the setting survives the
    // transaction and lands on whichever pooled connection is handed back next,
    // so the unscoped read below sees a context it was never given. ONE client
    // across two operations is what makes that observable; a fresh client per
    // call gets its own idle connection and the leak hides. Same reasoning as
    // organization-context.integration.test.ts, which found it first.
    const scope = { organizationId: randomUUID(), userId: randomUUID() };
    const handle = await startTestDatabase();
    const db = createPrismaClient({ databaseUrl: handle.applicationUrl });

    try {
      await withTenantContext(db, scope, async (tx) => settings(tx));

      const after = await settings(db);
      expect(after.org).toBeNull();
      expect(after.user).toBeNull();
    } finally {
      await db.$disconnect();
    }
  });

  it('hides a row it wrote from an unscoped read on the same client', async () => {
    // The GUC assertion above proves the SETTING reverts. This proves the
    // consequence that matters: RLS denies the row once it has, so the leak
    // would be a cross-tenant read rather than a stale variable.
    const scope = { organizationId: randomUUID(), userId: randomUUID() };
    const handle = await startTestDatabase();
    const db = createPrismaClient({ databaseUrl: handle.applicationUrl });

    try {
      await withTenantContext(db, scope, async (tx) => {
        await tx.rlsProbe.create({
          data: { organizationId: scope.organizationId, label: 'tenant' },
        });
      });

      const rows = await db.rlsProbe.findMany({ where: { label: 'tenant' } });
      expect(rows).toEqual([]);
    } finally {
      await db.$disconnect();
    }
  });

  it('is transaction-local, so two concurrent scopes do not observe each other', async () => {
    // `set_config(..., true)` is scoped to the transaction, not the session or
    // the connection. Run both at once and have each read its own setting back
    // AFTER the other has certainly set its own: if the flag were false, the
    // later writer would be visible to the earlier reader.
    const a = { organizationId: randomUUID(), userId: randomUUID() };
    const b = { organizationId: randomUUID(), userId: randomUUID() };
    const handle = await startTestDatabase();
    const db = createPrismaClient({ databaseUrl: handle.applicationUrl });

    try {
      const settle = async (scope: typeof a): Promise<Settings> =>
        withTenantContext(db, scope, async (tx) => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return settings(tx);
        });

      const [seenA, seenB] = await Promise.all([settle(a), settle(b)]);

      expect(seenA.org).toBe(a.organizationId);
      expect(seenA.user).toBe(a.userId);
      expect(seenB.org).toBe(b.organizationId);
      expect(seenB.user).toBe(b.userId);
    } finally {
      await db.$disconnect();
    }
  });
});

describe('withIdentityContext', () => {
  it('sets the identity pair and leaves BOTH tenancy GUCs empty', async () => {
    // This is the isolation that keeps Task 3's widened `User` predicate out of
    // every other query, so it is asserted here rather than assumed. Step 6
    // mutation 4 — making runInIdentityScope call withTenantContext — must fail
    // on THIS assertion rather than on a type error, or the isolation is
    // enforced by the compiler in one file and by nothing at runtime.
    const identity = { authProvider: 'clerk', externalAuthId: `user_${randomUUID()}` };
    const handle = await startTestDatabase();
    const db = createPrismaClient({ databaseUrl: handle.applicationUrl });

    try {
      const seen = await withIdentityContext(db, identity, async (tx) => settings(tx));

      expect(seen.provider).toBe(identity.authProvider);
      expect(seen.external).toBe(identity.externalAuthId);
      expect(seen.org).toBeNull();
      expect(seen.user).toBeNull();
    } finally {
      await db.$disconnect();
    }
  });
});
