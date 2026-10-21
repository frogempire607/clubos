-- ═══════════════════════════════════════════════════════════════════════════
-- Accounting Phase 2 — automatic posting + reconciliation (Phase 11)
-- Design: web/docs/accounting/plan.md
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ADDITIVE ONLY. Two new tables and six new nullable columns. Nothing is
-- renamed, dropped or retyped; no row is rewritten; every existing read
-- behaves identically whether or not this has been applied.
--
-- ORDER MATTERS: apply this BEFORE deploying the code that reads it.
--
--   cd web && npx prisma migrate deploy
--
-- NOT `migrate dev` — the shadow database is blocked by the Supabase pooler.
-- NEVER pass a production URL to --shadow-database-url.
--
-- Sorts after 20261020000000_gl_ledger_core (Phase 1), which must already be
-- applied — this migration adds foreign keys into gl_accounts and
-- gl_journal_entries and will fail loudly if those tables are missing.
--
-- Idempotent throughout, so a partial apply can be re-run safely.

-- ── 1. payout_matches RLS (Phase 2's FIRST task) ────────────────────────────
-- This table has existed since 20261016 with no policy — one of the 27 the
-- harness's T0.1 reports. Phase 2 is what starts writing to it, so it gets a
-- policy before anything does.
--
-- clubId is the WHOLE check here, and that is correct rather than lazy:
-- payout_matches has no foreign key to another tenant table. `stripePayoutId`
-- is an opaque Stripe id and `bankTransactionId` is a deliberately loose
-- reference (money outlives bank rows), so there is no FK target whose club
-- could be verified. Compare gl_journal_lines, which DOES have FKs and
-- therefore needs the extra EXISTS conditions — see §6.
ALTER TABLE "payout_matches" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "payout_matches";
CREATE POLICY tenant_isolation ON "payout_matches" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK ("clubId" = app.current_club_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athletix_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "payout_matches" TO athletix_app;
  END IF;
END $$;

-- ── 2. Books start date ─────────────────────────────────────────────────────
-- NULL = automatic posting is NOT configured and does not run. Deliberately
-- NOT defaulted to anything: a default would mean "post everything", which is
-- exactly the double-count this column exists to prevent.
ALTER TABLE "clubs" ADD COLUMN IF NOT EXISTS "booksStartDate" DATE;

-- ── 3. Each bank / card gets its own GL account ─────────────────────────────
ALTER TABLE "bank_accounts" ADD COLUMN IF NOT EXISTS "glAccountId" TEXT;
CREATE INDEX IF NOT EXISTS "bank_accounts_glAccountId_idx" ON "bank_accounts"("glAccountId");

-- ── 4. Program tag on expenses; receipt → entry; cash deposit batch ─────────
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "program" TEXT;
ALTER TABLE "receipts" ADD COLUMN IF NOT EXISTS "glEntryId" TEXT;
CREATE INDEX IF NOT EXISTS "receipts_glEntryId_idx" ON "receipts"("glEntryId");
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "glDepositId" TEXT;
CREATE INDEX IF NOT EXISTS "transactions_clubId_glDepositId_idx" ON "transactions"("clubId", "glDepositId");

-- ── 5. gl_reconciliations ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "gl_reconciliations" (
  "id"                   TEXT NOT NULL,
  "clubId"               TEXT NOT NULL,
  "accountId"            TEXT NOT NULL,
  "periodStart"          DATE NOT NULL,
  "periodEnd"            DATE NOT NULL,
  "statementEndingCents" INTEGER NOT NULL,
  "ledgerEndingCents"    INTEGER,
  "status"               TEXT NOT NULL DEFAULT 'OPEN',
  "notes"                TEXT,
  "finishedAt"           TIMESTAMP(3),
  "finishedByUserId"     TEXT,
  "undoneAt"             TIMESTAMP(3),
  "undoneByUserId"       TEXT,
  "undoReason"           TEXT,
  "createdByUserId"      TEXT,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gl_reconciliations_pkey" PRIMARY KEY ("id")
);

-- One reconciliation per account per statement period.
CREATE UNIQUE INDEX IF NOT EXISTS "gl_reconciliations_clubId_accountId_periodEnd_key"
  ON "gl_reconciliations"("clubId", "accountId", "periodEnd");
CREATE INDEX IF NOT EXISTS "gl_reconciliations_clubId_status_idx" ON "gl_reconciliations"("clubId", "status");
CREATE INDEX IF NOT EXISTS "gl_reconciliations_accountId_idx" ON "gl_reconciliations"("accountId");

-- ── 6. Cleared-line state on gl_journal_lines ───────────────────────────────
-- Additive columns on a Phase 1 table. A line cleared inside a FINISHED
-- reconciliation is frozen: lib/ledgerServer refuses to void its entry until
-- that reconciliation is undone.
ALTER TABLE "gl_journal_lines" ADD COLUMN IF NOT EXISTS "clearedAt" TIMESTAMP(3);
ALTER TABLE "gl_journal_lines" ADD COLUMN IF NOT EXISTS "reconciliationId" TEXT;
CREATE INDEX IF NOT EXISTS "gl_journal_lines_clubId_reconciliationId_idx" ON "gl_journal_lines"("clubId", "reconciliationId");
CREATE INDEX IF NOT EXISTS "gl_journal_lines_clubId_accountId_clearedAt_idx" ON "gl_journal_lines"("clubId", "accountId", "clearedAt");

-- ── 7. gl_deposits ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "gl_deposits" (
  "id"                TEXT NOT NULL,
  "clubId"            TEXT NOT NULL,
  "accountId"         TEXT NOT NULL,
  "depositDate"       DATE NOT NULL,
  "amountCents"       INTEGER NOT NULL,
  "memo"              TEXT,
  "entryId"           TEXT,
  "bankTransactionId" TEXT,
  "createdByUserId"   TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gl_deposits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "gl_deposits_clubId_depositDate_idx" ON "gl_deposits"("clubId", "depositDate");
CREATE INDEX IF NOT EXISTS "gl_deposits_bankTransactionId_idx" ON "gl_deposits"("bankTransactionId");
CREATE INDEX IF NOT EXISTS "gl_deposits_accountId_idx" ON "gl_deposits"("accountId");

-- A deposit of nothing is a bug, not a record.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_deposits_amount_positive') THEN
    ALTER TABLE "gl_deposits" ADD CONSTRAINT "gl_deposits_amount_positive" CHECK ("amountCents" > 0);
  END IF;
END $$;

-- ── 8. Foreign keys ─────────────────────────────────────────────────────────
-- RESTRICT where deleting the target would orphan accounting history
-- (an account with a reconciliation or a deposit against it); SET NULL where
-- the pointer is a convenience and the row must survive without it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_accounts_glAccountId_fkey') THEN
    ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_glAccountId_fkey"
      FOREIGN KEY ("glAccountId") REFERENCES "gl_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'receipts_glEntryId_fkey') THEN
    ALTER TABLE "receipts" ADD CONSTRAINT "receipts_glEntryId_fkey"
      FOREIGN KEY ("glEntryId") REFERENCES "gl_journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_journal_lines_reconciliationId_fkey') THEN
    ALTER TABLE "gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_reconciliationId_fkey"
      FOREIGN KEY ("reconciliationId") REFERENCES "gl_reconciliations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_reconciliations_clubId_fkey') THEN
    ALTER TABLE "gl_reconciliations" ADD CONSTRAINT "gl_reconciliations_clubId_fkey"
      FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_reconciliations_accountId_fkey') THEN
    ALTER TABLE "gl_reconciliations" ADD CONSTRAINT "gl_reconciliations_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "gl_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_deposits_clubId_fkey') THEN
    ALTER TABLE "gl_deposits" ADD CONSTRAINT "gl_deposits_clubId_fkey"
      FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_deposits_accountId_fkey') THEN
    ALTER TABLE "gl_deposits" ADD CONSTRAINT "gl_deposits_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "gl_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_deposits_entryId_fkey') THEN
    ALTER TABLE "gl_deposits" ADD CONSTRAINT "gl_deposits_entryId_fkey"
      FOREIGN KEY ("entryId") REFERENCES "gl_journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ── 9. RLS on the two new tables — FK-AWARE, per the Phase 1 pattern ────────
-- Phase 1's harness proved that a clubId-only policy is NOT enough on a table
-- with a foreign key to another tenant table: the clubId check passes and
-- POSTGRES FK CHECKS DELIBERATELY BYPASS RLS, so club A could point a row at
-- club B's record. Both tables here have an FK to gl_accounts (and
-- gl_deposits one to gl_journal_entries), so each is verified in the policy to
-- point at a row in the SAME club.
--
-- The conditions go in WITH CHECK (INSERT, and the new row of an UPDATE) and
-- deliberately NOT in USING: if a bad row ever does exist it must stay visible,
-- and therefore fixable, to the club that has to clean it up.
--
-- Cross-club proof: rls/harness/run-tests.ts section T10.
ALTER TABLE "gl_reconciliations" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "gl_reconciliations";
CREATE POLICY tenant_isolation ON "gl_reconciliations" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK (
    "clubId" = app.current_club_id()
    AND EXISTS (SELECT 1 FROM "gl_accounts" a WHERE a."id" = "accountId" AND a."clubId" = app.current_club_id())
  );

ALTER TABLE "gl_deposits" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "gl_deposits";
CREATE POLICY tenant_isolation ON "gl_deposits" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK (
    "clubId" = app.current_club_id()
    AND EXISTS (SELECT 1 FROM "gl_accounts" a WHERE a."id" = "accountId" AND a."clubId" = app.current_club_id())
    AND (
      "entryId" IS NULL
      OR EXISTS (SELECT 1 FROM "gl_journal_entries" e WHERE e."id" = "entryId" AND e."clubId" = app.current_club_id())
    )
  );

-- gl_journal_lines gained a reconciliationId FK, so its policy must now verify
-- that too — otherwise club A could claim its line was cleared in club B's
-- reconciliation. The rest of the policy is reproduced unchanged from
-- 20261020000000_gl_ledger_core §8.
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
    AND (
      "reconciliationId" IS NULL
      OR EXISTS (SELECT 1 FROM "gl_reconciliations" r WHERE r."id" = "reconciliationId" AND r."clubId" = app.current_club_id())
    )
  );

-- receipts gained a glEntryId FK. Same reasoning.
DROP POLICY IF EXISTS tenant_isolation ON "receipts";
CREATE POLICY tenant_isolation ON "receipts" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK (
    "clubId" = app.current_club_id()
    AND (
      "glEntryId" IS NULL
      OR EXISTS (SELECT 1 FROM "gl_journal_entries" e WHERE e."id" = "glEntryId" AND e."clubId" = app.current_club_id())
    )
  );

-- bank_accounts gained a glAccountId FK. Same reasoning. (Its pre-existing
-- legalEntityId FK is folded in at the same time — it was only clubId-checked
-- before, which is the same gap Phase 1 found on gl_journal_lines.)
DROP POLICY IF EXISTS tenant_isolation ON "bank_accounts";
CREATE POLICY tenant_isolation ON "bank_accounts" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK (
    "clubId" = app.current_club_id()
    AND (
      "glAccountId" IS NULL
      OR EXISTS (SELECT 1 FROM "gl_accounts" a WHERE a."id" = "glAccountId" AND a."clubId" = app.current_club_id())
    )
    AND (
      "legalEntityId" IS NULL
      OR EXISTS (SELECT 1 FROM "legal_entities" e WHERE e."id" = "legalEntityId" AND e."clubId" = app.current_club_id())
    )
  );

-- ── 10. Grants ──────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athletix_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "gl_reconciliations", "gl_deposits" TO athletix_app;
  END IF;
END $$;
