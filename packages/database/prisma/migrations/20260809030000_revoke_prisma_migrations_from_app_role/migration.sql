-- sql/00-app-role.sql's `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ...
-- ON TABLES TO metrika_app` applies to every table the owner role (metrika)
-- creates afterwards, with no way to exclude one table from SQL at the point
-- that statement runs. Prisma's own `_prisma_migrations` tracking table is
-- created by that same owner role, before any migration file executes, so it
-- inherited SELECT/INSERT/UPDATE/DELETE for metrika_app exactly like a real
-- domain table would. That means the application role — the one an
-- accepted-quote-reconstruction bug or a compromised API process would be
-- running as — could rewrite its own migration history, undermining the
-- reproducibility guarantee this whole schema exists to protect.
--
-- This cannot be fixed in sql/00-app-role.sql itself: that file runs at
-- container init, via docker-entrypoint-initdb.d, strictly before
-- `prisma migrate deploy` ever runs, so `_prisma_migrations` does not exist
-- yet when it executes — a REVOKE there would fail with
-- "relation \"_prisma_migrations\" does not exist". It has to run as a
-- migration: by the time the migrate engine applies ANY migration.sql
-- (including the very first one), it has already created
-- `_prisma_migrations` for its own bookkeeping, so the table is guaranteed to
-- exist here.
--
-- The role is NOT guaranteed to exist, though, and this statement is not
-- allowed to assume it does. `REVOKE ... FROM metrika_app` against a role
-- that has never been created raises 42704 "role \"metrika_app\" does not
-- exist" — fatal under `migrate deploy`, and the retry is worse: Prisma
-- records this migration as failed/unfinished in `_prisma_migrations`, so
-- every subsequent `migrate deploy` refuses with P3009 until someone runs
-- `prisma migrate resolve` by hand. Both the harness and `docker-compose`
-- create the role at initdb before any migration ever runs, so this branch
-- is unreachable through either of this repo's two committed paths today —
-- but a migration is forever, and the first place an unguarded REVOKE would
-- actually fire for real is Plan 0D's Terraform-provisioned production
-- database, where "someone runs migrate resolve by hand" means a human
-- doing manual recovery against production during a deploy.
--
-- Guarding it means a database where metrika_app is created AFTER this
-- migration already ran keeps the grants this statement exists to remove —
-- a silent no-op, not a loud one. That is judged acceptable, not just
-- convenient: `ALTER DEFAULT PRIVILEGES ... GRANT ... TO metrika_app` (the
-- statement in sql/00-app-role.sql that creates the hole this migration
-- closes) is itself local/test-only — 00-app-role.sql's own header says it
-- "is never applied there [production]". A role created later in production
-- was never a target of that default-privileges rule in the first place, so
-- it never inherits the grants this REVOKE removes, and there is nothing
-- for the no-op to be silently failing to fix. Do not "tighten" this back to
-- an unconditional REVOKE without re-deriving that production invariant.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metrika_app') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE "_prisma_migrations" FROM metrika_app';
  END IF;
END $$;
