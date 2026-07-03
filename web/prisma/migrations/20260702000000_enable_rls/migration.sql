-- ═══════════════════════════════════════════════════════════════════════════
-- Row Level Security (RLS) — tenant isolation by clubId
-- ═══════════════════════════════════════════════════════════════════════════
-- Design (see web/rls/README.md for the full doc):
--   • The tenant is carried in a transaction-local GUC:  app.club_id
--     set via  SELECT set_config('app.club_id', $1, TRUE)  by lib/tenantPrisma.ts.
--   • Tables are NOT forced (no FORCE ROW LEVEL SECURITY): the table OWNER
--     (postgres — the role Prisma migrations and the system client use)
--     bypasses RLS, so migrations, webhooks, auth and cross-club system jobs
--     keep working unchanged.
--   • Enforcement happens for the dedicated app role `athletix_app`
--     (LOGIN, NOBYPASSRLS, non-owner — created by web/rls/setup-app-role.sql),
--     which the request-scoped Prisma client connects as (APP_DATABASE_URL).
--   • Every policy is FOR ALL with both USING and WITH CHECK, so SELECT,
--     INSERT, UPDATE (old and new row) and DELETE are all constrained.
--   • When app.club_id is unset the helper returns NULL and every policy
--     evaluates to NULL → no rows visible, no rows writable. Fail closed.
--
-- This migration is idempotent (DROP POLICY IF EXISTS before CREATE) and
-- purely additive — no data is modified and no schema objects are altered
-- other than enabling RLS.

-- ── Helper ───────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.current_club_id() RETURNS text
LANGUAGE sql STABLE
AS $fn$
  SELECT NULLIF(current_setting('app.club_id', true), '')
$fn$;

COMMENT ON FUNCTION app.current_club_id() IS
  'Tenant id for RLS policies. Transaction-local; set by the app via set_config(''app.club_id'', <clubId>, true). NULL/empty = no tenant = no access.';

-- ── clubs (the tenant root: id IS the tenant key) ───────────────────────────
ALTER TABLE "clubs" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "clubs";
CREATE POLICY tenant_isolation ON "clubs"
  FOR ALL
  USING ("id" = app.current_club_id())
  WITH CHECK ("id" = app.current_club_id());

-- ── Tables with a direct NOT NULL clubId column (51) ─────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'plaid_connections',
    'pending_approvals',
    'locations',
    'users',
    'staff_documents',
    'members',
    'member_migration_events',
    'member_relationships',
    'guardians',
    'memberships',
    'custom_fields',
    'club_event_types',
    'events',
    'event_expense_items',
    'event_registrations',
    'event_bundles',
    'messages',
    'announcements',
    'announcement_engagements',
    'transactions',
    'campaigns',
    'campaign_attributions',
    'documents',
    'uploaded_files',
    'expenses',
    'donations',
    'message_groups',
    'group_message_receipts',
    'club_profiles',
    'legal_entities',
    'donation_links',
    'discounts',
    'products',
    'product_sales',
    'staff_availability',
    'staff_availability_exceptions',
    'event_staff_assignments',
    'private_lesson_types',
    'private_packages',
    'private_credit_ledger',
    'private_bookings',
    'private_booking_partners',
    'private_lesson_pay_rates',
    'staff_compensations',
    'contractors',
    'contractor_payments',
    'payouts',
    'recurring_classes',
    'class_sessions',
    'attendance_records',
    'email_opt_outs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL '
      || 'USING ("clubId" = app.current_club_id()) '
      || 'WITH CHECK ("clubId" = app.current_club_id())',
      t
    );
  END LOOP;
END $$;

-- ── Child tables without a clubId column — scoped through their parent ──────
-- The EXISTS subqueries hit the parent''s primary key / an indexed FK, and the
-- parent table''s own RLS also applies inside the subquery (same GUC), which
-- is what makes these transitively club-scoped.

-- staff_profiles → users(userId)
ALTER TABLE "staff_profiles" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "staff_profiles";
CREATE POLICY tenant_isolation ON "staff_profiles"
  FOR ALL
  USING (EXISTS (SELECT 1 FROM "users" u WHERE u."id" = "staff_profiles"."userId" AND u."clubId" = app.current_club_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM "users" u WHERE u."id" = "staff_profiles"."userId" AND u."clubId" = app.current_club_id()));

-- member_subscriptions → members(memberId)
ALTER TABLE "member_subscriptions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "member_subscriptions";
CREATE POLICY tenant_isolation ON "member_subscriptions"
  FOR ALL
  USING (EXISTS (SELECT 1 FROM "members" m WHERE m."id" = "member_subscriptions"."memberId" AND m."clubId" = app.current_club_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM "members" m WHERE m."id" = "member_subscriptions"."memberId" AND m."clubId" = app.current_club_id()));

-- member_guardian_users → members(memberId)
ALTER TABLE "member_guardian_users" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "member_guardian_users";
CREATE POLICY tenant_isolation ON "member_guardian_users"
  FOR ALL
  USING (EXISTS (SELECT 1 FROM "members" m WHERE m."id" = "member_guardian_users"."memberId" AND m."clubId" = app.current_club_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM "members" m WHERE m."id" = "member_guardian_users"."memberId" AND m."clubId" = app.current_club_id()));

