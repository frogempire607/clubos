-- ─────────────────────────────────────────────────────────────────────────
-- 2026-08-01 · Communications Phase 3 — M18
--   Announcement: lifecycle + rich body + sender + scheduling + audience.
-- ─────────────────────────────────────────────────────────────────────────
-- Today Announcement is (id, title, body, publishAt, unpublishAt, channels,
-- soft-delete). Sending is a synchronous inline loop with no dedup on the
-- send itself. This migration turns the row into a proper lifecycle record:
--
--   status: DRAFT → SCHEDULED → QUEUED → SENDING → SENT
--                    ↘ CANCELED (from any pre-SENT state)
--                    ↘ APPROVAL_REQUESTED → APPROVED (approval flow,
--                       shipped in Phase 3.5 — columns present here so we
--                       don't need another migration when approval lands)
--
-- Every existing row is backfilled:
--   publishAt IS NULL OR publishAt < now()   → SENT   (already-published)
--   publishAt >= now()                        → DRAFT (future publish — the
--                                              old model had no "scheduled
--                                              send" state; safer to treat
--                                              these as draft and force a
--                                              deliberate re-schedule than
--                                              to auto-fire on the new
--                                              scheduler)
--
-- Legacy `body` (plain-text) is preserved. New composer output lands in
-- `bodyJson` (canonical EmailBlock[] — the source of truth we can re-render)
-- and `bodyHtml` (immutable snapshot of the shipped bytes). Every reader
-- that currently pulls `body` keeps working; the new UI reads bodyJson.
--
-- audienceId is scalar-only (no FK yet). Adding the FK is a one-line ALTER
-- after M20 (marketing_audiences) is applied — but they can be applied in
-- either order without breaking, so we stay decoupled.
--
-- householdMode / audienceFilters JSON are the sender's choices captured at
-- send time — snapshot, not live — so re-sends and history reflect the
-- ACTUAL send, not the current audience config.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "announcements"
    -- Lifecycle. Free-string enum matches the paymentSource / status pattern.
    ADD COLUMN IF NOT EXISTS "status"                  TEXT NOT NULL DEFAULT 'DRAFT',
    ADD COLUMN IF NOT EXISTS "scheduledFor"            TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "sentAt"                  TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "canceledAt"              TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "canceledById"            TEXT,

    -- Sender identity. Scalar-only so a deleted staff account doesn't
    -- destroy an announcement's history.
    ADD COLUMN IF NOT EXISTS "senderUserId"            TEXT,

    -- Approval workflow (Phase 3.5). Columns present so approval can land
    -- without another migration.
    ADD COLUMN IF NOT EXISTS "approvalRequestedById"   TEXT,
    ADD COLUMN IF NOT EXISTS "approvalRequestedAt"     TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "approvedById"            TEXT,
    ADD COLUMN IF NOT EXISTS "approvedAt"              TIMESTAMP(3),

    -- Rich body. bodyJson is truth; bodyHtml is the snapshot we shipped;
    -- legacy body stays populated as plain-text fallback. bodyText is the
    -- auto-derived plain-text alternative for the multipart/alternative
    -- email.
    ADD COLUMN IF NOT EXISTS "bodyJson"                JSONB,
    ADD COLUMN IF NOT EXISTS "bodyHtml"                TEXT,
    ADD COLUMN IF NOT EXISTS "bodyText"                TEXT,
    ADD COLUMN IF NOT EXISTS "previewText"             TEXT,

    -- Audience. audienceId points at a saved marketing_audiences row (added
    -- in M20); audienceFilters is the inline audience for one-off sends,
    -- captured verbatim so history reflects the actual audience at send.
    ADD COLUMN IF NOT EXISTS "audienceId"              TEXT,
    ADD COLUMN IF NOT EXISTS "audienceFilters"         JSONB,

    -- Household delivery mode chosen by the sender (plan §3A).
    --   HOUSEHOLD           — one email per unique household address (default)
    --   PER_MEMBER          — one email per selected member (dupes to guardians
    --                          with N kids)
    --   PER_ATHLETE_PRIMARY — one email per athlete's primary contact
    ADD COLUMN IF NOT EXISTS "householdMode"           TEXT NOT NULL DEFAULT 'HOUSEHOLD',

    -- Template origin (M19). Scalar; no FK — see M16 rationale.
    ADD COLUMN IF NOT EXISTS "templateId"              TEXT,

    -- Sender identity captured at send time (from the composer). Falls back
    -- to Club.emailFromName / Club.emailReplyTo when unset.
    ADD COLUMN IF NOT EXISTS "fromName"                TEXT,
    ADD COLUMN IF NOT EXISTS "replyTo"                 TEXT,

    -- Personalization defaults applied to every recipient in this batch
    -- (per-recipient overrides live on EmailSend.personalization).
    ADD COLUMN IF NOT EXISTS "personalization"         JSONB,

    -- Link to the batch of EmailSend rows for this announcement (the same
    -- value written into every child email_sends.sendBatchId). One
    -- announcement gets one batch id — a re-send is a new announcement /
    -- new batch.
    ADD COLUMN IF NOT EXISTS "sendBatchId"             TEXT;

-- Backfill: existing rows are already-published or draft. Never auto-fire
-- a future publishAt on the new scheduler — the old model had no
-- "scheduled send", so we treat that state as DRAFT to force a deliberate
-- re-schedule from the new UI.
UPDATE "announcements"
   SET "status" = 'SENT',
       "sentAt" = COALESCE("publishAt", "createdAt")
 WHERE ("publishAt" IS NULL OR "publishAt" < CURRENT_TIMESTAMP)
   AND "status" = 'DRAFT';

-- The scheduler worker pulls (status='SCHEDULED' AND scheduledFor <= now())
-- rows on each tick.
CREATE INDEX IF NOT EXISTS "announcements_status_scheduledFor_idx"
    ON "announcements" ("clubId", "status", "scheduledFor");
CREATE INDEX IF NOT EXISTS "announcements_sendBatchId_idx"
    ON "announcements" ("sendBatchId");
CREATE INDEX IF NOT EXISTS "announcements_audienceId_idx"
    ON "announcements" ("audienceId");

-- ─────────────────────────────────────────────────────────────────────────
-- ROLLBACK:
--   DROP INDEX IF EXISTS "announcements_audienceId_idx";
--   DROP INDEX IF EXISTS "announcements_sendBatchId_idx";
--   DROP INDEX IF EXISTS "announcements_status_scheduledFor_idx";
--   ALTER TABLE "announcements"
--       DROP COLUMN IF EXISTS "sendBatchId",
--       DROP COLUMN IF EXISTS "personalization",
--       DROP COLUMN IF EXISTS "replyTo",
--       DROP COLUMN IF EXISTS "fromName",
--       DROP COLUMN IF EXISTS "templateId",
--       DROP COLUMN IF EXISTS "householdMode",
--       DROP COLUMN IF EXISTS "audienceFilters",
--       DROP COLUMN IF EXISTS "audienceId",
--       DROP COLUMN IF EXISTS "previewText",
--       DROP COLUMN IF EXISTS "bodyText",
--       DROP COLUMN IF EXISTS "bodyHtml",
--       DROP COLUMN IF EXISTS "bodyJson",
--       DROP COLUMN IF EXISTS "approvedAt",
--       DROP COLUMN IF EXISTS "approvedById",
--       DROP COLUMN IF EXISTS "approvalRequestedAt",
--       DROP COLUMN IF EXISTS "approvalRequestedById",
--       DROP COLUMN IF EXISTS "senderUserId",
--       DROP COLUMN IF EXISTS "canceledById",
--       DROP COLUMN IF EXISTS "canceledAt",
--       DROP COLUMN IF EXISTS "sentAt",
--       DROP COLUMN IF EXISTS "scheduledFor",
--       DROP COLUMN IF EXISTS "status";
--   -- (Legacy `body` column stays intact — never dropped.)
-- ─────────────────────────────────────────────────────────────────────────
