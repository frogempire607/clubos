-- ─────────────────────────────────────────────────────────────────────────
-- 2026-08-01 · Communications Phase 3 — M16
--   EmailSend: per-recipient delivery log.
-- ─────────────────────────────────────────────────────────────────────────
-- One row per email dispatch (marketing, transactional, template-driven,
-- announcement blast, Members-page bulk). This is the source of truth for:
--   - 3G history on the member profile (subject, sender, status, opens,
--     clicks, bounces, unsubscribes).
--   - Campaign-level results on the Communications page.
--   - Double-send prevention under retry / refresh / job restart / repeated
--     clicks (per plan §3H, §3K).
--
-- The @@unique([sendBatchId, dedupeKey]) constraint is the structural
-- guarantee. The caller sets `dedupeKey` per household-mode:
--   HOUSEHOLD           → dedupeKey = lower(recipientEmail)
--   PER_MEMBER          → dedupeKey = lower(recipientEmail) || ':' || memberId
--   PER_ATHLETE_PRIMARY → dedupeKey = lower(recipientEmail) || ':' || athleteMemberId
-- so a guardian with two athletes writes ONE row in HOUSEHOLD mode and TWO
-- rows in PER_MEMBER / PER_ATHLETE_PRIMARY without silently failing the
-- second insert. The unique index only fires within a single sendBatchId,
-- so different campaigns to the same address don't collide.
--
-- Nullable timestamps for provider events (delivered/opened/bounced/clicked)
-- exist so we never fabricate them — an SMTP-only send leaves them null and
-- 3G history correctly renders "delivery unknown" instead of a false "opened".
--
-- No FKs to Announcement/Campaign/EmailTemplate on the origin columns:
--   - Announcement / Campaign already exist and would work, but keeping the
--     link scalar-only lets us delete an origin row later without losing the
--     send history (matches the pattern used for Transaction.eventId).
--   - EmailTemplate FK deferred until the template model lands (M19); adding
--     it later is a one-line ALTER.
--
-- Additive throughout. No existing table is touched.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "email_sends" (
    "id"                    TEXT NOT NULL PRIMARY KEY,
    "clubId"                TEXT NOT NULL,

    -- Origin — exactly one of these three is set per row. Scalar-only (no FK)
    -- so history survives origin-row deletion.
    "announcementId"        TEXT,
    "campaignId"            TEXT,
    "templateId"            TEXT,

    -- Classification. Free-string enum in the DB (matches paymentSource /
    -- reconciliationStatus pattern). App-level values include:
    --   MARKETING      — subject to EmailOptOut(scope='MARKETING') suppression
    --   TRANSACTIONAL  — receipts, password resets, booking confirmations
    --   ANNOUNCEMENT   — /dashboard/announcements blasts
    --   BULK           — Members-page "Email selected"
    --   TEMPLATE       — sent from an EmailTemplate
    "kind"                  TEXT NOT NULL,

    -- Delivery target. recipientEmail is lower-cased at write time so
    -- unique-key lookups and EmailOptOut joins are exact matches.
    "recipientEmail"        TEXT NOT NULL,
    "recipientUserId"       TEXT,
    "recipientMemberId"     TEXT,

    -- Immutable content snapshot AFTER personalization. bodyJson is the
    -- canonical block structure the composer emitted (source of truth for
    -- re-rendering later); bodyHtml is the exact bytes we shipped to the
    -- provider (source of truth for the recipient's inbox).
    "subject"               TEXT NOT NULL,
    "bodyJson"              JSONB,
    "bodyHtml"              TEXT NOT NULL,
    "bodyText"              TEXT,
    "fromName"              TEXT,
    "fromEmail"             TEXT,
    "replyTo"               TEXT,
    "personalization"       JSONB,

    -- Lifecycle. QUEUED → SENT (provider accepted) → DELIVERED / BOUNCED /
    -- COMPLAINED. SKIPPED (with skippedReason) never leaves the queue —
    -- e.g. no-email, opted-out, invalid-address, duplicate-in-batch.
    "status"                TEXT NOT NULL DEFAULT 'QUEUED',
    "skippedReason"         TEXT,
    "providerMessageId"     TEXT,
    "error"                 TEXT,
    "queuedAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt"                TIMESTAMP(3),
    "deliveredAt"           TIMESTAMP(3),
    "bouncedAt"             TIMESTAMP(3),
    -- OPENED / CLICKED only populated when the provider supports tracking
    -- AND the recipient's client honors it. Null means "unknown" — the UI
    -- must never render "opened" from a null value.
    "openedAt"              TIMESTAMP(3),
    "openCount"             INTEGER NOT NULL DEFAULT 0,
    "clickedAt"             TIMESTAMP(3),
    "clickCount"            INTEGER NOT NULL DEFAULT 0,

    -- Dedup / idempotency.
    -- sendBatchId groups every EmailSend row from ONE campaign / announcement
    -- / bulk action; dedupeKey (see header comment) makes the second insert a
    -- unique-violation instead of a silent duplicate send.
    "sendBatchId"           TEXT,
    "dedupeKey"             TEXT,
    "idempotencyKey"        TEXT,

    "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_sends_clubId_fkey"
        FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE
);

-- Timeline queries on the Communications results page.
CREATE INDEX IF NOT EXISTS "email_sends_clubId_queuedAt_idx"
    ON "email_sends" ("clubId", "queuedAt");
-- Campaign-level rollups.
CREATE INDEX IF NOT EXISTS "email_sends_announcementId_idx"
    ON "email_sends" ("announcementId");
CREATE INDEX IF NOT EXISTS "email_sends_campaignId_idx"
    ON "email_sends" ("campaignId");
-- Member profile "Communications" tab (3G).
CREATE INDEX IF NOT EXISTS "email_sends_recipientMemberId_queuedAt_idx"
    ON "email_sends" ("recipientMemberId", "queuedAt");
-- Bounce / opt-out lookup by address (also used to surface "this address
-- has bounced N times" in the composer preview).
CREATE INDEX IF NOT EXISTS "email_sends_recipientEmail_queuedAt_idx"
    ON "email_sends" ("recipientEmail", "queuedAt");
-- Queue worker pulls QUEUED rows ordered by queuedAt.
CREATE INDEX IF NOT EXISTS "email_sends_status_queuedAt_idx"
    ON "email_sends" ("status", "queuedAt");
-- Provider webhook lookup ("event about providerMessageId X → find row").
CREATE INDEX IF NOT EXISTS "email_sends_providerMessageId_idx"
    ON "email_sends" ("providerMessageId");

-- The structural double-send guarantee. Partial index (only where both
-- columns are non-null) so ad-hoc / one-off sends without a batch don't
-- collide across time.
CREATE UNIQUE INDEX IF NOT EXISTS "email_sends_sendBatch_dedupeKey_key"
    ON "email_sends" ("sendBatchId", "dedupeKey")
    WHERE "sendBatchId" IS NOT NULL AND "dedupeKey" IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- ROLLBACK:
--   DROP INDEX IF EXISTS "email_sends_sendBatch_dedupeKey_key";
--   DROP INDEX IF EXISTS "email_sends_providerMessageId_idx";
--   DROP INDEX IF EXISTS "email_sends_status_queuedAt_idx";
--   DROP INDEX IF EXISTS "email_sends_recipientEmail_queuedAt_idx";
--   DROP INDEX IF EXISTS "email_sends_recipientMemberId_queuedAt_idx";
--   DROP INDEX IF EXISTS "email_sends_campaignId_idx";
--   DROP INDEX IF EXISTS "email_sends_announcementId_idx";
--   DROP INDEX IF EXISTS "email_sends_clubId_queuedAt_idx";
--   DROP TABLE IF EXISTS "email_sends";
-- ─────────────────────────────────────────────────────────────────────────
