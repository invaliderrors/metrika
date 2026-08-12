// A plain named import, matching extensions/soft-delete.ts. `@prisma/client`
// IS CommonJS — `exports["."]` resolves both `import` and `require` to the same
// `default.js`, whose body is `module.exports = { ...require(...) }` — but that
// exact spread-re-export shape is one Node's built-in cjs-module-lexer analyses
// statically, so named ESM imports of `PrismaClient` and `Prisma` resolve
// correctly. Verified empirically on Prisma 7.9.1 / Node 24.19.0 / TS 6.0.3,
// under moduleResolution NodeNext and Bundler, compiled and stripped. There is
// no default-import indirection anywhere in this repository; if you find one,
// it is a leftover from a premise that was disproved, not a workaround.
import { PrismaClient } from '@prisma/client';
// `Prisma` is used here only for `Prisma.TransactionClient`, so it keeps its
// `import type` form and `consistent-type-imports` stays quiet. This is a
// TYPE-only import of a namespace, not the DI footgun: nothing in this file is
// injected by NestJS.
import type { Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { softDeleteExtension } from './extensions/soft-delete.js';

export interface DatabaseConfig {
  /**
   * The APPLICATION role's URL (metrika_app), never the owner's. The owner
   * bypasses nothing — FORCE ROW LEVEL SECURITY sees to that — but it holds
   * DDL rights the running process has no business having.
   */
  readonly databaseUrl: string;
  /**
   * Ceiling on concurrent backends. On Prisma 6 this was `?connection_limit=`
   * in the URL; on 7 that parameter is inert and this is the only spelling
   * that works. Absent means pg.Pool's own default of 10 — which is itself a
   * change from Prisma 6's `num_cpus * 2 + 1`. See ADR-0037.
   */
  readonly maxPoolConnections?: number;
}

export function createPrismaClient(config: DatabaseConfig): PrismaClient {
  // A driver adapter is mandatory on Prisma 7. Two things that used to live in
  // the connection URL now live here and are silently ignored there: `?schema=`
  // (spell it `new PrismaPg(url, { schema })`) and `?connection_limit=` (pass
  // pg.Pool options, or a pg.Pool). See ADR-0037.
  const base = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: config.databaseUrl,
      // Not `max: config.maxPoolConnections`. `exactOptionalPropertyTypes` is
      // on, and a present key holding `undefined` is not the same thing as an
      // absent one to pg.Pool — this spelling is what keeps "unset" meaning
      // pg.Pool's own default.
      ...(config.maxPoolConnections === undefined ? {} : { max: config.maxPoolConnections }),
    }),
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
 *
 * This is an interactive transaction, which holds one pooled connection for
 * `fn`'s entire duration and fails with `P2028` if it runs past Prisma's
 * default `timeout` (5s) or waits past `maxWait` (2s) for a connection. `fn`
 * is meant for request-scoped repository work, not a slow background job —
 * a caller doing genuinely long-running work (geometry analysis, slicing)
 * belongs in a worker activity outside any interactive transaction entirely,
 * per the "no geometry work inside an HTTP request" rule. The explicit
 * `timeout` below only raises the ceiling for ordinary request-scoped work;
 * it does not make this the right tool for long operations.
 */
export async function withOrganizationContext<T>(
  client: PrismaClient,
  organizationId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return client.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${organizationId}, true)`;
      return fn(tx);
    },
    { timeout: 10_000 },
  );
}
