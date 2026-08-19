import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infrastructure/persistence/prisma.service.js';
import {
  runInBootstrapTenant,
  runInIdentityScope,
  runInTenant,
} from '../src/infrastructure/persistence/tenant-context.js';
import type { AuthContext } from '../src/authorization/auth-context.js';
import { bootApiForTest, stopDatabase } from './support.js';

/**
 * THE THREE ENTRY POINTS ARE THE CONTROL SURFACE, SO THEY ARE WHAT IS TESTED.
 *
 * This file exists because a mutation found its absence. Plan 1A Task 4 Step 6
 * mutation 4 rewires `runInIdentityScope` to set the TENANCY GUCs instead of the
 * identity pair — the exact defect that would make Task 3's widened `User`
 * predicate reachable from an ordinary request — and with only
 * `packages/database/test/tenant-context.integration.test.ts` in the tree, that
 * mutation left every gate GREEN. Measured: `Tests 5 passed`, exit 0.
 *
 * The reason is that the package-level suite asserts `withIdentityContext`,
 * which the mutation does not touch. Nothing asserted the WRAPPERS, and the
 * wrappers are the whole point of the task: `packages/database` exposes two
 * functions taking raw scopes, and `apps/api` is supposed to be incapable of
 * reaching them except through these three.
 *
 * A test that cannot fail when its subject is broken is a comment.
 */
describe('tenant-context entry points', () => {
  let app: NestFastifyApplication;
  let client: PrismaService['client'];

  beforeAll(async () => {
    ({ app } = await bootApiForTest());
    client = app.get(PrismaService).client;
  });

  afterAll(async () => {
    await app.close();
    await stopDatabase();
  });

  async function guc(tx: {
    $queryRaw: <T>(q: TemplateStringsArray, ...v: unknown[]) => Promise<T>;
  }): Promise<{ org: string | null; user: string | null; provider: string | null }> {
    const [row] = await tx.$queryRaw<
      { org: string | null; user: string | null; provider: string | null }[]
    >`
      SELECT NULLIF(current_setting('app.current_org_id', true), '')        AS org,
             NULLIF(current_setting('app.current_user_id', true), '')       AS user,
             NULLIF(current_setting('app.current_auth_provider', true), '') AS provider
    `;
    return { org: row?.org ?? null, user: row?.user ?? null, provider: row?.provider ?? null };
  }

  const ORG = '11111111-1111-4111-8111-111111111111';
  const USER = '22222222-2222-4222-8222-222222222222';

  it('runInTenant sets both tenancy GUCs from the AuthContext, and no identity GUC', async () => {
    const auth = { organizationId: ORG, userId: USER } as unknown as AuthContext;

    const seen = await runInTenant(client, auth, async (tx) => guc(tx));

    expect(seen.org).toBe(ORG);
    expect(seen.user).toBe(USER);
    expect(seen.provider).toBeNull();
  });

  it('runInBootstrapTenant sets both tenancy GUCs from a raw scope', async () => {
    // The first declared exemption. It takes a raw scope on purpose: the rows
    // do not exist yet, so there is no AuthContext to derive one from.
    const seen = await runInBootstrapTenant(
      client,
      { organizationId: ORG, userId: USER },
      async (tx) => guc(tx),
    );

    expect(seen.org).toBe(ORG);
    expect(seen.user).toBe(USER);
  });

  it('runInIdentityScope sets the identity pair and leaves BOTH tenancy GUCs empty', async () => {
    // THE ASSERTION MUTATION 4 EXISTS FOR. If this wrapper ever reaches
    // `withTenantContext`, the bootstrap predicate becomes carryable into an
    // ordinary request and Task 3's widened `User` policy stops being narrow.
    const seen = await runInIdentityScope(
      client,
      { authProvider: 'clerk', externalAuthId: 'user_probe' },
      async (tx) => guc(tx),
    );

    expect(seen.provider).toBe('clerk');
    expect(seen.org).toBeNull();
    expect(seen.user).toBeNull();
  });
});
