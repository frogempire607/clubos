-- ─────────────────────────────────────────────────────────────────────────
-- 2026-08-02 · Communications Phase 3 — M22
--   Everything the REMAINDER of Phase 3 (3C–3N) needs at the schema level.
--   Bundled into one migration so the operator applies once.
-- ─────────────────────────────────────────────────────────────────────────
-- Audit trail: plan.md §3G says the member-profile Communications tab
-- must show "Sender" + "Related event or membership". Announcement-driven
-- sends can derive `sender` via Announcement.senderUserId, but direct /
-- bulk / DM sends have no announcement — persisting the actor on
-- EmailSend unblocks the display for every path.
--
-- Related event / membership are optional context columns — set when the
-- send is contextually tied to one of those objects (event registration
-- confirmation, membership renewal reminder). Loose reference (no FK) so
-- deleting the event or membership doesn't destroy send history.
--
-- Plan §3I says: "keep an audit log of preference changes". EmailOptOut
-- today is one row per (clubId, email) — every add/change overwrites
-- history. The new EmailOptOutAudit table captures every SUBSCRIBE /
-- UNSUBSCRIBE action with actor + source so we can answer:
--   • when did this address unsubscribe?
--   • which staff/user/link triggered it?
--   • has this address flipped back and forth?
--
-- All changes additive, all nullable, no backfill. Existing rows keep
-- working; new features light up as they wire in.
-- ─────────────────────────────────────────────────────────────────────────

-- 1) EmailSend gains 3 nullable context columns.
ALTER TABLE "email_sends"
    ADD COLUMN IF NOT EXISTS "sentByUserId"        TEXT,
    ADD COLUMN IF NOT EXISTS "relatedEventId"      TEXT,
    ADD COLUMN IF NOT EXISTS "relatedMembershipId" TEXT;

-- Timeline lookups on the profile Communications tab filter by the
-- related object; add indexes so "all emails about event X" and "all
-- emails about membership Y" stay fast at scale.
CREATE INDEX IF NOT EXISTS "email_sends_relatedEventId_queuedAt_idx"
    ON "email_sends" ("relatedEventId", "queuedAt");
CREATE INDEX IF NOT EXISTS "email_sends_relatedMembershipId_queuedAt_idx"
    ON "email_sends" ("relatedMembershipId", "queuedAt");
CREATE INDEX IF NOT EXISTS "email_sends_sentByUserId_queuedAt_idx"
    ON "email_sends" ("sentByUserId", "queuedAt");

-- 2) EmailOptOutAudit — append-only preference-change log.
--    One row per SUBSCRIBE / UNSUBSCRIBE action (see the header comment).
--    Never updated; overwrites in email_opt_outs are captured here as a
--    new audit row so historical state is reconstructable.
CREATE TABLE IF NOT EXISTS "email_opt_out_audits" (
    "id"           TEXT NOT NULL PRIMARY KEY,
    "clubId"       TEXT NOT NULL,
    -- The address that was un/subscribed. Lower-cased at write time to
    -- match the EmailOptOut convention.
    "email"        TEXT NOT NULL,
    -- The User row associated with the email at the time of the action
    -- (nullable — anti-abuse HMAC unsubscribes don't require a login).
    "userId"       TEXT,
    -- Scope the action applied to: MARKETING | TRANSACTIONAL | ALL.
    "scope"        TEXT NOT NULL,
    -- What actually happened: SUBSCRIBE | UNSUBSCRIBE.
    -- SUBSCRIBE = a previously-opted-out address opted back in.
    -- UNSUBSCRIBE = a new opt-out row (or a scope change on an existing).
    "action"       TEXT NOT NULL,
    -- Where the change originated:
    --   UNSUBSCRIBE_LINK | ADMIN | BOUNCE | COMPLAINT | IMPORT | API
    "source"       TEXT NOT NULL,
    -- The user who took the action, when known. Null for anonymous
    -- unsubscribe-link clicks and provider webhook events (BOUNCE / COMPLAINT).
    "actorUserId"  TEXT,
    -- OWNER | STAFF | MEMBER | PROVIDER | ANONYMOUS — cheap breadcrumb
    -- so a reader doesn't have to re-join actorUserId to figure out who
    -- did what.
    "actorRole"    TEXT,
    -- Free-form context (IP, user agent, provider message ID for
    -- bounce/complaint, admin note). Never PII beyond what's already in
    -- the row above.
    "context"      JSONB,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_opt_out_audits_clubId_fkey"
        FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE
);

-- Per-address timeline (the primary lookup on the member profile).
CREATE INDEX IF NOT EXISTS "email_opt_out_audits_clubId_email_createdAt_idx"
    ON "email_opt_out_audits" ("clubId", "email", "createdAt");
-- Compliance queries: "show every opt-out action across the club since X".
CREATE INDEX IF NOT EXISTS "email_opt_out_audits_clubId_createdAt_idx"
    ON "email_opt_out_audits" ("clubId", "createdAt");

-- ─────────────────────────────────────────────────────────────────────────
-- ROLLBACK:
--   DROP INDEX IF EXISTS "email_opt_out_audits_clubId_createdAt_idx";
--   DROP INDEX IF EXISTS "email_opt_out_audits_clubId_email_createdAt_idx";
--   DROP TABLE IF EXISTS "email_opt_out_audits";
--   DROP INDEX IF EXISTS "email_sends_sentByUserId_queuedAt_idx";
--   DROP INDEX IF EXISTS "email_sends_relatedMembershipId_queuedAt_idx";
--   DROP INDEX IF EXISTS "email_sends_relatedEventId_queuedAt_idx";
--   ALTER TABLE "email_sends"
--       DROP COLUMN IF EXISTS "relatedMembershipId",
--       DROP COLUMN IF EXISTS "relatedEventId",
--       DROP COLUMN IF EXISTS "sentByUserId";
-- ─────────────────────────────────────────────────────────────────────────
