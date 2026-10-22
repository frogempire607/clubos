-- ═══════════════════════════════════════════════════════════════════════════
-- Accounting Phase 3 — reports, close, onboarding (Phase 12)
-- Design: web/docs/accounting/plan.md
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ADDITIVE ONLY. Five new tables, four new nullable columns, and RLS policies
-- for six tables that had none. Nothing is renamed, dropped or retyped; no row
-- is rewritten.
--
-- ORDER MATTERS: apply BEFORE deploying the code that reads it.
--
--   cd web && npx prisma migrate deploy
--
-- NOT `migrate dev` — the shadow database is blocked by the Supabase pooler.
-- NEVER pass a production URL to --shadow-database-url.
--
-- Requires 20261020000000_gl_ledger_core and 20261021000000_gl_auto_posting_
-- reconcile to be applied: this adds foreign keys into gl_accounts and
-- gl_journal_entries.
--
-- Idempotent throughout, so a partial apply can be re-run safely.

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1 — RLS FIRST (Phase 3 task 1)
-- ═══════════════════════════════════════════════════════════════════════════
-- Six tables Phase 3's reports read, none of which had a policy. They are part
-- of the set the harness's T0.1 reports; the remaining 20 are members-, email-
-- and events-side and out of this phase's reach (listed in the report).
--
-- FK-AWARE where there is an FK to another tenant table. Phase 1's harness
-- proved a clubId-only policy is not enough there: the clubId check passes and
-- POSTGRES FK CHECKS DELIBERATELY BYPASS RLS, so one club can point a row at
-- another's record. Conditions go in WITH CHECK, never USING, so a bad row
-- stays visible to the club that has to fix it.

-- plaid_transactions — has a REAL FK to plaid_connections, so that is verified.
-- (`legalEntityId` and `categorizedExpenseId` are deliberately loose references
-- with no FK, so there is no FK target to check for those.)
ALTER TABLE "plaid_transactions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "plaid_transactions";
CREATE POLICY tenant_isolation ON "plaid_transactions" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK (
    "clubId" = app.current_club_id()
    AND EXISTS (
      SELECT 1 FROM "plaid_connections" pc
      WHERE pc."id" = "plaidConnectionId" AND pc."clubId" = app.current_club_id()
    )
  );

-- plaid_sync_cursors — same FK, same treatment.
ALTER TABLE "plaid_sync_cursors" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "plaid_sync_cursors";
CREATE POLICY tenant_isolation ON "plaid_sync_cursors" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK (
    "clubId" = app.current_club_id()
    AND EXISTS (
      SELECT 1 FROM "plaid_connections" pc
      WHERE pc."id" = "plaidConnectionId" AND pc."clubId" = app.current_club_id()
    )
  );

-- stripe_reconciliations — clubId is the WHOLE check, and that is correct
-- rather than lazy: it has no FK to another tenant table. `suggestedMemberId`
-- and `resolvedMemberId` are deliberately loose (the row exists precisely
-- because the member is NOT yet confirmed), so there is no FK to verify.
ALTER TABLE "stripe_reconciliations" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "stripe_reconciliations";
CREATE POLICY tenant_isolation ON "stripe_reconciliations" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK ("clubId" = app.current_club_id());

-- transaction_category_rules, expense_classification_overrides,
-- report_alert_settings — finance/reports tables with clubId only.
ALTER TABLE "transaction_category_rules" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "transaction_category_rules";
CREATE POLICY tenant_isolation ON "transaction_category_rules" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK ("clubId" = app.current_club_id());

ALTER TABLE "expense_classification_overrides" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "expense_classification_overrides";
CREATE POLICY tenant_isolation ON "expense_classification_overrides" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK ("clubId" = app.current_club_id());

