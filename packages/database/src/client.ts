import { PrismaClient } from '@prisma/client';

/**
 * Application Prisma client.
 * Tenant-scoped queries MUST go through `withOrg()` (see rls.ts) so
 * `app.current_org_id` is set per transaction. The base client alone
 * does not enforce RLS — it is the backstop, not the primary control.
 */
export function createPrismaClient(databaseUrl?: string): PrismaClient {
  return new PrismaClient({
    ...(databaseUrl !== undefined && {
      datasources: { db: { url: databaseUrl } },
    }),
    log: ['warn', 'error'],
  });
}

export type { PrismaClient };
