-- ─────────────────────────────────────────────────────────────────────────
-- 2026-07-28 · Reports Phase 2 — supporting indexes for all-time queries
-- ─────────────────────────────────────────────────────────────────────────
-- Reports pulls aggregates across every Transaction/Member row when the
-- selected range is All Time. These composite indexes make the range +
-- status filters (which every reports query uses) cheap enough that a
-- 50k-row club doesn't stall the endpoint.
--
-- No schema changes — index-only.
-- ─────────────────────────────────────────────────────────────────────────

-- Transaction — every reports query filters on (clubId, status=SUCCEEDED,
-- createdAt window). The clubId+createdAt combo is the hot path.
CREATE INDEX IF NOT EXISTS "transactions_clubId_status_createdAt_idx"
    ON "transactions" ("clubId", "status", "createdAt");

CREATE INDEX IF NOT EXISTS "transactions_clubId_txDate_idx"
    ON "transactions" ("clubId", "txDate");

-- Member — the "new in range" and status roll-ups filter on
-- (clubId, joinedAt) and (clubId, status).
CREATE INDEX IF NOT EXISTS "members_clubId_joinedAt_idx"
    ON "members" ("clubId", "joinedAt");

CREATE INDEX IF NOT EXISTS "members_clubId_status_idx"
    ON "members" ("clubId", "status");

-- Expense — expenses-by-category buckets on (clubId, date).
CREATE INDEX IF NOT EXISTS "expenses_clubId_date_idx"
    ON "expenses" ("clubId", "date");

-- ─────────────────────────────────────────────────────────────────────────
-- ROLLBACK:
--   DROP INDEX IF EXISTS "transactions_clubId_status_createdAt_idx";
--   DROP INDEX IF EXISTS "transactions_clubId_txDate_idx";
--   DROP INDEX IF EXISTS "members_clubId_joinedAt_idx";
--   DROP INDEX IF EXISTS "members_clubId_status_idx";
--   DROP INDEX IF EXISTS "expenses_clubId_date_idx";
-- ─────────────────────────────────────────────────────────────────────────
