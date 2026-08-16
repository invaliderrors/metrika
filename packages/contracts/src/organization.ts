import { z } from 'zod';

/**
 * The tenancy vocabulary: what an organization IS, what a person may be inside
 * one, and what an internal staff account may be across all of them.
 *
 * MEMBER ORDER IS COPIED VERBATIM from `docs/DOMAIN_MODEL.md` lines 62, 64 and
 * 68 — not sorted, not grouped by privilege. All three enums are in `EMITTED`,
 * so this order IS the member order of the generated pydantic `StrEnum`, and
 * CI's `contracts` job byte-diffs `apps/workers`' committed models. Reordering a
 * member here is a diff there, and keeping the declaration order is the cheapest
 * way to make the generated file reviewable against the document that defines
 * it.
 *
 * `z.enum` rather than `z.union([z.literal('OWNER'), …])`, and the difference is
 * not stylistic: `def.type` is `enum`, which the allowlist in
 * `test/json-schema.test.ts` admits as a leaf, and `datamodel-codegen` writes
 * one `StrEnum` class per `$defs` entry with `member.name == member.value`. A
 * union of literals is a `union` node the same allowlist rejects by name, so it
 * would not cross at all.
 *
 * NONE OF THESE IS A RANK. Nothing here puts `OWNER` above `ADMIN`;
 * `docs/ARCHITECTURE.md:747` checks set membership (`hasRole(subject, ['OWNER',
 * 'ADMIN', …])`), never an ordering. A policy that needs one has to declare it,
 * because deriving a privilege ordering from enum position is exactly the
 * implicit rule this repository's authorization design refuses.
 */

/**
 * Whether an organization is the one a person is given at signup or one they
 * built to work with other people.
 *
 * The NAME is coined here: `docs/DOMAIN_MODEL.md:62` declares the members as an
 * inline field type (`kind: PERSONAL | TEAM`) and never names the type. The
 * members are quoted; the identifier is new, and follows `CurrencyCode` /
 * `VersionStatus`.
 *
 * `PERSONAL` exists so that "a resource with no organization" is not a branch
 * any policy or query has to carry — every user has one from the moment they
 * sign up. Do not confuse this `kind` with `subject.kind` in
 * `docs/ARCHITECTURE.md:745`, which is an `AuthContext` discriminator carrying
 * `'PLATFORM_ADMIN'`. Two different `kind`s, one document.
 */
export const OrganizationKind = z.enum(['PERSONAL', 'TEAM']);
export type OrganizationKind = z.infer<typeof OrganizationKind>;

/**
 * What a person is inside ONE organization — `OrganizationMember.role`.
 *
 * Read from our database on every request, never from a token claim — ADR-0012
 * decided that before Clerk was installed, and ADR-0038 measured that the claim
 * exists in two mutually exclusive versioned shapes, so "ignore it" is the only
 * answer that is complete. This is vocabulary here and authority nowhere.
 */
export const OrganizationRole = z.enum(['OWNER', 'ADMIN', 'MEMBER', 'BILLING']);
export type OrganizationRole = z.infer<typeof OrganizationRole>;

/**
 * What an internal staff account is across every organization —
 * `PlatformRoleAssignment.role`.
 *
 * SHIPS IN PLAN 1A WITH NO TABLE BEHIND IT, on purpose. `PlatformRoleAssignment`
 * lands in 1D alongside the elevated client it authorises, and 1A's migration
 * creates the Prisma enums for the other two only — a Postgres enum type with no
 * column is a schema object nothing can be wrong about. This one is here because
 * it is vocabulary rather than storage, it costs one leaf entry in `EMITTED`,
 * and opening `packages/contracts` as few times as possible is that slice's
 * stated discipline.
 *
 * A SEPARATE UNION from `OrganizationRole` rather than a wider one, mirroring
 * the separate table (`docs/DOMAIN_MODEL.md:68`): an internal staff account must
 * be impossible to confuse with a customer membership, and impossible to grant
 * by accident through the org-membership code path. A single merged enum would
 * make `role: 'PLATFORM_ADMIN'` type-check on an `OrganizationMember`.
 */
export const PlatformRole = z.enum([
  'PLATFORM_ADMIN',
  'OPERATIONS',
  'MANUFACTURING_OPERATOR',
  'FINANCE',
  'SUPPORT',
]);
export type PlatformRole = z.infer<typeof PlatformRole>;
