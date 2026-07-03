-- ═══════════════════════════════════════════════════════════════════════════
-- One-time per environment: create the RLS-enforced application role.
-- Run as the migration role (postgres) — Supabase SQL editor or psql.
-- This is deliberately NOT a Prisma migration: roles are cluster-level and
-- carry a password that must not live in the repo.
-- ═══════════════════════════════════════════════════════════════════════════
-- Usage (psql):
--   psql "$DIRECT_URL" -v app_password='CHOOSE-A-STRONG-PASSWORD' -f web/rls/setup-app-role.sql
-- In the Supabase SQL editor, replace :'app_password' by hand.

-- The role RLS is enforced against: LOGIN, cannot bypass RLS, owns nothing.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athletix_app') THEN
    EXECUTE format(
      'CREATE ROLE athletix_app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
      current_setting('app.setup_password', true)
    );
  END IF;
END $$;
-- If the DO-block/current_setting dance is awkward in your client, just run:
--   CREATE ROLE athletix_app LOGIN PASSWORD '...' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;

ALTER ROLE athletix_app SET statement_timeout = '30s';

-- Table access. RLS (enabled by migration 20260702000000_enable_rls) is what
-- constrains WHICH rows; these grants only allow the operations themselves.
GRANT USAGE ON SCHEMA public TO athletix_app;
GRANT USAGE ON SCHEMA app    TO athletix_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO athletix_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO athletix_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO athletix_app;

-- Never let the app role touch migration bookkeeping or raw webhook payloads.
REVOKE ALL ON TABLE "_prisma_migrations" FROM athletix_app;
-- (stripe_webhook_events keeps its grant but has RLS-with-no-policy = deny-all.)

-- Future tables created by the migration role automatically get CRUD grants.
-- ⚠ Grants ≠ RLS: every NEW tenant table must also get an RLS policy in its
-- own migration. The harness's completeness check (test 0) catches misses.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO athletix_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO athletix_app;

-- ── Connection string (Netlify env var APP_DATABASE_URL) ────────────────────
-- Supabase pooler (transaction mode) — username is role.projectref:
--   postgresql://athletix_app.vhiqdtwxthmdqqizukab:<PASSWORD>@<pooler-host>:6543/postgres?pgbouncer=true
-- Transaction-pooling is safe here because lib/tenantPrisma.ts only ever sets
-- the tenant GUC with set_config(..., true) → transaction-local, never session.
