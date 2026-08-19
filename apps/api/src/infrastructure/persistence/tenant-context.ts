// The ONLY module in this application that calls `withTenantContext` or
// `withIdentityContext`, and the reason that sentence is worth enforcing.
//
// `packages/database` exposes two functions that take raw scopes. A raw scope is
// two strings, and two strings are exactly what a request body can supply — so
// left reachable, "set the tenant context" becomes "set whatever the caller
// asked for", which is ADR-0040 consequence 10 turned from a documented
// obligation into a live cross-tenant read. MEASURED there: with
// `app.current_org_id` pointed at an organization the caller has no membership
// in, its `Organization` row, its whole roster and its members' emails were all
// readable, and a self-insert as OWNER succeeded.
//
// So the raw functions are wrapped here into three named entry points, and the
// names are the control:
//
//   runInTenant           — the ordinary path, and the ONLY one an AuthContext
//                           can reach. Every repository call in every later
//                           slice goes through it.
//   runInBootstrapTenant  — first-login provisioning, which MINTS both ids and
//                           therefore has no AuthContext to derive them from.
//   runInIdentityScope    — the pre-identity lookup, which runs before a user id
//                           exists by definition.
//
// The last two are the two declared exemptions to ADR-0013 decision 2 ("there is
// no method signature that permits forgetting who is asking"), recorded in
// ADR-0040 by symbol. Giving them their own entry points rather than letting
// them reach `withTenantContext` directly is what keeps the exemption A LIST OF
// TWO rather than a habit: 1B writes "`AuthContext` on every repository method,
// except the two named in ADR-0040" against this file, and adding a third is an
// ADR change that a reviewer sees.
import {
  withIdentityContext,
  withTenantContext,
  type IdentityScope,
  type MetrikaPrismaClient,
  type Prisma,
  type TenantScope,
} from '@metrika/database';
import type { AuthContext } from '../../authorization/auth-context.js';

type Work<T> = (tx: Prisma.TransactionClient) => Promise<T>;

/**
 * The ordinary path. Derives the scope from an `AuthContext` and nothing else —
 * there is no parameter here that a request can reach.
 *
 * THE SCOPE IS ONLY AS GOOD AS THE `AuthContext`. RLS compares
 * `app.current_org_id` against the row's column and does not check that the
 * caller is a member of it, so the membership check lives upstream, in whatever
 * built the `AuthContext`. Task 5's factory owes it; this signature is what
 * makes that the only place it can be owed.
 */
export async function runInTenant<T>(
  client: MetrikaPrismaClient,
  auth: AuthContext,
  work: Work<T>,
): Promise<T> {
  return withTenantContext(
    client,
    { organizationId: auth.organizationId, userId: auth.userId },
    work,
  );
}

/**
 * DECLARED EXEMPTION 1 of 2 — first-login provisioning.
 *
 * Takes a raw `TenantScope` because the rows it is about to create do not exist
 * yet: Task 3's `WITH CHECK` predicates require a row's id to equal the GUC
 * BEFORE its INSERT, so provisioning mints both ids, sets them here, and passes
 * `id` explicitly. There is no `AuthContext` to derive them from, and one built
 * before the `User` row exists would be a fiction.
 *
 * Reachable only from the provisioning repository. ADR-0040 names it.
 */
export async function runInBootstrapTenant<T>(
  client: MetrikaPrismaClient,
  scope: TenantScope,
  work: Work<T>,
): Promise<T> {
  return withTenantContext(client, scope, work);
}

/**
 * DECLARED EXEMPTION 2 of 2 — the pre-identity lookup.
 *
 * The only caller of `withIdentityContext`. It sets the identity pair and
 * NEITHER tenancy GUC, so `User_identity_bootstrap` is the only policy that can
 * match and every other table stays deny-by-default for the duration. Its blast
 * radius is one row: the `User` whose external identifier the token verifier
 * has already proved by signature.
 *
 * `IdentityScope` is not a partial `TenantScope`, which is what stops this
 * predicate being reachable from an ordinary request — see the types in
 * `packages/database/src/client.ts`.
 */
export async function runInIdentityScope<T>(
  client: MetrikaPrismaClient,
  identity: IdentityScope,
  work: Work<T>,
): Promise<T> {
  return withIdentityContext(client, identity, work);
}
