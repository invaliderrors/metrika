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
 * The two moments a request has, as two shapes rather than one with optional
 * fields.
 *
 * `IdentityScope` is NOT a partial `TenantScope`. It sets different settings and
 * unlocks a different policy — `User_identity_bootstrap`, the `FOR SELECT`
 * predicate Task 3 added — and typing them as one shape with blanks is exactly
 * what would let an ordinary request carry the bootstrap predicate. The
 * narrowness is the control; the type is what keeps it.
 */
export interface TenantScope {
  readonly organizationId: string;
  readonly userId: string;
}

/** The pre-identity shape. Deliberately NOT a partial {@link TenantScope}. */
export interface IdentityScope {
  readonly authProvider: string;
  readonly externalAuthId: string;
}

/**
 * Opens a transaction and sets BOTH tenancy GUCs on it — `app.current_org_id`
 * and `app.current_user_id`. Every predicate Task 3's migration installed reads
 * one or both, and the widened `USING` halves on `Organization` and
 * `OrganizationMember` are unreachable without the second.
 *
 * Two statements rather than one call with two arguments, because `set_config`
 * takes one name. Bind parameters rather than interpolation, because `SET LOCAL`
 * cannot take one — which is the whole reason `set_config` is used here — and
 * `$executeRawUnsafe` is banned in this package as everywhere else.
 *
 * Same transaction requirement, and the same `P2028` ceiling, as
 * {@link withOrganizationContext} below. Request-scoped repository work only.
 *
 * IT DOES NOT AUTHORISE ANYTHING. `app.current_org_id` is whatever the caller
 * puts in it, and RLS compares against it without checking that the caller is a
 * member of that organization — measured, and recorded as ADR-0040 consequence
 * 10. Deriving the value from a membership lookup is the OBLIGATION OF THE
 * CALLER, which is why `apps/api` reaches this only through `runInTenant(auth,
 * fn)` and never with a raw scope from request input.
 */
export async function withTenantContext<T>(
  client: PrismaClient,
  scope: TenantScope,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return client.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${scope.organizationId}, true)`;
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${scope.userId}, true)`;
      return fn(tx);
    },
    { timeout: 10_000 },
  );
}

/**
 * Sets ONLY the identity pair, so `User_identity_bootstrap` is the only policy
 * that can match and every other table stays deny-by-default inside `fn`.
 *
 * That narrowness is the reason this is a separate function rather than two more
 * optional fields on {@link TenantScope}: a caller cannot accidentally carry the
 * bootstrap predicate into an ordinary request. The blast radius is exactly one
 * row — the `User` whose external identifier the token verifier already proved
 * by signature — and an unset half denies everything, because the policy ANDs
 * both and an unset GUC yields NULL.
 */
export async function withIdentityContext<T>(
  client: PrismaClient,
  identity: IdentityScope,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return client.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_auth_provider', ${identity.authProvider}, true)`;
      await tx.$executeRaw`SELECT set_config('app.current_external_auth_id', ${identity.externalAuthId}, true)`;
      return fn(tx);
    },
    { timeout: 10_000 },
  );
}

/**
 * SUPERSEDED by {@link withTenantContext}, and kept rather than removed.
 *
 * It sets only `app.current_org_id`, which is correct for `RlsProbe` — the
 * permanent regression fixture, which has an `organizationId` and no user
 * column — and for `organization-context.integration.test.ts`, whose leak
 * assertion is the reason the `$transaction` wrapper is known to be
 * load-bearing. Neither has a user to name. Anything with a `userId` predicate
 * needs the pair, so new callers take {@link withTenantContext}.
 *
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
