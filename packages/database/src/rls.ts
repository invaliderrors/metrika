import type { PrismaClient } from '@prisma/client';

/**
 * Run `fn` inside a transaction with `app.current_org_id` set,
 * so RLS policies see the caller's organization.
 *
 * `SET LOCAL` is transaction-scoped — safe under connection pooling.
 *
 * Every tenant-scoped repository method goes through this helper.
 * Bypassing it returns zero rows on RLS-protected tables (safe default).
 */
export async function withOrg<T>(
  prisma: PrismaClient,
  orgId: string,
  fn: (tx: PrismaClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // `SET LOCAL` via parameterised raw to avoid SQL injection on orgId.
    await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgId}, true)`;
    return fn(tx as unknown as PrismaClient);
  });
}

/**
 * Elevated (platform-admin) variant — does NOT set app.current_org_id,
 * so RLS must be bypassed via a separate, audited role. Every use is logged.
 */
export async function withElevated<T>(
  prisma: PrismaClient,
  reason: string,
  fn: (tx: PrismaClient) => Promise<T>,
): Promise<T> {
  if (reason.trim() === '') {
    throw new Error('withElevated requires a non-empty audit reason');
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.elevated_reason', ${reason}, true)`;
    return fn(tx as unknown as PrismaClient);
  });
}
