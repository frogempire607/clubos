-- ─────────────────────────────────────────────────────────────────────────
-- 2026-07-28 · Owner-Financials Phase 1B — Plaid persistence (M5)
-- ─────────────────────────────────────────────────────────────────────────
-- The old Plaid path live-fetched a hardcoded 30-day window on every page
-- load. Two new tables give us a real bank ledger:
--
--   plaid_transactions  → the actual bank rows (dedup by plaidTransactionId)
--   plaid_sync_cursors  → per-connection cursor from Plaid /transactions/sync
--                          + earliestAvailableDate so the UI can say "we have
--                          data back to <date>".
--
-- Additive. Nothing else touches transactions or expenses; matching (M6)
-- comes in Phase 1C.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "plaid_transactions" (
    "id"                            TEXT NOT NULL PRIMARY KEY,
    "clubId"                        TEXT NOT NULL,
    "plaidConnectionId"             TEXT NOT NULL,
    "plaidTransactionId"            TEXT NOT NULL,
    "accountId"                     TEXT NOT NULL,
    -- Plaid emits positive numbers for OUTFLOWS (spending). We keep that
    -- convention: positive = money out, negative = money in.
    "amount"                        DECIMAL(12, 2) NOT NULL,
    "isoCurrencyCode"               TEXT,
    -- Postdate of the transaction (Plaid's `date`; NOT `authorized_date`).
    "date"                          DATE NOT NULL,
    "name"                          TEXT NOT NULL,
    "merchantName"                  TEXT,
    "paymentChannel"                TEXT,
    -- Plaid's category array (older API) — kept for display, not primary
    -- signal. Personal-finance category is the new taxonomy.
    "category"                      JSONB,
    "personalFinanceCategoryPrimary"  TEXT,
    "personalFinanceCategoryDetailed" TEXT,
    -- Pending → posted transitions overwrite the row (dedup by plaid id).
    "pending"                       BOOLEAN NOT NULL DEFAULT false,
    -- Owner review state — used by the Money-Out matching UX in Phase 1C.
    "categorizedExpenseId"          TEXT,
    "categoryOverride"              TEXT,        -- owner picked category
    "reviewedAt"                    TIMESTAMP(3),
    "reviewedByUserId"              TEXT,
    "excludedFromTax"               BOOLEAN NOT NULL DEFAULT false,
    "markedAsTransfer"              BOOLEAN NOT NULL DEFAULT false,
    "notes"                         TEXT,
    -- When we last saw this row from Plaid. Not the same as `date`.
    "syncedAt"                      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"                     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plaid_transactions_clubId_fkey"
        FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE,
    CONSTRAINT "plaid_transactions_plaidConnectionId_fkey"
        FOREIGN KEY ("plaidConnectionId") REFERENCES "plaid_connections"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "plaid_transactions_plaidTransactionId_key"
    ON "plaid_transactions" ("plaidTransactionId");
CREATE INDEX IF NOT EXISTS "plaid_transactions_clubId_date_idx"
    ON "plaid_transactions" ("clubId", "date" DESC);
CREATE INDEX IF NOT EXISTS "plaid_transactions_clubId_connection_idx"
    ON "plaid_transactions" ("clubId", "plaidConnectionId", "date" DESC);
CREATE INDEX IF NOT EXISTS "plaid_transactions_clubId_reviewed_idx"
    ON "plaid_transactions" ("clubId", "reviewedAt");
CREATE INDEX IF NOT EXISTS "plaid_transactions_categorizedExpenseId_idx"
    ON "plaid_transactions" ("categorizedExpenseId");

CREATE TABLE IF NOT EXISTS "plaid_sync_cursors" (
    "id"                     TEXT NOT NULL PRIMARY KEY,
    "clubId"                 TEXT NOT NULL,
    "plaidConnectionId"      TEXT NOT NULL,
    -- The cursor Plaid /transactions/sync returns each call. Empty on the
    -- first call (initial full-history sync); populated thereafter.
    "cursor"                 TEXT,
    -- Earliest date Plaid ever returned for this connection — used to render
    -- "We have data back to Feb 3, 2024" in the Bank tab when the owner
    -- selects All Time.
    "earliestAvailableDate"  DATE,
    "lastSyncedAt"           TIMESTAMP(3),
    "lastSyncError"          TEXT,
    "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plaid_sync_cursors_clubId_fkey"
        FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE,
    CONSTRAINT "plaid_sync_cursors_plaidConnectionId_fkey"
        FOREIGN KEY ("plaidConnectionId") REFERENCES "plaid_connections"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "plaid_sync_cursors_plaidConnectionId_key"
    ON "plaid_sync_cursors" ("plaidConnectionId");
CREATE INDEX IF NOT EXISTS "plaid_sync_cursors_clubId_idx"
    ON "plaid_sync_cursors" ("clubId");

-- Optional back-reference from Expense → the bank row that produced it
-- (Money Out matching in Phase 1C uses this). Nullable; no FK because we
-- treat PlaidTransaction as the mutable side and don't want an ON DELETE
-- to cascade back through Expense.
ALTER TABLE "expenses"
  ADD COLUMN IF NOT EXISTS "matchedPlaidTransactionId" TEXT;

CREATE INDEX IF NOT EXISTS "expenses_matchedPlaidTransactionId_idx"
    ON "expenses" ("matchedPlaidTransactionId");

-- ─────────────────────────────────────────────────────────────────────────
-- ROLLBACK:
--   ALTER TABLE "expenses" DROP COLUMN IF EXISTS "matchedPlaidTransactionId";
--   DROP TABLE IF EXISTS "plaid_sync_cursors";
--   DROP TABLE IF EXISTS "plaid_transactions";
-- ─────────────────────────────────────────────────────────────────────────
