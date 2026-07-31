-- ─────────────────────────────────────────────────────────────────────────
-- 2026-08-01 · Communications Phase 3 — M17
--   EmailOptOut: add scope + userId (plan §3I).
-- ─────────────────────────────────────────────────────────────────────────
-- Today's suppression list is a flat (clubId, email) unique. Plan §3I
-- distinguishes:
--   MARKETING     — promotions, newsletters, campaigns  (can opt out)
--   TRANSACTIONAL — receipts, password resets, booking confirmations,
--                   account-security notices           (cannot opt out where
--                                                       legally/operationally
--                                                       appropriate)
--   ALL           — hard opt-out at the address (bounces + explicit "stop
--                   contacting me").
--
-- Backfill: every existing row is a MARKETING opt-out — the current
-- unsubscribe link on announcement emails only ever opts out of marketing,
-- so this is semantically what those rows already mean. No behavior change
-- on backfill.
--
-- userId is nullable + no FK. When a member unsubscribes we want to remember
-- WHO did it even if their address later changes; but the anti-abuse HMAC
-- link doesn't require a login, so plenty of rows will stay email-only.
--
-- The existing @@unique([clubId, email]) index stays as-is. Adding scope
-- does NOT widen it — one address per club per scope is intentionally
-- disallowed (a user marks "no marketing"; adding a second "no all" row
-- for the same address should be an UPDATE, not a second row).
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "email_opt_outs"
    ADD COLUMN IF NOT EXISTS "userId"      TEXT,
    ADD COLUMN IF NOT EXISTS "scope"       TEXT NOT NULL DEFAULT 'MARKETING',
    ADD COLUMN IF NOT EXISTS "source"      TEXT,      -- UNSUBSCRIBE_LINK | ADMIN | BOUNCE | COMPLAINT
    ADD COLUMN IF NOT EXISTS "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill: every existing row is a MARKETING opt-out (safe — that's what
-- the current unsubscribe flow produces). The column default handles new
-- rows; this UPDATE makes historical rows explicit in case the default is
-- ever changed later.
UPDATE "email_opt_outs" SET "scope" = 'MARKETING' WHERE "scope" IS NULL;

CREATE INDEX IF NOT EXISTS "email_opt_outs_userId_idx"
    ON "email_opt_outs" ("userId");
CREATE INDEX IF NOT EXISTS "email_opt_outs_clubId_scope_idx"
    ON "email_opt_outs" ("clubId", "scope");

-- ─────────────────────────────────────────────────────────────────────────
-- ROLLBACK:
--   DROP INDEX IF EXISTS "email_opt_outs_clubId_scope_idx";
--   DROP INDEX IF EXISTS "email_opt_outs_userId_idx";
--   ALTER TABLE "email_opt_outs"
--       DROP COLUMN IF EXISTS "updatedAt",
--       DROP COLUMN IF EXISTS "source",
--       DROP COLUMN IF EXISTS "scope",
--       DROP COLUMN IF EXISTS "userId";
-- ─────────────────────────────────────────────────────────────────────────
