-- ─────────────────────────────────────────────────────────────────────────
-- 2026-08-01 · Communications Phase 3 — M19
--   EmailTemplate: reusable per-club templates (plan §3C).
-- ─────────────────────────────────────────────────────────────────────────
-- Reusable templates the owner (or messages.templates-permitted staff) can
-- author once and reuse from the composer. Plan §3C lists 14 stock kinds
-- (General Announcement, Practice Cancellation, Schedule Change, Event
-- Registration, Camp Promotion, Membership Expiration, Payment Reminder,
-- Migration Invitation, Welcome Email, Free Trial Follow-Up, Weather
-- Closure, Tournament Information, Fundraising Announcement, Custom Blank).
--
-- Seeding: LAZY on first open of the templates page (per owner decision) —
-- no data migration here. The seeder writes one row per kind for the
-- caller's club when none exist yet.
--
-- Body storage matches the Announcement model: bodyJson is canonical
-- (source of truth for editing); bodyHtml is the pre-rendered snapshot the
-- composer preview shows; bodyText is the auto-derived plain-text fallback.
-- Legacy plain-text is not needed (this is a NEW model).
--
-- archivedAt is a soft-delete — templates in use as historical origins on
-- EmailSend rows should never actually disappear.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "email_templates" (
    "id"                    TEXT NOT NULL PRIMARY KEY,
    "clubId"                TEXT NOT NULL,

    -- One of the 14 stock kinds from plan §3C, or 'CUSTOM'. Free-string
    -- enum — the app validates.
    "kind"                  TEXT NOT NULL DEFAULT 'CUSTOM',
    "name"                  TEXT NOT NULL,
    "description"           TEXT,

    -- Content.
    "subject"               TEXT NOT NULL,
    "previewText"           TEXT,
    "bodyJson"              JSONB,
    "bodyHtml"              TEXT NOT NULL,
    "bodyText"              TEXT,

    -- Defaults applied when this template is chosen in the composer (owner
    -- can still override per-send).
    "defaultFromName"       TEXT,
    "defaultReplyTo"        TEXT,
    "defaultPersonalization" JSONB,

    -- Lifecycle.
    "isSystem"              BOOLEAN NOT NULL DEFAULT false,   -- true = stock template seeded by AthletixOS (protected from delete)
    "archivedAt"            TIMESTAMP(3),
    "createdById"           TEXT NOT NULL,
    "updatedById"           TEXT,
    "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_templates_clubId_fkey"
        FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE
);

-- Per-club listing, with archived-off the default in-app filter.
CREATE INDEX IF NOT EXISTS "email_templates_clubId_archivedAt_idx"
    ON "email_templates" ("clubId", "archivedAt");
-- "Which stock template does this club have?" lookup.
CREATE INDEX IF NOT EXISTS "email_templates_clubId_kind_idx"
    ON "email_templates" ("clubId", "kind");

-- ─────────────────────────────────────────────────────────────────────────
-- ROLLBACK:
--   DROP INDEX IF EXISTS "email_templates_clubId_kind_idx";
--   DROP INDEX IF EXISTS "email_templates_clubId_archivedAt_idx";
--   DROP TABLE IF EXISTS "email_templates";
-- ─────────────────────────────────────────────────────────────────────────