-- event_sessions → events(eventId)
ALTER TABLE "event_sessions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "event_sessions";
CREATE POLICY tenant_isolation ON "event_sessions"
  FOR ALL
  USING (EXISTS (SELECT 1 FROM "events" e WHERE e."id" = "event_sessions"."eventId" AND e."clubId" = app.current_club_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM "events" e WHERE e."id" = "event_sessions"."eventId" AND e."clubId" = app.current_club_id()));

-- event_bundle_items → event_bundles(bundleId)
ALTER TABLE "event_bundle_items" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "event_bundle_items";
CREATE POLICY tenant_isolation ON "event_bundle_items"
  FOR ALL
  USING (EXISTS (SELECT 1 FROM "event_bundles" b WHERE b."id" = "event_bundle_items"."bundleId" AND b."clubId" = app.current_club_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM "event_bundles" b WHERE b."id" = "event_bundle_items"."bundleId" AND b."clubId" = app.current_club_id()));

-- bookings → events(eventId)  (memberId is transitively same-club: creating a
-- booking that points at another club''s member would still require reading
-- that member, which member policies block in the API; the event anchor is
-- what makes the ROW itself tenant-scoped)
ALTER TABLE "bookings" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "bookings";
CREATE POLICY tenant_isolation ON "bookings"
  FOR ALL
  USING (EXISTS (SELECT 1 FROM "events" e WHERE e."id" = "bookings"."eventId" AND e."clubId" = app.current_club_id()))
  WITH CHECK (
    EXISTS (SELECT 1 FROM "events"  e WHERE e."id" = "bookings"."eventId"  AND e."clubId" = app.current_club_id())
    AND EXISTS (SELECT 1 FROM "members" m WHERE m."id" = "bookings"."memberId" AND m."clubId" = app.current_club_id())
  );

-- message_group_members → message_groups(groupId)
ALTER TABLE "message_group_members" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "message_group_members";
CREATE POLICY tenant_isolation ON "message_group_members"
  FOR ALL
  USING (EXISTS (SELECT 1 FROM "message_groups" g WHERE g."id" = "message_group_members"."groupId" AND g."clubId" = app.current_club_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM "message_groups" g WHERE g."id" = "message_group_members"."groupId" AND g."clubId" = app.current_club_id()));

-- group_messages → message_groups(groupId)
ALTER TABLE "group_messages" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "group_messages";
CREATE POLICY tenant_isolation ON "group_messages"
  FOR ALL
  USING (EXISTS (SELECT 1 FROM "message_groups" g WHERE g."id" = "group_messages"."groupId" AND g."clubId" = app.current_club_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM "message_groups" g WHERE g."id" = "group_messages"."groupId" AND g."clubId" = app.current_club_id()));

-- document_signatures → documents(documentId)
ALTER TABLE "document_signatures" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "document_signatures";
CREATE POLICY tenant_isolation ON "document_signatures"
  FOR ALL
  USING (EXISTS (SELECT 1 FROM "documents" d WHERE d."id" = "document_signatures"."documentId" AND d."clubId" = app.current_club_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM "documents" d WHERE d."id" = "document_signatures"."documentId" AND d."clubId" = app.current_club_id()));

-- compensation_bonuses → staff_compensations(compensationId)
ALTER TABLE "compensation_bonuses" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "compensation_bonuses";
CREATE POLICY tenant_isolation ON "compensation_bonuses"
  FOR ALL
  USING (EXISTS (SELECT 1 FROM "staff_compensations" c WHERE c."id" = "compensation_bonuses"."compensationId" AND c."clubId" = app.current_club_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM "staff_compensations" c WHERE c."id" = "compensation_bonuses"."compensationId" AND c."clubId" = app.current_club_id()));

-- compensation_assignments → staff_compensations(compensationId)
ALTER TABLE "compensation_assignments" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "compensation_assignments";
CREATE POLICY tenant_isolation ON "compensation_assignments"
  FOR ALL
  USING (EXISTS (SELECT 1 FROM "staff_compensations" c WHERE c."id" = "compensation_assignments"."compensationId" AND c."clubId" = app.current_club_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM "staff_compensations" c WHERE c."id" = "compensation_assignments"."compensationId" AND c."clubId" = app.current_club_id()));

-- ── Special cases ────────────────────────────────────────────────────────────

-- legal_acceptances: clubId is NULLABLE (platform-level acceptances). Scope
-- through the owning user instead, which is always club-bound.
ALTER TABLE "legal_acceptances" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "legal_acceptances";
CREATE POLICY tenant_isolation ON "legal_acceptances"
  FOR ALL
  USING (EXISTS (SELECT 1 FROM "users" u WHERE u."id" = "legal_acceptances"."userId" AND u."clubId" = app.current_club_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM "users" u WHERE u."id" = "legal_acceptances"."userId" AND u."clubId" = app.current_club_id()));

-- stripe_webhook_events: platform/system data (raw Stripe payloads, possibly
-- clubId NULL, written before club resolution). RLS ON with NO policy =
-- deny-all for the app role. Only the system client (table owner) touches it.
ALTER TABLE "stripe_webhook_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "stripe_webhook_events";
