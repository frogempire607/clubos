-- ─────────────────────────────────────────────────────────────────────────
-- 2026-08-01 · Communications Phase 3 — M20
--   MarketingAudience: reusable recipient groups (plan §3D).
-- ─────────────────────────────────────────────────────────────────────────
-- Owner or authorized staff builds recipient groups from filters (plan
-- §3D). Saved as a first-class row so:
--   - The composer can pick "audience: <name>" without rebuilding filters.
--   - The Members page can select "everyone in this audience".
--   - The audience name lands on Announcement.audienceId (M18) as the
--     origin of every EmailSend row.
--
-- Dynamic vs static:
--   - isDynamic = true  → filters JSON is evaluated at send time; new
--                          members who now match get the message. This is
--                          the plan §3D "saved dynamic groups update
--                          automatically" behavior.
--   - isDynamic = false → frozenMemberIds is the exact list, captured once
--                          from the filters at save time. Useful for
--                          "these specific 30 people" one-off audiences.
--
-- Filters JSON is the canonical AudienceFilter DSL — the same shape read
-- by /api/messages/audience today, extended in 3D. Structure:
--   {
--     match: 'ALL' | 'ANY',
--     rules: [
--       { field: 'membershipStatus', op: 'in', value: ['ACTIVE'] },
--       { field: 'lastAttendedDaysAgo', op: 'gte', value: 14 },
--       { field: 'membershipEndsWithinDays', op: 'lte', value: 30 },
--       ...
--     ]
--   }
--
-- No FK from Announcement.audienceId back here — see M18 header.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "marketing_audiences" (
    "id"                TEXT NOT NULL PRIMARY KEY,
    "clubId"            TEXT NOT NULL,
    "name"              TEXT NOT NULL,
    "description"       TEXT,

    -- Canonical AudienceFilter DSL. See header comment above.
    "filters"           JSONB NOT NULL DEFAULT '{}',
    "isDynamic"         BOOLEAN NOT NULL DEFAULT true,
    -- Only populated when isDynamic=false. JSON array of member IDs.
    "frozenMemberIds"   JSONB,

    -- Estimated recipient count captured at last evaluation. Cheap for the
    -- audience list UI; the composer re-evaluates for the actual send.
    "estimatedCount"    INTEGER,
    "estimatedAt"       TIMESTAMP(3),

    -- Lifecycle. Soft-delete only — historical Announcement.audienceId
    -- pointers must resolve to the audience's name even after "delete".
    "archivedAt"        TIMESTAMP(3),
    "createdById"       TEXT NOT NULL,
    "updatedById"       TEXT,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_audiences_clubId_fkey"
        FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE
);

-- Per-club listing, archived-off by default.
CREATE INDEX IF NOT EXISTS "marketing_audiences_clubId_archivedAt_idx"
    ON "marketing_audiences" ("clubId", "archivedAt");
-- Name uniqueness per club (case-insensitive). Enforce in app; DB stays
-- case-sensitive so the owner can rename later.
CREATE INDEX IF NOT EXISTS "marketing_audiences_clubId_name_idx"
    ON "marketing_audiences" ("clubId", "name");

-- ─────────────────────────────────────────────────────────────────────────
-- ROLLBACK:
--   DROP INDEX IF EXISTS "marketing_audiences_clubId_name_idx";
--   DROP INDEX IF EXISTS "marketing_audiences_clubId_archivedAt_idx";
--   DROP TABLE IF EXISTS "marketing_audiences";
-- ─────────────────────────────────────────────────────────────────────────
