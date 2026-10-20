-- ═══════════════════════════════════════════════════════════════════════════
-- Accounting Phase 1 — double-entry general ledger core
-- Phase 10 of the product plan. Full design: web/docs/accounting/plan.md
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ADDITIVE ONLY. Six new tables. Nothing is renamed, dropped or altered; no
-- existing column changes type; no row is rewritten. Every existing read
-- behaves identically whether or not this has been applied.
--
-- ORDER MATTERS: apply this BEFORE deploying the code that reads these tables.
-- The new /api/financials/ledger/* routes and the two new Financials tabs are
-- the only things that touch them, so nothing currently in production breaks
-- either way — but those routes 500 until the tables exist.
--
--   cd web && npx prisma migrate deploy
--
-- NOT `migrate dev` — the shadow database is blocked by the Supabase pooler.
-- NEVER pass a production URL to --shadow-database-url.
--
-- Tables are `gl_` prefixed because `ledger` is already taken three times in
-- this schema: ledger_imports (the QuickBooks CSV import), private_credit_ledger
-- (prepaid lesson credits), and the staff "pay ledger" (pay_lines).
--
-- Money is INTEGER CENTS, deliberately unlike the numeric(10,2) used elsewhere:
-- a ledger must never see a rounding artifact, and integer cents make
-- "debits = credits" an exact integer comparison.
--
-- Idempotent throughout (IF NOT EXISTS / DROP POLICY IF EXISTS) so a partial
-- apply can be re-run safely.

-- ── 1. gl_accounts — the chart of accounts ──────────────────────────────────
CREATE TABLE IF NOT EXISTS "gl_accounts" (
  "id"              TEXT NOT NULL,
  "clubId"          TEXT NOT NULL,
  "number"          TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "type"            TEXT NOT NULL,
  "subtype"         TEXT,
  "normalBalance"   TEXT NOT NULL,
  "isContra"        BOOLEAN NOT NULL DEFAULT false,
  "parentId"        TEXT,
  "active"          BOOLEAN NOT NULL DEFAULT true,
  "isSystem"        BOOLEAN NOT NULL DEFAULT false,
  "systemKey"       TEXT,
  "description"     TEXT,
  "sortOrder"       INTEGER NOT NULL DEFAULT 0,
  "createdByUserId" TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gl_accounts_pkey" PRIMARY KEY ("id")
);

-- (clubId, number) is the identity the seed script matches on, so it must be
-- unique or a re-run could duplicate the template.
CREATE UNIQUE INDEX IF NOT EXISTS "gl_accounts_clubId_number_key" ON "gl_accounts"("clubId", "number");
-- systemKey is NULL on every ordinary account. Postgres treats NULLs as
-- distinct in a unique index, so they all coexist here while still allowing
-- exactly one STRIPE_CLEARING (etc.) per club.
CREATE UNIQUE INDEX IF NOT EXISTS "gl_accounts_clubId_systemKey_key" ON "gl_accounts"("clubId", "systemKey");
CREATE INDEX IF NOT EXISTS "gl_accounts_clubId_type_sortOrder_idx" ON "gl_accounts"("clubId", "type", "sortOrder");
CREATE INDEX IF NOT EXISTS "gl_accounts_clubId_active_idx" ON "gl_accounts"("clubId", "active");
CREATE INDEX IF NOT EXISTS "gl_accounts_parentId_idx" ON "gl_accounts"("parentId");

-- ── 2. gl_journal_entries — the entry header ────────────────────────────────
CREATE TABLE IF NOT EXISTS "gl_journal_entries" (
  "id"              TEXT NOT NULL,
  "clubId"          TEXT NOT NULL,
  "entryDate"       DATE NOT NULL,
  "memo"            TEXT,
  "legalEntityId"   TEXT,
  "sourceType"      TEXT NOT NULL DEFAULT 'MANUAL',
  "sourceId"        TEXT,
  "status"          TEXT NOT NULL DEFAULT 'POSTED',
  "reference"       TEXT,
  "isIntercompany"  BOOLEAN NOT NULL DEFAULT false,
  "reversesEntryId" TEXT,
  "voidedByEntryId" TEXT,
  "voidedAt"        TIMESTAMP(3),
  "voidReason"      TEXT,
  "voidedByUserId"  TEXT,
  "createdByUserId" TEXT,
  "postedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gl_journal_entries_pkey" PRIMARY KEY ("id")
);

-- THE POST-ONCE GUARANTEE for Phase 2's automatic posting. With sourceId NULL
-- on manual entries (NULLs distinct), manual entries never collide, but a
-- Stripe charge / payout / bank row can only ever produce one entry. This is
-- what makes "each source record posts at most once" structural instead of a
-- check somebody has to remember to write.
CREATE UNIQUE INDEX IF NOT EXISTS "gl_journal_entries_clubId_sourceType_sourceId_key"
  ON "gl_journal_entries"("clubId", "sourceType", "sourceId");
CREATE INDEX IF NOT EXISTS "gl_journal_entries_clubId_entryDate_idx" ON "gl_journal_entries"("clubId", "entryDate");
CREATE INDEX IF NOT EXISTS "gl_journal_entries_clubId_status_entryDate_idx" ON "gl_journal_entries"("clubId", "status", "entryDate");
CREATE INDEX IF NOT EXISTS "gl_journal_entries_clubId_legalEntityId_idx" ON "gl_journal_entries"("clubId", "legalEntityId");
CREATE INDEX IF NOT EXISTS "gl_journal_entries_reversesEntryId_idx" ON "gl_journal_entries"("reversesEntryId");

-- ── 3. gl_journal_lines — the debits and credits ────────────────────────────
CREATE TABLE IF NOT EXISTS "gl_journal_lines" (
  "id"            TEXT NOT NULL,
  "clubId"        TEXT NOT NULL,
  "entryId"       TEXT NOT NULL,
  "accountId"     TEXT NOT NULL,
  "debitCents"    INTEGER NOT NULL DEFAULT 0,
  "creditCents"   INTEGER NOT NULL DEFAULT 0,
  "legalEntityId" TEXT,
  "program"       TEXT,
  "memo"          TEXT,
  "memberId"      TEXT,
  "lineNumber"    INTEGER NOT NULL DEFAULT 0,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gl_journal_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "gl_journal_lines_clubId_accountId_idx" ON "gl_journal_lines"("clubId", "accountId");
CREATE INDEX IF NOT EXISTS "gl_journal_lines_entryId_lineNumber_idx" ON "gl_journal_lines"("entryId", "lineNumber");
CREATE INDEX IF NOT EXISTS "gl_journal_lines_accountId_idx" ON "gl_journal_lines"("accountId");
CREATE INDEX IF NOT EXISTS "gl_journal_lines_clubId_legalEntityId_idx" ON "gl_journal_lines"("clubId", "legalEntityId");
CREATE INDEX IF NOT EXISTS "gl_journal_lines_clubId_program_idx" ON "gl_journal_lines"("clubId", "program");

-- A line carrying BOTH a debit and a credit hides a netting decision that
-- belongs in two explicit lines, and a line carrying neither is noise. The
-- service refuses both with a readable message; this is the backstop. Negative
-- amounts are refused the same way — a negative debit is a credit, written
-- confusingly.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_journal_lines_one_side_only') THEN
    ALTER TABLE "gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_one_side_only"
      CHECK (
        "debitCents" >= 0 AND "creditCents" >= 0
        AND ("debitCents" = 0) <> ("creditCents" = 0)
      );
  END IF;
END $$;

-- ── 4. gl_entry_attachments — files on an entry ─────────────────────────────
-- fileId points at uploaded_files, exactly as receipts.fileId does. Bytes live
-- wherever lib/storage.ts puts them (Supabase Storage in production); reads go
-- through the existing club-scoped gate at /api/files/[id]. No new storage.
CREATE TABLE IF NOT EXISTS "gl_entry_attachments" (
  "id"               TEXT NOT NULL,
  "clubId"           TEXT NOT NULL,
  "entryId"          TEXT NOT NULL,
  "fileId"           TEXT NOT NULL,
  "fileName"         TEXT NOT NULL,
  "mimeType"         TEXT NOT NULL,
  "sizeBytes"        INTEGER NOT NULL,
  "uploadedByUserId" TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gl_entry_attachments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "gl_entry_attachments_clubId_entryId_idx" ON "gl_entry_attachments"("clubId", "entryId");
CREATE INDEX IF NOT EXISTS "gl_entry_attachments_fileId_idx" ON "gl_entry_attachments"("fileId");

-- ── 5. gl_lock_dates — one close date per legal entity ──────────────────────
CREATE TABLE IF NOT EXISTS "gl_lock_dates" (
  "id"              TEXT NOT NULL,
  "clubId"          TEXT NOT NULL,
  "legalEntityId"   TEXT NOT NULL,
  "lockedThrough"   DATE NOT NULL,
  "note"            TEXT,
  "updatedByUserId" TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gl_lock_dates_pkey" PRIMARY KEY ("id")
);

-- ONE per entity, as specified. A club-wide close is a row per entity.
CREATE UNIQUE INDEX IF NOT EXISTS "gl_lock_dates_clubId_legalEntityId_key" ON "gl_lock_dates"("clubId", "legalEntityId");
CREATE INDEX IF NOT EXISTS "gl_lock_dates_clubId_idx" ON "gl_lock_dates"("clubId");

-- ── 6. gl_audit_logs — append-only ──────────────────────────────────────────
-- Nothing in the codebase updates or deletes a row here. Same discipline as
-- billing_audit_logs.
CREATE TABLE IF NOT EXISTS "gl_audit_logs" (
  "id"          TEXT NOT NULL,
  "clubId"      TEXT NOT NULL,
  "objectType"  TEXT NOT NULL,
  "objectId"    TEXT NOT NULL,
  "action"      TEXT NOT NULL,
  "actorUserId" TEXT,
  "actorName"   TEXT,
  "before"      JSONB,
  "after"       JSONB,
  "note"        TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gl_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "gl_audit_logs_clubId_createdAt_idx" ON "gl_audit_logs"("clubId", "createdAt");
CREATE INDEX IF NOT EXISTS "gl_audit_logs_clubId_objectType_objectId_idx" ON "gl_audit_logs"("clubId", "objectType", "objectId");

-- ── 7. Foreign keys ─────────────────────────────────────────────────────────
-- Added after every table exists so the order of the CREATEs above doesn't
-- matter, and guarded so a re-run is a no-op.
--
-- RESTRICT, not CASCADE, on the three that matter:
--   · gl_journal_lines.accountId  — the database half of "an account with
--     postings can't be deleted". The service refuses first with a readable
--     message; this catches anything that bypasses it.
--   · *.legalEntityId — an entity that has books must not be deletable out
--     from under its own ledger history.
-- CASCADE is right for clubId (deleting a club removes its books) and for
-- entryId (an entry's lines and attachments are parts of it, not records in
-- their own right).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_accounts_clubId_fkey') THEN
    ALTER TABLE "gl_accounts" ADD CONSTRAINT "gl_accounts_clubId_fkey"
      FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_accounts_parentId_fkey') THEN
    ALTER TABLE "gl_accounts" ADD CONSTRAINT "gl_accounts_parentId_fkey"
      FOREIGN KEY ("parentId") REFERENCES "gl_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_journal_entries_clubId_fkey') THEN
    ALTER TABLE "gl_journal_entries" ADD CONSTRAINT "gl_journal_entries_clubId_fkey"
      FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_journal_entries_legalEntityId_fkey') THEN
    ALTER TABLE "gl_journal_entries" ADD CONSTRAINT "gl_journal_entries_legalEntityId_fkey"
      FOREIGN KEY ("legalEntityId") REFERENCES "legal_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_journal_lines_clubId_fkey') THEN
    ALTER TABLE "gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_clubId_fkey"
      FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_journal_lines_entryId_fkey') THEN
    ALTER TABLE "gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_entryId_fkey"
      FOREIGN KEY ("entryId") REFERENCES "gl_journal_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_journal_lines_accountId_fkey') THEN
    ALTER TABLE "gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "gl_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_journal_lines_legalEntityId_fkey') THEN
    ALTER TABLE "gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_legalEntityId_fkey"
      FOREIGN KEY ("legalEntityId") REFERENCES "legal_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_entry_attachments_clubId_fkey') THEN
    ALTER TABLE "gl_entry_attachments" ADD CONSTRAINT "gl_entry_attachments_clubId_fkey"
      FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_entry_attachments_entryId_fkey') THEN
    ALTER TABLE "gl_entry_attachments" ADD CONSTRAINT "gl_entry_attachments_entryId_fkey"
      FOREIGN KEY ("entryId") REFERENCES "gl_journal_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_lock_dates_clubId_fkey') THEN
    ALTER TABLE "gl_lock_dates" ADD CONSTRAINT "gl_lock_dates_clubId_fkey"
      FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_lock_dates_legalEntityId_fkey') THEN
    ALTER TABLE "gl_lock_dates" ADD CONSTRAINT "gl_lock_dates_legalEntityId_fkey"
      FOREIGN KEY ("legalEntityId") REFERENCES "legal_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_audit_logs_clubId_fkey') THEN
    ALTER TABLE "gl_audit_logs" ADD CONSTRAINT "gl_audit_logs_clubId_fkey"
      FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ── 8. Row Level Security ───────────────────────────────────────────────────
-- Same shape as migration 20260702000000_enable_rls: the tenant is the
-- transaction-local GUC app.club_id, set by lib/tenantPrisma.ts. Tables are NOT
-- forced, so the table owner (postgres — migrations, webhooks, cron) keeps
-- working unchanged; enforcement applies to the athletix_app role, which is
-- NOBYPASSRLS. With app.club_id unset the helper returns NULL and every policy
-- evaluates to NULL: no rows readable, no rows writable. Fail closed.
--
-- ── WHY THE CHILD TABLES CHECK MORE THAN clubId ─────────────────────────────
-- A policy of `clubId = app.current_club_id()` alone is NOT enough on a table
-- with a foreign key to another tenant table, and the two-club harness proved
-- it: club A could insert a gl_journal_lines row with its OWN clubId while
-- pointing entryId at club B's journal entry. The clubId check passes, and
-- POSTGRES FOREIGN KEY CHECKS DELIBERATELY BYPASS RLS, so nothing stopped it.
-- Because the entry detail view includes its lines by entryId, club B would
-- then render club A's line inside B's own entry — one club silently
-- unbalancing another's books.
--
-- So every FK to a tenant-owned table is verified IN THE POLICY to point at a
-- row in the SAME club. Nullable FKs allow NULL explicitly.
--
-- The condition goes in WITH CHECK (which governs INSERT and the new row of an
-- UPDATE) and NOT in USING. That split is deliberate: USING stays on clubId so
-- that if a bad row ever does exist it remains visible and therefore fixable,
-- rather than becoming invisible to the very club that needs to clean it up.
--
-- Cross-club proof: rls/harness/run-tests.ts section T9 (T9.17–T9.22 cover
-- exactly these cases).

-- A self-referencing FK cannot be checked with a plain EXISTS: the subquery
-- re-enters the very policy being evaluated and Postgres raises "infinite
-- recursion detected in policy for relation gl_accounts" (the harness caught
-- this too, on the first attempt at the fix). The standard remedy is one
-- narrowly-scoped SECURITY DEFINER lookup, which runs as the function owner and
-- so does not re-trigger RLS.
--
-- It is deliberately minimal: given an account id it returns that account's
-- clubId and nothing else. An attacker would have to already know a cuid, and
-- would learn only a club id — which they must already possess to have a
-- session at all. search_path is pinned so the function body cannot be
-- redirected at an attacker-controlled table.
CREATE OR REPLACE FUNCTION app.gl_account_club_id(account_id text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT "clubId" FROM "gl_accounts" WHERE "id" = account_id
$fn$;

COMMENT ON FUNCTION app.gl_account_club_id(text) IS
  'Owning clubId of one gl_account, for the self-referential parentId check in the gl_accounts RLS policy. SECURITY DEFINER to avoid policy recursion; returns a clubId and nothing else.';

REVOKE ALL ON FUNCTION app.gl_account_club_id(text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athletix_app') THEN
    GRANT EXECUTE ON FUNCTION app.gl_account_club_id(text) TO athletix_app;
  END IF;
END $$;

-- gl_accounts — parentId must be an account in the same club.
ALTER TABLE "gl_accounts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "gl_accounts";
CREATE POLICY tenant_isolation ON "gl_accounts" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK (
    "clubId" = app.current_club_id()
    AND ("parentId" IS NULL OR app.gl_account_club_id("parentId") = app.current_club_id())
  );

-- gl_journal_entries — legalEntityId must be an entity in the same club.
ALTER TABLE "gl_journal_entries" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "gl_journal_entries";
CREATE POLICY tenant_isolation ON "gl_journal_entries" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK (
    "clubId" = app.current_club_id()
    AND (
      "legalEntityId" IS NULL
      OR EXISTS (SELECT 1 FROM "legal_entities" e WHERE e."id" = "legalEntityId" AND e."clubId" = app.current_club_id())
    )
  );

-- gl_journal_lines — the one the harness caught. entryId, accountId and
-- legalEntityId must ALL point into the same club.
ALTER TABLE "gl_journal_lines" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "gl_journal_lines";
CREATE POLICY tenant_isolation ON "gl_journal_lines" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK (
    "clubId" = app.current_club_id()
    AND EXISTS (SELECT 1 FROM "gl_journal_entries" je WHERE je."id" = "entryId" AND je."clubId" = app.current_club_id())
    AND EXISTS (SELECT 1 FROM "gl_accounts" a WHERE a."id" = "accountId" AND a."clubId" = app.current_club_id())
    AND (
      "legalEntityId" IS NULL
      OR EXISTS (SELECT 1 FROM "legal_entities" e WHERE e."id" = "legalEntityId" AND e."clubId" = app.current_club_id())
    )
  );

-- gl_entry_attachments — entryId must be an entry in the same club, or one club
-- could hang a document off another's entry.
ALTER TABLE "gl_entry_attachments" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "gl_entry_attachments";
CREATE POLICY tenant_isolation ON "gl_entry_attachments" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK (
    "clubId" = app.current_club_id()
    AND EXISTS (SELECT 1 FROM "gl_journal_entries" je WHERE je."id" = "entryId" AND je."clubId" = app.current_club_id())
  );

-- gl_lock_dates — legalEntityId must be an entity in the same club. Without
-- this, one club could create a lock-date row naming another club's entity.
ALTER TABLE "gl_lock_dates" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "gl_lock_dates";
CREATE POLICY tenant_isolation ON "gl_lock_dates" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK (
    "clubId" = app.current_club_id()
    AND EXISTS (SELECT 1 FROM "legal_entities" e WHERE e."id" = "legalEntityId" AND e."clubId" = app.current_club_id())
  );

-- gl_audit_logs — objectId is a loose reference by design (it names accounts,
-- entries, lines and entities alike, and the log must outlive what it
-- describes), so clubId is the whole check here.
ALTER TABLE "gl_audit_logs" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "gl_audit_logs";
CREATE POLICY tenant_isolation ON "gl_audit_logs" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK ("clubId" = app.current_club_id());

-- ── 9. Grants for the RLS-enforced app role ─────────────────────────────────
-- rls/setup-app-role.sql sets ALTER DEFAULT PRIVILEGES, which should cover
-- these automatically. The explicit grants are here anyway: default privileges
-- only apply to tables created by the role they were configured for, and an
-- environment where the app role doesn't exist yet (local, a fresh branch DB)
-- must not fail this migration. Hence the guard.
--
-- Grants allow the OPERATIONS; RLS above is what constrains WHICH ROWS.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athletix_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      "gl_accounts", "gl_journal_entries", "gl_journal_lines",
      "gl_entry_attachments", "gl_lock_dates", "gl_audit_logs"
      TO athletix_app;
  END IF;
END $$;
