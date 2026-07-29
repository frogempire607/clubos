-- ─────────────────────────────────────────────────────────────────────────
-- 2026-07-30 · Reports Phase 2.5.1 + 2.5.1a — Snapshot foundation
-- ─────────────────────────────────────────────────────────────────────────
--   M9  · Club.wentLiveAt        → boundary for `before_athletix` and
--                                    `since_athletix` ranges. Nullable —
--                                    falls back to Club.createdAt.
--   M9a · action_item_snoozes    → per-user snooze rows for Action Items on
--                                    the owner-first Snapshot.
--
-- Additive. Nothing renamed, nothing dropped.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "clubs"
  ADD COLUMN IF NOT EXISTS "wentLiveAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "action_item_snoozes" (
    "id"           TEXT NOT NULL PRIMARY KEY,
    "clubId"       TEXT NOT NULL,
    "userId"       TEXT NOT NULL,
    -- Action Item kind — matches ActionKind vocabulary in
    -- lib/reportsActionItems.ts. Free string so new kinds don't require a
    -- schema change; the enforced set lives in code.
    "kind"         TEXT NOT NULL,
    -- Optional row-scoped snooze (e.g. dismiss one specific failed payment
    -- but keep the surface active for others). Null = snooze the entire kind
    -- for this user.
    "targetId"     TEXT,
    "snoozedUntil" TIMESTAMP(3) NOT NULL,
    "reason"       TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "action_item_snoozes_clubId_fkey"
        FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE,
    CONSTRAINT "action_item_snoozes_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "action_item_snoozes_clubId_snoozedUntil_idx"
    ON "action_item_snoozes" ("clubId", "snoozedUntil");
CREATE INDEX IF NOT EXISTS "action_item_snoozes_userId_kind_idx"
    ON "action_item_snoozes" ("userId", "kind");

-- Duplicate snoozes for the same (user, kind, targetId) should collapse to
-- the latest one. `targetId IS NULL` gets its own slot per (user, kind).
CREATE UNIQUE INDEX IF NOT EXISTS "action_item_snoozes_unique_row"
    ON "action_item_snoozes" ("userId", "kind", COALESCE("targetId", ''));

-- ─────────────────────────────────────────────────────────────────────────
-- ROLLBACK:
--   DROP INDEX IF EXISTS "action_item_snoozes_unique_row";
--   DROP INDEX IF EXISTS "action_item_snoozes_userId_kind_idx";
--   DROP INDEX IF EXISTS "action_item_snoozes_clubId_snoozedUntil_idx";
--   DROP TABLE IF EXISTS "action_item_snoozes";
--   ALTER TABLE "clubs" DROP COLUMN IF EXISTS "wentLiveAt";
-- ─────────────────────────────────────────────────────────────────────────
