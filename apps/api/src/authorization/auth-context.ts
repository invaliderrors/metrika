// Who is asking, resolved from OUR database rather than from a token.
//
// Created in Task 4 rather than Task 5 because `tenant-context.ts` is typed
// against it — `runInTenant(auth, fn)` is the only entry point an ordinary
// request can reach, and it derives the scope from this shape. Task 5 fills in
// the members; this file exists so the signature that enforces the rule can be
// written before the guard that populates it.
//
// NOT IN `packages/contracts`, and that is a declared deviation from
// `docs/ROADMAP.md:282`, which lists `AuthContext` and `PolicyResult` under
// Phase 1's Contracts. Neither is a wire type: this is what a guard hands a
// repository, and every export of `packages/contracts` is a candidate for the
// pydantic codegen — so putting it there would push `OrganizationRole`
// semantics into a shape `apps/workers` inherits for no reason. The vocabulary
// both are typed against stays in contracts (`OrganizationRole`,
// `PlatformRole`, `OrganizationKind`, the branded ids). ADR-0039 records it;
// Task 9 corrects the roadmap line.
//
// ADR-0013 decision 2 is "there is no method signature that permits forgetting
// who is asking". The two calls in this slice that genuinely run before there
// is anyone to ask about — identity resolution and first-login provisioning —
// do not take one, and they are named in ADR-0040 as the complete list of
// exemptions. Growing that list is an ADR change, not a judgement call.

import type { OrganizationId, UserId } from '@metrika/contracts';

/**
 * Populated by Task 5's guard.
 *
 * These two members are here rather than in Task 5 because `runInTenant`
 * derives the tenant scope from them, so the interface cannot be empty and
 * still compile. Task 5 ADDS `organizationRole` when there is a guard to read
 * it from the database.
 *
 * `platformRoles` is deliberately absent and stays absent through 1A.
 * `PlatformRoleAssignment` lands in 1D with the elevated client it authorises,
 * and a hardcoded `[]` in the meantime would make this slice's own "no role is
 * ever read from a JWT claim" clause unfalsifiable for the platform half — the
 * field would look supportable with no table behind it.
 *
 * `organizationId` is a CLAIM THAT HAS BEEN VERIFIED, not a value copied from a
 * request. ADR-0040 consequence 10: RLS compares `app.current_org_id` without
 * checking membership, so whatever populates this field owes the membership
 * lookup. That obligation is on Task 5's factory, and `runInTenant` is where it
 * becomes load-bearing.
 */
export interface AuthContext {
  readonly userId: UserId;
  readonly organizationId: OrganizationId;
}
