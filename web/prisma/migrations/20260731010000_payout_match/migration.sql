-- ─────────────────────────────────────────────────────────────────────────
-- 2026-07-31 · Reports Phase 2.5.7 — M11 · PayoutMatch
-- ─────────────────────────────────────────────────────────────────────────
-- Every Stripe payout eventually lands as a bank credit. That bank credit
-- must NOT count as new operating income — the underlying charges already
-- did. This table stores the matched pair so cash flow can exclude the
-- bank rows that are really Stripe payouts.
--
-- Matching heuristic (from specs/03 §double counting): same amount ±$0.01,
-- bank posting date within 5 days of payout arrival_date, description
-- contains the Stripe descriptor. Stored here as a resolved match.
-- Unmatched payouts older than 10 days raise a reliability warning.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "payout_matches" (
    "id"                TEXT NOT NULL PRIMARY KEY,
    "clubId"            TEXT NOT NULL,
    "stripePayoutId"    TEXT NOT NULL,
    "bankTransactionId" TEXT,       -- PlaidTransaction.plaidTransactionId
    "amount"            DECIMAL(12, 2) NOT NULL,
    "arrivalDate"       DATE,       -- Stripe payout arrival_date
    "matchedAt"         TIMESTAMP(3),
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_matches_clubId_fkey"
        FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "payout_matches_clubId_stripePayoutId_key"
    ON "payout_matches" ("clubId", "stripePayoutId");
CREATE INDEX IF NOT EXISTS "payout_matches_clubId_arrivalDate_idx"
    ON "payout_matches" ("clubId", "arrivalDate");
CREATE INDEX IF NOT EXISTS "payout_matches_bankTransactionId_idx"
    ON "payout_matches" ("bankTransactionId");

-- ─────────────────────────────────────────────────────────────────────────
-- ROLLBACK:
--   DROP INDEX IF EXISTS "payout_matches_bankTransactionId_idx";
--   DROP INDEX IF EXISTS "payout_matches_clubId_arrivalDate_idx";
--   DROP INDEX IF EXISTS "payout_matches_clubId_stripePayoutId_key";
--   DROP TABLE IF EXISTS "payout_matches";
-- ─────────────────────────────────────────────────────────────────────────
