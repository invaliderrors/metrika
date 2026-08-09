-- CreateTable
CREATE TABLE "HealthCheck" (
    "id" UUID NOT NULL,
    "checkedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HealthCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RlsProbe" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RlsProbe_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RlsProbe_organizationId_createdAt_idx" ON "RlsProbe"("organizationId", "createdAt" DESC);

-- Tenant context, read by every policy. STABLE (not IMMUTABLE) because it
-- reads a session setting. The `true` second argument to current_setting makes
-- a missing setting return NULL instead of raising, so an unset context denies
-- every row rather than erroring — deny-by-default.
CREATE OR REPLACE FUNCTION app_current_org_id() RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid
$$;

ALTER TABLE "RlsProbe" ENABLE ROW LEVEL SECURITY;

-- FORCE is not optional. ENABLE alone exempts the table OWNER, and the owner
-- is the role `prisma migrate` and any psql session connect as locally. Without
-- FORCE the policy below is invisible to exactly the connection a developer
-- uses to convince themselves RLS works.
ALTER TABLE "RlsProbe" FORCE ROW LEVEL SECURITY;

-- WITH CHECK as well as USING: USING filters what a statement can SEE, WITH
-- CHECK constrains what it can WRITE. Without it, a caller in org A can INSERT
-- a row stamped with org B's id and then never see it again.
CREATE POLICY "RlsProbe_tenant_isolation" ON "RlsProbe"
  USING ("organizationId" = app_current_org_id())
  WITH CHECK ("organizationId" = app_current_org_id());
