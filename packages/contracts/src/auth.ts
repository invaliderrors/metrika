import { z } from 'zod';
import { OrganizationId, UserId } from './ids.js';
import { OrganizationKind, OrganizationRole } from './organization.js';

/**
 * What `GET /api/v1/me` answers: who the caller is, and which organizations they
 * are in.
 *
 * THE TWO SCHEMAS `TS_ONLY` EXISTS FOR, and the first in this package that
 * cannot cross into Python. `MeResponse.memberships` is an array and
 * `MeResponse.timezone` is `.optional()`; `test/json-schema.test.ts` rejects
 * both by name, because `z.toJSONSchema()` drops `.optional()`'s meaning
 * silently and pydantic reads an optional field as nullable where Zod does not.
 * Those rejections are correct for anything a worker sees — and `apps/workers`
 * holds no database credentials, never sees a user, and has no use for a `/me`
 * response at all. So the schemas are declared TypeScript-only in
 * `src/json-schema.ts`'s `TS_ONLY` table rather than the allowlist being widened
 * for them. See ADR-0039 for the two answers that were rejected.
 *
 * `AuthContext` AND `PolicyResult` ARE NOT HERE, and their absence is the
 * decision rather than an oversight. `docs/ROADMAP.md:282` lists both under
 * Phase 1's contracts; ADR-0039 moves them to
 * `apps/api/src/authorization/auth-context.ts` and `policy-result.ts`. Neither
 * is a wire type — one is what a guard hands a repository, the other is what a
 * policy returns — and every export of this package is a candidate for the
 * pydantic codegen. What stays here is the vocabulary both are typed against:
 * `OrganizationRole`, `PlatformRole`, `OrganizationKind` and the branded IDs.
 */

/**
 * One organization the caller belongs to, as the organization switcher renders
 * it.
 *
 * `name` and `slug` rather than an id alone, because the switcher shows words:
 * a caller who can see their `OrganizationMember` row for an organization but
 * cannot read that organization's row has a switcher with a blank entry in it.
 * That is why Plan 1A's `Organization` RLS policy is asymmetric — the read half
 * is widened to any organization the caller is a member of while the write half
 * stays scoped to the active one.
 *
 * `role` is the caller's OWN role, not the organization's roster. `/me` answers
 * "what may I do here"; who else is a member is a different endpoint with a
 * different policy.
 */
export const MembershipSummary = z.object({
  organizationId: OrganizationId,
  name: z.string(),
  slug: z.string(),
  kind: OrganizationKind,
  role: OrganizationRole,
});
export type MembershipSummary = z.infer<typeof MembershipSummary>;

/**
 * The caller, as the caller.
 *
 * `email` is a PLAIN `z.string()`, deliberately not `z.email()`. Two reasons and
 * both are measured. The allowlist rejects every built-in string format, because
 * they are not uniform — `z.email()` emits a `pattern` beside its `format` while
 * `z.url()` emits a bare `format` with none — and ADR-0027 measured that a
 * schema carrying `format: email` generates `EmailStr`, which import-fails
 * without the optional `email-validator` package while `datamodel-codegen`,
 * `ruff check`, `ruff format --check` and `mypy --strict` all exit 0. This
 * schema never reaches the generator, so only the first reason binds today; the
 * second is why it must not be "fixed" by promoting the field. The value arrives
 * from a token Clerk has already verified, so address-shaped validation here
 * would re-check something upstream owns.
 *
 * `email` is also NOT in `RedactedFieldName`, and ADR-0039 records that as a
 * decision with its trigger: nothing writes an email into any of the four log
 * sinks or into a span attribute today, and redaction is field-granular and
 * shared, so adding the name censors the value in all of them at once.
 *
 * `timezone` is optional because a user who has never opened the browser has
 * none; `locale` is absent because `apps/web` serves `es-CO` unconditionally and
 * a field nothing reads is a field that goes stale.
 */
export const MeResponse = z.object({
  userId: UserId,
  email: z.string(),
  displayName: z.string(),
  timezone: z.string().optional(),
  memberships: z.array(MembershipSummary),
});
export type MeResponse = z.infer<typeof MeResponse>;
