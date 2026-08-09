-- Local and TEST bootstrap only. Production roles are created by Terraform
-- (Plan 0D) with a password from Secrets Manager; this file is never applied
-- there, which is why a fixed development password here is acceptable.
--
-- Executed from two places, deliberately, so local and CI cannot diverge:
--   * docker-entrypoint-initdb.d, mounted by infra/docker/docker-compose.yml
--   * packages/testing's withDatabase(), against the Testcontainers instance
--
-- The application role MUST NOT be a superuser and MUST NOT have BYPASSRLS.
-- A superuser ignores every row-level security policy, FORCE included, which
-- makes RLS look enabled while doing nothing at all. This is the single most
-- likely way for the tenant-isolation backstop to be silently absent.
-- packages/database/test/rls.integration.test.ts (Task 8, not yet written)
-- WILL assert both attributes are false rather than trusting this file; until
-- it lands, nothing in the repository verifies this automatically.
--
-- ALTER DEFAULT PRIVILEGES with no FOR ROLE clause applies to objects created
-- by the CURRENT role. `prisma migrate` connects as the owner (metrika), which
-- is the same role that runs this file, so every table a future migration
-- creates is granted automatically. That is what removes the ordering problem:
-- this file runs at container init, long before any table exists.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metrika_app') THEN
    CREATE ROLE metrika_app
      LOGIN PASSWORD 'metrika_app'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO metrika_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO metrika_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO metrika_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO metrika_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO metrika_app;
