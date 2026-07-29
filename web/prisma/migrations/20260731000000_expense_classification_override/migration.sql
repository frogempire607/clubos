-- ─────────────────────────────────────────────────────────────────────────
-- 2026-07-31 · Reports Phase 2.5.3 — M10 · Fixed/variable override
-- ─────────────────────────────────────────────────────────────────────────
-- Per-category owner override for whether an expense category is treated
-- as FIXED (rent, insurance, software) or VARIABLE (gear, travel, meals)
-- in the Costs tab. `Expense.kind` still overrides per-row when set;
-- this table drives the default for un-classified rows in a category.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "expense_classification_overrides" (
    "id"           TEXT NOT NULL PRIMARY KEY,
    "clubId"       TEXT NOT NULL,
    "category"     TEXT NOT NULL,
    "treatAs"      TEXT NOT NULL,           -- "FIXED" | "VARIABLE"
    "updatedById"  TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_classification_overrides_clubId_fkey"
        FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "expense_classification_overrides_clubId_category_key"
    ON "expense_classification_overrides" ("clubId", "category");
CREATE INDEX IF NOT EXISTS "expense_classification_overrides_clubId_idx"
    ON "expense_classification_overrides" ("clubId");

-- ─────────────────────────────────────────────────────────────────────────
-- ROLLBACK:
--   DROP INDEX IF EXISTS "expense_classification_overrides_clubId_category_key";
--   DROP INDEX IF EXISTS "expense_classification_overrides_clubId_idx";
--   DROP TABLE IF EXISTS "expense_classification_overrides";
-- ─────────────────────────────────────────────────────────────────────────