ALTER TABLE "report_alert_settings" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "report_alert_settings";
CREATE POLICY tenant_isolation ON "report_alert_settings" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK ("clubId" = app.current_club_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athletix_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      "plaid_transactions", "plaid_sync_cursors", "stripe_reconciliations",
      "transaction_category_rules", "expense_classification_overrides",
      "report_alert_settings"
      TO athletix_app;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 2 — new columns
-- ═══════════════════════════════════════════════════════════════════════════

-- Per-year 1099 thresholds in cents. NULL = the statutory defaults in
-- lib/form1099.ts. NO DEFAULT: a hardcoded figure is exactly what the law
-- changing out from under us would make wrong (OBBBA moved it from $600 to
-- $2,000 for 2026, indexed from 2027).
ALTER TABLE "clubs" ADD COLUMN IF NOT EXISTS "form1099Thresholds" JSONB;

-- Task 9's duplicate guard.
ALTER TABLE "plaid_transactions" ADD COLUMN IF NOT EXISTS "suspectedDuplicateOf" TEXT;
ALTER TABLE "plaid_transactions" ADD COLUMN IF NOT EXISTS "duplicateDismissedAt" TIMESTAMP(3);
ALTER TABLE "plaid_transactions" ADD COLUMN IF NOT EXISTS "duplicateDismissedByUserId" TEXT;
CREATE INDEX IF NOT EXISTS "plaid_transactions_clubId_suspectedDuplicateOf_idx"
  ON "plaid_transactions"("clubId", "suspectedDuplicateOf");

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3 — gl_fixed_assets
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS "gl_fixed_assets" (
  "id"                    TEXT NOT NULL,
  "clubId"                TEXT NOT NULL,
  "name"                  TEXT NOT NULL,
  "description"           TEXT,
  "costCents"             INTEGER NOT NULL,
  "inServiceDate"         DATE NOT NULL,
  "usefulLifeMonths"      INTEGER NOT NULL,
  "salvageValueCents"     INTEGER NOT NULL DEFAULT 0,
  "legalEntityId"         TEXT,
  "assetAccountId"        TEXT NOT NULL,
  "accumDepAccountId"     TEXT NOT NULL,
  "depExpenseAccountId"   TEXT NOT NULL,
  "status"                TEXT NOT NULL DEFAULT 'ACTIVE',
  "disposedDate"          DATE,
  "disposalProceedsCents" INTEGER,
  "disposalEntryId"       TEXT,
  "disposalNote"          TEXT,
  "createdByUserId"       TEXT,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gl_fixed_assets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "gl_fixed_assets_clubId_status_idx" ON "gl_fixed_assets"("clubId", "status");
CREATE INDEX IF NOT EXISTS "gl_fixed_assets_clubId_inServiceDate_idx" ON "gl_fixed_assets"("clubId", "inServiceDate");
CREATE INDEX IF NOT EXISTS "gl_fixed_assets_legalEntityId_idx" ON "gl_fixed_assets"("legalEntityId");
CREATE INDEX IF NOT EXISTS "gl_fixed_assets_assetAccountId_idx" ON "gl_fixed_assets"("assetAccountId");
CREATE INDEX IF NOT EXISTS "gl_fixed_assets_accumDepAccountId_idx" ON "gl_fixed_assets"("accumDepAccountId");
CREATE INDEX IF NOT EXISTS "gl_fixed_assets_depExpenseAccountId_idx" ON "gl_fixed_assets"("depExpenseAccountId");

-- An asset that cost nothing, lasts no months, or is worth more scrapped than
-- it cost is a data-entry error, not a record.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_fixed_assets_sane') THEN
    ALTER TABLE "gl_fixed_assets" ADD CONSTRAINT "gl_fixed_assets_sane"
      CHECK (
        "costCents" > 0
        AND "usefulLifeMonths" > 0
        AND "salvageValueCents" >= 0
        AND "salvageValueCents" <= "costCents"
      );
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 4 — gl_month_closes
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS "gl_month_closes" (
  "id"               TEXT NOT NULL,
  "clubId"           TEXT NOT NULL,
  "legalEntityId"    TEXT NOT NULL,
  "periodMonth"      DATE NOT NULL,
  "status"           TEXT NOT NULL DEFAULT 'OPEN',
  "checklist"        JSONB,
  "lockDateBefore"   DATE,
  "closedAt"         TIMESTAMP(3),
  "closedByUserId"   TEXT,
  "reopenedAt"       TIMESTAMP(3),
  "reopenedByUserId" TEXT,
  "reopenReason"     TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gl_month_closes_pkey" PRIMARY KEY ("id")
);

-- One close per entity per month.
CREATE UNIQUE INDEX IF NOT EXISTS "gl_month_closes_clubId_entity_month_key"
  ON "gl_month_closes"("clubId", "legalEntityId", "periodMonth");
CREATE INDEX IF NOT EXISTS "gl_month_closes_clubId_status_idx" ON "gl_month_closes"("clubId", "status");
CREATE INDEX IF NOT EXISTS "gl_month_closes_legalEntityId_idx" ON "gl_month_closes"("legalEntityId");

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 5 — gl_opening_imports
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS "gl_opening_imports" (
  "id"              TEXT NOT NULL,
  "clubId"          TEXT NOT NULL,
  "fileName"        TEXT NOT NULL,
  "status"          TEXT NOT NULL DEFAULT 'DRAFT',
  "rows"            JSONB NOT NULL,
  "mapping"         JSONB NOT NULL DEFAULT '{}',
  "asOfDate"        DATE,
  "entryIds"        JSONB,
  "summary"         JSONB,
  "postedAt"        TIMESTAMP(3),
  "postedByUserId"  TEXT,
  "voidedAt"        TIMESTAMP(3),
  "voidedByUserId"  TEXT,
  "voidReason"      TEXT,
  "createdByUserId" TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gl_opening_imports_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "gl_opening_imports_clubId_status_idx" ON "gl_opening_imports"("clubId", "status");

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 6 — the QuickBooks history archive (read-only)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS "qbo_history_files" (
  "id"               TEXT NOT NULL,
  "clubId"           TEXT NOT NULL,
  "fileName"         TEXT NOT NULL,
  "kind"             TEXT NOT NULL DEFAULT 'GENERAL_LEDGER',
  "rowCount"         INTEGER NOT NULL DEFAULT 0,
  "fileId"           TEXT,
  "notes"            TEXT,
  "uploadedByUserId" TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "qbo_history_files_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "qbo_history_files_clubId_createdAt_idx" ON "qbo_history_files"("clubId", "createdAt");

CREATE TABLE IF NOT EXISTS "qbo_history_rows" (
  "id"          TEXT NOT NULL,
  "clubId"      TEXT NOT NULL,
  "fileId"      TEXT NOT NULL,
  "txDate"      DATE,
  "txType"      TEXT,
  "num"         TEXT,
  "name"        TEXT,
  "memo"        TEXT,
  "account"     TEXT,
  "split"       TEXT,
  "amountCents" INTEGER,
  "raw"         JSONB,
  "rowIndex"    INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "qbo_history_rows_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "qbo_history_rows_clubId_txDate_idx" ON "qbo_history_rows"("clubId", "txDate");
CREATE INDEX IF NOT EXISTS "qbo_history_rows_fileId_rowIndex_idx" ON "qbo_history_rows"("fileId", "rowIndex");
CREATE INDEX IF NOT EXISTS "qbo_history_rows_clubId_account_idx" ON "qbo_history_rows"("clubId", "account");
CREATE INDEX IF NOT EXISTS "qbo_history_rows_clubId_name_idx" ON "qbo_history_rows"("clubId", "name");

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 7 — foreign keys
-- ═══════════════════════════════════════════════════════════════════════════
-- RESTRICT where deleting the target would orphan accounting history (an
-- account carrying an asset's depreciation, an entity with a closed month);
-- CASCADE only where the child is a part of its parent (archive rows).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_fixed_assets_clubId_fkey') THEN
    ALTER TABLE "gl_fixed_assets" ADD CONSTRAINT "gl_fixed_assets_clubId_fkey"
      FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_fixed_assets_legalEntityId_fkey') THEN
    ALTER TABLE "gl_fixed_assets" ADD CONSTRAINT "gl_fixed_assets_legalEntityId_fkey"
      FOREIGN KEY ("legalEntityId") REFERENCES "legal_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_fixed_assets_assetAccountId_fkey') THEN
    ALTER TABLE "gl_fixed_assets" ADD CONSTRAINT "gl_fixed_assets_assetAccountId_fkey"
      FOREIGN KEY ("assetAccountId") REFERENCES "gl_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_fixed_assets_accumDepAccountId_fkey') THEN
    ALTER TABLE "gl_fixed_assets" ADD CONSTRAINT "gl_fixed_assets_accumDepAccountId_fkey"
      FOREIGN KEY ("accumDepAccountId") REFERENCES "gl_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_fixed_assets_depExpenseAccountId_fkey') THEN
    ALTER TABLE "gl_fixed_assets" ADD CONSTRAINT "gl_fixed_assets_depExpenseAccountId_fkey"
      FOREIGN KEY ("depExpenseAccountId") REFERENCES "gl_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_month_closes_clubId_fkey') THEN
    ALTER TABLE "gl_month_closes" ADD CONSTRAINT "gl_month_closes_clubId_fkey"
      FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_month_closes_legalEntityId_fkey') THEN
    ALTER TABLE "gl_month_closes" ADD CONSTRAINT "gl_month_closes_legalEntityId_fkey"
      FOREIGN KEY ("legalEntityId") REFERENCES "legal_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_opening_imports_clubId_fkey') THEN
    ALTER TABLE "gl_opening_imports" ADD CONSTRAINT "gl_opening_imports_clubId_fkey"
      FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'qbo_history_files_clubId_fkey') THEN
    ALTER TABLE "qbo_history_files" ADD CONSTRAINT "qbo_history_files_clubId_fkey"
      FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'qbo_history_rows_clubId_fkey') THEN
    ALTER TABLE "qbo_history_rows" ADD CONSTRAINT "qbo_history_rows_clubId_fkey"
      FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'qbo_history_rows_fileId_fkey') THEN
    ALTER TABLE "qbo_history_rows" ADD CONSTRAINT "qbo_history_rows_fileId_fkey"
      FOREIGN KEY ("fileId") REFERENCES "qbo_history_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 8 — RLS on the five new tables, FK-aware
-- ═══════════════════════════════════════════════════════════════════════════
-- Cross-club proof: rls/harness/run-tests.ts section T11.

ALTER TABLE "gl_fixed_assets" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "gl_fixed_assets";
CREATE POLICY tenant_isolation ON "gl_fixed_assets" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK (
    "clubId" = app.current_club_id()
    AND EXISTS (SELECT 1 FROM "gl_accounts" a WHERE a."id" = "assetAccountId" AND a."clubId" = app.current_club_id())
    AND EXISTS (SELECT 1 FROM "gl_accounts" a WHERE a."id" = "accumDepAccountId" AND a."clubId" = app.current_club_id())
    AND EXISTS (SELECT 1 FROM "gl_accounts" a WHERE a."id" = "depExpenseAccountId" AND a."clubId" = app.current_club_id())
    AND (
      "legalEntityId" IS NULL
      OR EXISTS (SELECT 1 FROM "legal_entities" e WHERE e."id" = "legalEntityId" AND e."clubId" = app.current_club_id())
    )
  );

ALTER TABLE "gl_month_closes" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "gl_month_closes";
CREATE POLICY tenant_isolation ON "gl_month_closes" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK (
    "clubId" = app.current_club_id()
    AND EXISTS (SELECT 1 FROM "legal_entities" e WHERE e."id" = "legalEntityId" AND e."clubId" = app.current_club_id())
  );

-- gl_opening_imports has no FK beyond clubId (entryIds is a JSON list, not a
-- foreign key), so clubId is the whole check.
ALTER TABLE "gl_opening_imports" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "gl_opening_imports";
CREATE POLICY tenant_isolation ON "gl_opening_imports" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK ("clubId" = app.current_club_id());

ALTER TABLE "qbo_history_files" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "qbo_history_files";
CREATE POLICY tenant_isolation ON "qbo_history_files" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK ("clubId" = app.current_club_id());

-- qbo_history_rows → its file must be in the same club.
ALTER TABLE "qbo_history_rows" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "qbo_history_rows";
CREATE POLICY tenant_isolation ON "qbo_history_rows" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK (
    "clubId" = app.current_club_id()
    AND EXISTS (SELECT 1 FROM "qbo_history_files" f WHERE f."id" = "fileId" AND f."clubId" = app.current_club_id())
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athletix_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      "gl_fixed_assets", "gl_month_closes", "gl_opening_imports",
      "qbo_history_files", "qbo_history_rows"
      TO athletix_app;
  END IF;
END $$;
