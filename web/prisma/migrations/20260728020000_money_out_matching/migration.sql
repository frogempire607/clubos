-- ─────────────────────────────────────────────────────────────────────────
-- 2026-07-28 · Owner-Financials Phase 1C — Money Out matching (M6 + M7)
-- ─────────────────────────────────────────────────────────────────────────
-- M6: Expense gains review flags + splits + tax-exclusion.
-- M7: TransactionCategoryRule — persist "vendor X → category Y" rules that
--     apply to future PlaidTransactions.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "expenses"
  ADD COLUMN IF NOT EXISTS "reviewedAt"       TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "reviewedByUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "excludedFromTax"  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "taxCategory"      TEXT,
  ADD COLUMN IF NOT EXISTS "splits"           JSONB;

CREATE INDEX IF NOT EXISTS "expenses_reviewedAt_idx"
    ON "expenses" ("clubId", "reviewedAt");

CREATE TABLE IF NOT EXISTS "transaction_category_rules" (
    "id"          TEXT NOT NULL PRIMARY KEY,
    "clubId"      TEXT NOT NULL,
    -- VENDOR_EXACT | VENDOR_CONTAINS | DESCRIPTION_CONTAINS | AMOUNT_EQUALS
    -- | AMOUNT_RANGE
    "matchType"   TEXT NOT NULL,
    -- The value the matchType compares against. For AMOUNT_RANGE, `matchMin`
    -- and `matchMax` carry the range (inclusive); `matchValue` is unused.
    "matchValue"  TEXT,
    "matchMin"    DECIMAL(12, 2),
    "matchMax"    DECIMAL(12, 2),
    -- The category this rule applies. Matches lib/financials.ts
    -- EXPENSE_CATEGORIES keys.
    "category"    TEXT NOT NULL,
    -- Owner may temporarily disable a rule without deleting it.
    "active"      BOOLEAN NOT NULL DEFAULT true,
    -- Optional excluded-from-tax marker — a rule can categorize AND mark a
    -- row as excluded (e.g. an owner-draw vendor).
    "excludeFromTax" BOOLEAN NOT NULL DEFAULT false,
    -- Optional transfer marker (transfers between the club's own accounts).
    "markAsTransfer" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transaction_category_rules_clubId_fkey"
        FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "transaction_category_rules_clubId_active_idx"
    ON "transaction_category_rules" ("clubId", "active");

-- ─────────────────────────────────────────────────────────────────────────
-- ROLLBACK:
--   DROP INDEX IF EXISTS "transaction_category_rules_clubId_active_idx";
--   DROP TABLE IF EXISTS "transaction_category_rules";
--   DROP INDEX IF EXISTS "expenses_reviewedAt_idx";
--   ALTER TABLE "expenses"
--     DROP COLUMN IF EXISTS "reviewedAt",
--     DROP COLUMN IF EXISTS "reviewedByUserId",
--     DROP COLUMN IF EXISTS "excludedFromTax",
--     DROP COLUMN IF EXISTS "taxCategory",
--     DROP COLUMN IF EXISTS "splits";
-- ─────────────────────────────────────────────────────────────────────────
