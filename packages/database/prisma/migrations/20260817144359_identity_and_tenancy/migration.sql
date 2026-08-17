-- CreateEnum
CREATE TYPE "OrganizationKind" AS ENUM ('PERSONAL', 'TEAM');

-- CreateEnum
CREATE TYPE "OrganizationRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'BILLING');

-- CreateEnum
CREATE TYPE "CurrencyCode" AS ENUM ('COP', 'USD', 'EUR', 'MXN');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "authProvider" TEXT NOT NULL,
    "externalAuthId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'es-CO',
    "timezone" TEXT,
    "deletedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" UUID NOT NULL,
    "kind" "OrganizationKind" NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "countryCode" CHAR(2) NOT NULL,
    "defaultCurrency" "CurrencyCode" NOT NULL,
    "taxIdentifier" TEXT,
    "personalOwnerUserId" UUID,
    "deletedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationMember" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "OrganizationRole" NOT NULL,
    "invitedById" UUID,
    "joinedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OrganizationMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_authProvider_externalAuthId_key" ON "User"("authProvider", "externalAuthId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_personalOwnerUserId_key" ON "Organization"("personalOwnerUserId");

-- CreateIndex
CREATE INDEX "OrganizationMember_userId_idx" ON "OrganizationMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMember_organizationId_userId_key" ON "OrganizationMember"("organizationId", "userId");

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_personalOwnerUserId_fkey" FOREIGN KEY ("personalOwnerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Everything below this line is hand-written and is NOT derived from
-- schema.prisma. `prisma migrate dev` will not regenerate it, and Prisma's DSL
-- cannot express any of it. See docs/adr/0040-tenant-context-gucs.md.
--
-- MEASURED, so the next author does not have to wonder: with this migration
-- applied, `pnpm db:migrate --create-only` emits `-- This is an empty migration.`
-- Prisma does not diff CHECK constraints, RLS policies or SQL functions, so
-- nothing below is proposed for reversal by future authoring. An INDEX would be
-- different — that is a construct Prisma does manage — which is why the partial
-- unique indexes ADR-0040 discusses are deferred rather than written here.
-- ---------------------------------------------------------------------------

-- The other half of "at most one personal organization per user".
--
-- `Organization_personalOwnerUserId_key` is only half the invariant: Postgres
-- treats NULLs as distinct in a unique index, and nothing ties the column to
-- `kind`. So without this CHECK a PERSONAL organization created with the column
-- left NULL is accepted, and a user can hold two of them with no constraint
-- violated — "exactly one personal organization" would be an application
-- convention wearing a constraint's name.
--
-- Stated as `kind <> 'PERSONAL' OR ... IS NOT NULL` rather than as an
-- equivalence: whether a TEAM organization may carry a personal owner is a
-- separate question, and forbidding it here would make Plan 1C's "convert a
-- personal organization into a team" a constraint fight rather than an UPDATE.
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_personal_owner_required"
  CHECK ("kind" <> 'PERSONAL' OR "personalOwnerUserId" IS NOT NULL);

-- The SECOND tenancy GUC. Same shape and the same deny-by-default property as
-- `app_current_org_id()` (20260809024512_init): the `true` second argument to
-- current_setting makes a missing setting return NULL rather than raise, and
-- NULL never equals anything, so an unset context denies every row.
--
-- It exists because `/me` and the organization switcher have to answer "which
-- organizations am I in", across all of them, and
-- `USING ("organizationId" = app_current_org_id())` cannot express that —
-- `withOrganizationContext` sets exactly one organization per transaction. The
-- alternative was pulling Plan 1D's BYPASSRLS client and its mandatory-audit
-- wrapper forward into 1A so that the most ordinary read in the product could go
-- through the escape hatch.
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid
$$;

-- The THIRD tenancy primitive, and the one without which nothing else here
-- works. Every request begins by turning a verified provider `sub` into a User
-- row, and at that moment neither GUC above has a value — the user id is
-- precisely what the lookup exists to compute. `metrika_app` is NOBYPASSRLS
-- (sql/00-app-role.sql), an unset GUC is NULL, and NULL never equals anything,
-- so a User policy keyed only on those two returns zero rows for every
-- RETURNING user: every sign-in after the first falls into the provisioning
-- path and violates User_authProvider_externalAuthId_key.
--
-- These two are set ONLY by the identity-bootstrap entry point (Plan 1A Task 4),
-- in a transaction that sets neither GUC above and does nothing but this one
-- lookup — so the widened predicate cannot leak into any other read.
--
-- `text`, not an enum type. The policy below compares "authProvider" against
-- this directly; against a Postgres enum the comparison would need a cast on
-- one side or the other, and casting the FUNCTION result raises 22P02 for any
-- value outside the type — which converts deny-by-default into a 500 on the hot
-- path of every request. See the column comment in schema.prisma.
CREATE OR REPLACE FUNCTION app_current_auth_provider() RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_auth_provider', true), '')
$$;

CREATE OR REPLACE FUNCTION app_current_external_auth_id() RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_external_auth_id', true), '')
$$;

-- FORCE on all three, for the reason spelled out in 20260809024512_init: ENABLE
-- alone exempts the table OWNER, which is the role `prisma migrate` runs as and
-- the role a local psql session connects as, so without FORCE these policies are
-- invisible to exactly the connection a developer uses to convince themselves
-- RLS works. The local compose `metrika` role is additionally a bootstrap
-- superuser and bypasses RLS regardless of FORCE, so the catalog bit
-- `pg_class.relforcerowsecurity` — not a psql probe against the local stack — is
-- the trustworthy check.

-- One consequence of the two asymmetric policies below, written here because it
-- follows from neither predicate on its own: DELETE is filtered by USING and has
-- no WITH CHECK half, so THE WIDENED READ ALSO WIDENS DELETE. A caller who can
-- see another organization's row through membership can, as far as RLS is
-- concerned, delete it. Two things make that unreachable today and NEITHER OF
-- THEM IS THE POLICY: the soft-delete extension refuses delete/deleteMany on both
-- models, and OrganizationMember's ON DELETE RESTRICT foreign keys block deleting
-- any User or Organization that has a membership row — which is every row
-- provisioning creates. A future soft-deletable model with no membership child
-- inherits the gap. ADR-0040 records the restrictive-policy option and why 1C,
-- not 1A, is where it gets decided.

-- ASYMMETRIC, and for a reason the organization switcher makes concrete in 1C.
-- The READ half is widened to any organization the caller is a member of,
-- because /me's MembershipSummary renders names and slugs rather than ids: a
-- caller scoped to org A who can see their OrganizationMember row for org B but
-- cannot read org B's Organization row has a switcher with a blank entry in it.
-- Deciding it here rather than in 1C is deliberate — by then ADR-0040 is
-- immutable, and a wrong predicate is corrected by ALTER POLICY or by a second
-- named policy rather than by dropping and recreating, so the correction would
-- land on a predicate three slices of code already assume.
--
-- The WRITE half stays narrow: membership does not imply write access to the
-- tenant row, and a caller scoped to one organization must not be able to modify
-- another.
ALTER TABLE "Organization" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Organization" FORCE ROW LEVEL SECURITY;
CREATE POLICY "Organization_tenant_isolation" ON "Organization"
  USING (
    "id" = app_current_org_id()
    OR EXISTS (
      SELECT 1 FROM "OrganizationMember" m
      WHERE m."organizationId" = "Organization"."id" AND m."userId" = app_current_user_id()
    )
  )
  WITH CHECK ("id" = app_current_org_id());

-- ASYMMETRIC ON PURPOSE, the same way and for the same reason. The USING half is
-- what lets /me list a caller's memberships across every organization without an
-- elevated client. The WITH CHECK half is NOT widened:
-- `"userId" = app_current_user_id()` on the write side would let a caller scoped
-- to one organization plant a membership row in another.
--
-- THIS POLICY NAMES NO OTHER TABLE, AND IT MUST STAY THAT WAY. The two policies
-- above and below both read this table, so a policy here that reads "User" or
-- "Organization" closes a cycle, and Postgres answers a cycle with
-- `42P17 infinite recursion detected in policy for relation` at QUERY time — not
-- at CREATE POLICY time, and not during any migration. Whoever writes 1C's
-- membership-removal policy owns this constraint.
ALTER TABLE "OrganizationMember" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrganizationMember" FORCE ROW LEVEL SECURITY;
CREATE POLICY "OrganizationMember_tenant_isolation" ON "OrganizationMember"
  USING ("organizationId" = app_current_org_id() OR "userId" = app_current_user_id())
  WITH CHECK ("organizationId" = app_current_org_id());

-- A person belongs to many organizations, so there is no organizationId to
-- compare. Readable if you ARE them, or if they are a member of the organization
-- currently in context. The subquery is in the hot path of every user read; the
-- alternative is no RLS on "User" at all, which ROADMAP 1.6 forbids.
--
-- Note what the subquery composes with: the OrganizationMember rows it can see
-- are themselves filtered by the policy above, so this widening is bounded by
-- that one and cannot outgrow it. With the organization GUC unset, the EXISTS
-- branch is dead and only the caller's own row is readable.
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "User" FORCE ROW LEVEL SECURITY;
CREATE POLICY "User_tenant_isolation" ON "User"
  USING (
    "id" = app_current_user_id()
    OR EXISTS (
      SELECT 1 FROM "OrganizationMember" m
      WHERE m."userId" = "User"."id" AND m."organizationId" = app_current_org_id()
    )
  )
  WITH CHECK ("id" = app_current_user_id());

-- The pre-identity read, as a SECOND named policy rather than a fourth branch of
-- the one above. Permissive policies OR together, so this widens the read path
-- and nothing else — and separating them is what makes the widening auditable:
-- it has its own name in pg_policies, its own FOR SELECT, and it can be retired
-- on its own the day an elevated client makes it unnecessary.
--
-- FOR SELECT, so it has no WITH CHECK at all: a bootstrap lookup must never be
-- able to write. That is also why the catalog coverage gate keys its with_check
-- assertion on pg_policies.cmd rather than asserting non-null everywhere — a
-- read-only policy with a NULL with_check is correct, not a hole.
--
-- Both halves are ANDed, so an unset context matches nothing, and a caller who
-- sets only one of the two matches nothing either. The blast radius is exactly
-- one row: the User whose external identifier the token verifier already proved.
CREATE POLICY "User_identity_bootstrap" ON "User"
  FOR SELECT
  USING (
    "authProvider" = app_current_auth_provider()
    AND "externalAuthId" = app_current_external_auth_id()
  );
