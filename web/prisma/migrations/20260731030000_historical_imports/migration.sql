-- ─────────────────────────────────────────────────────────────────────────
-- 2026-07-31 · Reports Phase 2.5.9 — M13 + M14 + M15
--   Historical import schema + Member/Transaction field additions.
-- ─────────────────────────────────────────────────────────────────────────
-- Delivers everything the import wizard (Phase 2.5.10) needs to persist a
-- batch, its per-row audit log, and the historical records themselves —
-- PLUS the field additions on Member and Transaction so:
--   - Member.externalMemberId / normalizedEmail / normalizedPhone drive
--     matching signals in spec 04.
--   - Transaction.(clubId, sourceSystem, externalTransactionId) is UNIQUE,
--     which is the whole idempotency story for transaction imports.
--
-- Additive throughout. Existing rows keep working. All new columns are
-- nullable; new tables start empty.
-- ─────────────────────────────────────────────────────────────────────────

-- ── ImportBatch ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "import_batches" (
    "id"                TEXT NOT NULL PRIMARY KEY,
    "clubId"            TEXT NOT NULL,
    "kind"              TEXT NOT NULL,             -- "MEMBERS" | "TRANSACTIONS"
    "status"            TEXT NOT NULL DEFAULT 'DRAFT',
                             -- DRAFT | VALIDATING | AWAITING_REVIEW | COMMITTING
                             -- | COMPLETED | FAILED | ROLLED_BACK
    -- "Where are you importing from?" — free text the owner typed at step 1.
    -- Never hardcode a vendor name in the UI; this is the single source.
    "sourceLabel"       TEXT,
    "sourceSystem"      TEXT,                      -- opaque slug for grouping
    "fileName"          TEXT NOT NULL,
    "fileHash"          TEXT NOT NULL,
    "rowCount"          INTEGER NOT NULL DEFAULT 0,
    "columnMap"         JSONB,
    "createdCount"      INTEGER NOT NULL DEFAULT 0,
    "matchedCount"      INTEGER NOT NULL DEFAULT 0,
    "mergedCount"       INTEGER NOT NULL DEFAULT 0,
    "skippedCount"      INTEGER NOT NULL DEFAULT 0,
    "errorCount"        INTEGER NOT NULL DEFAULT 0,
    "reviewCount"       INTEGER NOT NULL DEFAULT 0,
    "startedAt"         TIMESTAMP(3),
    "completedAt"       TIMESTAMP(3),
    "rolledBackAt"      TIMESTAMP(3),
    "rollbackExpiresAt" TIMESTAMP(3),              -- completedAt + 30 days
    "createdById"       TEXT,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_batches_clubId_fkey"
        FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "import_batches_clubId_kind_idx"
    ON "import_batches" ("clubId", "kind", "createdAt");
CREATE INDEX IF NOT EXISTS "import_batches_clubId_status_idx"
    ON "import_batches" ("clubId", "status");

-- ── ImportRow ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "import_rows" (
    "id"             TEXT NOT NULL PRIMARY KEY,
    "batchId"        TEXT NOT NULL,
    "clubId"         TEXT NOT NULL,
    "rowNumber"      INTEGER NOT NULL,
    "rawData"        JSONB NOT NULL,
    "normalizedData" JSONB,
    "outcome"        TEXT NOT NULL,                -- CREATED | MATCHED | MERGED
                                                    -- | LINKED | SKIPPED | EXCLUDED
                                                    -- | PENDING_REVIEW
    "reason"         TEXT,
    "matchSignal"    TEXT,                          -- EXTERNAL_ID | EXACT_EMAIL | …
    "confidence"     TEXT,                          -- HIGH | MEDIUM | LOW
    "targetType"     TEXT,                          -- "Member" | "Transaction"
    "targetId"       TEXT,
    "decidedBy"      TEXT,
    "decidedAt"      TIMESTAMP(3),
    "errors"         JSONB,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_rows_batchId_fkey"
        FOREIGN KEY ("batchId") REFERENCES "import_batches"("id") ON DELETE CASCADE,
    CONSTRAINT "import_rows_clubId_fkey"
        FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "import_rows_batchId_outcome_idx"
    ON "import_rows" ("batchId", "outcome");
CREATE INDEX IF NOT EXISTS "import_rows_clubId_targetId_idx"
    ON "import_rows" ("clubId", "targetId");

-- ── MemberHistoricalRecord ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "member_historical_records" (
    "id"                  TEXT NOT NULL PRIMARY KEY,
    "clubId"              TEXT NOT NULL,
    "memberId"            TEXT NOT NULL,
    "membershipTypeLabel" TEXT,
    "startDate"           TIMESTAMP(3),
    "endDate"             TIMESTAMP(3),
    "status"              TEXT,                    -- ACTIVE | INACTIVE | PAUSED | UNKNOWN
    "externalMemberId"    TEXT,
    "sourceSystem"        TEXT,
    "importBatchId"       TEXT,
    "notes"               TEXT,
    "dataCompleteness"    JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_historical_records_clubId_fkey"
        FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE,
    CONSTRAINT "member_historical_records_memberId_fkey"
        FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE,
    CONSTRAINT "member_historical_records_importBatchId_fkey"
        FOREIGN KEY ("importBatchId") REFERENCES "import_batches"("id") ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "member_historical_records_memberId_idx"
    ON "member_historical_records" ("memberId");
CREATE INDEX IF NOT EXISTS "member_historical_records_clubId_idx"
    ON "member_historical_records" ("clubId");

-- ── Member field additions (M14) ───────────────────────────────────────
ALTER TABLE "members"
  ADD COLUMN IF NOT EXISTS "externalMemberId"  TEXT,
  ADD COLUMN IF NOT EXISTS "sourceSystem"      TEXT,
  ADD COLUMN IF NOT EXISTS "importBatchId"     TEXT,
  ADD COLUMN IF NOT EXISTS "isHistoricalOnly"  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "normalizedEmail"   TEXT,
  ADD COLUMN IF NOT EXISTS "normalizedPhone"   TEXT;

CREATE INDEX IF NOT EXISTS "members_clubId_externalMemberId_idx"
    ON "members" ("clubId", "externalMemberId");
CREATE INDEX IF NOT EXISTS "members_clubId_normalizedEmail_idx"
    ON "members" ("clubId", "normalizedEmail");
CREATE INDEX IF NOT EXISTS "members_clubId_normalizedPhone_idx"
    ON "members" ("clubId", "normalizedPhone");
CREATE INDEX IF NOT EXISTS "members_clubId_isHistoricalOnly_idx"
    ON "members" ("clubId", "isHistoricalOnly");
CREATE INDEX IF NOT EXISTS "members_importBatchId_idx"
    ON "members" ("importBatchId");

-- ── Transaction field additions (M15) ──────────────────────────────────
ALTER TABLE "transactions"
  ADD COLUMN IF NOT EXISTS "externalTransactionId" TEXT,
  ADD COLUMN IF NOT EXISTS "externalCustomerId"    TEXT,
  ADD COLUMN IF NOT EXISTS "sourceSystem"          TEXT,
  ADD COLUMN IF NOT EXISTS "importBatchId"         TEXT,
  ADD COLUMN IF NOT EXISTS "isHistorical"          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "dedupeHash"            TEXT;

-- Duplicate-prevention: (clubId, sourceSystem, externalTransactionId) unique.
-- Excludes NULLs so pre-existing rows without an external id still work.
CREATE UNIQUE INDEX IF NOT EXISTS
  "transactions_clubId_sourceSystem_externalTransactionId_key"
  ON "transactions" ("clubId", "sourceSystem", "externalTransactionId")
  WHERE "externalTransactionId" IS NOT NULL AND "sourceSystem" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "transactions_clubId_dedupeHash_key"
    ON "transactions" ("clubId", "dedupeHash")
    WHERE "dedupeHash" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "transactions_clubId_isHistorical_idx"
    ON "transactions" ("clubId", "isHistorical");
CREATE INDEX IF NOT EXISTS "transactions_importBatchId_idx"
    ON "transactions" ("importBatchId");

-- ─────────────────────────────────────────────────────────────────────────
-- Backfills BF-1 / BF-2 / BF-3 are NOT run here. They live in
-- scripts/reports-historical-backfill.ts, dry-run first with per-club
-- reports, allowlist-required --apply. Rationale: touching every Member +
-- Transaction row in production during a schema migration is riskier than
-- doing it in a scripted, review-gated pass. New Member/Transaction rows
-- fill these fields going forward via the writer helpers.
-- ─────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────
-- ROLLBACK:
--   DROP INDEX IF EXISTS "transactions_importBatchId_idx";
--   DROP INDEX IF EXISTS "transactions_clubId_isHistorical_idx";
--   DROP INDEX IF EXISTS "transactions_clubId_dedupeHash_key";
--   DROP INDEX IF EXISTS "transactions_clubId_sourceSystem_externalTransactionId_key";
--   ALTER TABLE "transactions"
--     DROP COLUMN IF EXISTS "externalTransactionId",
--     DROP COLUMN IF EXISTS "externalCustomerId",
--     DROP COLUMN IF EXISTS "sourceSystem",
--     DROP COLUMN IF EXISTS "importBatchId",
--     DROP COLUMN IF EXISTS "isHistorical",
--     DROP COLUMN IF EXISTS "dedupeHash";
--   DROP INDEX IF EXISTS "members_importBatchId_idx";
--   DROP INDEX IF EXISTS "members_clubId_isHistoricalOnly_idx";
--   DROP INDEX IF EXISTS "members_clubId_normalizedPhone_idx";
--   DROP INDEX IF EXISTS "members_clubId_normalizedEmail_idx";
--   DROP INDEX IF EXISTS "members_clubId_externalMemberId_idx";
--   ALTER TABLE "members"
--     DROP COLUMN IF EXISTS "externalMemberId",
--     DROP COLUMN IF EXISTS "sourceSystem",
--     DROP COLUMN IF EXISTS "importBatchId",
--     DROP COLUMN IF EXISTS "isHistoricalOnly",
--     DROP COLUMN IF EXISTS "normalizedEmail",
--     DROP COLUMN IF EXISTS "normalizedPhone";
--   DROP TABLE IF EXISTS "member_historical_records";
--   DROP TABLE IF EXISTS "import_rows";
--   DROP TABLE IF EXISTS "import_batches";
-- ─────────────────────────────────────────────────────────────────────────
