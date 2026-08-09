// A plain named import, matching extensions/soft-delete.ts. `@prisma/client`
// IS CommonJS — `exports["."]` resolves both `import` and `require` to the same
// `default.js`, whose body is `module.exports = { ...require(...) }` — but that
// exact spread-re-export shape is one Node's built-in cjs-module-lexer analyses
// statically, so named ESM imports of `PrismaClient` and `Prisma` resolve
// correctly. Verified empirically on Prisma 6.19.3 / Node 24.19.0 / TS 6.0.3,
// under moduleResolution NodeNext and Bundler, compiled and stripped. There is
// no default-import indirection anywhere in this repository; if you find one,
// it is a leftover from a premise that was disproved, not a workaround.
import { PrismaClient } from '@prisma/client';
// `Prisma` is used here only for `Prisma.TransactionClient`, so it keeps its
// `import type` form and `consistent-type-imports` stays quiet. This is a
// TYPE-only import of a namespace, not the DI footgun: nothing in this file is
// injected by NestJS.
import type { Prisma } from '@prisma/client';
import { softDeleteExtension } from './extensions/soft-delete.js';

export interface DatabaseConfig {
  /**
   * The APPLICATION role's URL (metrika_app), never the owner's. The owner
   * bypasses nothing — FORCE ROW LEVEL SECURITY sees to that — but it holds
   * DDL rights the running process has no business having.
   */
  readonly databaseUrl: string;
}

export function createPrismaClient(config: DatabaseConfig): PrismaClient {
  const base = new PrismaClient({
    datasources: { db: { url: config.databaseUrl } },
  });

  // `$extends` returns a structurally narrower client (it drops `$on` and
  // `$use`). Widening back to PrismaClient is sound — the extension only
  // rewrites query arguments, so every model delegate and every `$` method
  // this codebase uses survives — and it keeps the emitted .d.ts free of the
  // deep inferred `$extends` type, which pnpm's nested node_modules layout
  // cannot name (TS2742). The behaviour is unaffected; only the static type is
  // widened, and the integration suite is what proves the extension still runs.
  return base.$extends(softDeleteExtension) as unknown as PrismaClient;
}

/**
 * Opens a transaction and sets `app.current_org_id` on it, which is what every
 * RLS policy reads. It has to be a transaction: Prisma pools connections, and a
 * session-level setting made on one connection is invisible to the next query,
 * which lands on another.
 *
 * `set_config(name, value, is_local => true)` rather than `SET LOCAL`: they are
 * equivalent, but `SET LOCAL` cannot take a bind parameter, so using it would
 * mean interpolating `organizationId` into SQL text.
 */
export async function withOrganizationContext<T>(
  client: PrismaClient,
  organizationId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_org_id', ${organizationId}, true)`;
    return fn(tx);
  });
}
