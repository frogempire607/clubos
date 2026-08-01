-- ─────────────────────────────────────────────────────────────────────────
-- 2026-08-01 · Communications Phase 3 — M21
--   Club: per-club mailing address + public email/phone for the CAN-SPAM
--   email footer and the Contact block (plan.md §3B/§3F; PROGRESS.md M21).
-- ─────────────────────────────────────────────────────────────────────────
-- The pre-fix state hardcoded MC Technologies Group LLC's PO Box on every
-- club's marketing footer (see /api/emails/test-send and /api/members/bulk
-- — literal "AthletixOS · MC Technologies Group LLC · PO Box 11, Newfield,
-- NY 14867"). Legally correct as an entity address for AthletixOS itself,
-- but a lie for a club whose members expect their own operator's postal
-- address in the CAN-SPAM footer. It also blocked the Contact block from
-- ever rendering "address" — the ContactEditor UI marked the field
-- "unsupported" because the schema had no column to read from.
--
-- Public email / phone are DISTINCT from the existing contactEmail /
-- contactPhone columns. Kept separate so the owner can route inbound
-- admin/system mail to one address (contactEmail — used as email replyTo
-- fallback today) while advertising a different customer-facing address
-- in marketing footers, portal profiles, and the Contact block
-- (publicEmail). Same rationale for phone: a private ops line vs the
-- number a member should call. Renderers prefer the public* value; when
-- it's null they fall back to contact* so nothing regresses on the day
-- this migration lands.
--
-- Structured address columns (not one free-form line) because:
--   1. Future personalization tokens can bind {{club.city}}, {{club.state}},
--      {{club.zip}} in templates.
--   2. Renderers concatenate into one line for the footer without losing
--      the ability to display multi-line in the future.
--   3. Address validation and normalization can plug in later without
--      re-parsing.
--
-- All nullable. Existing rows continue to compute the way they compute
-- today: the footer falls back to the AthletixOS entity address when the
-- club has no mailing address set; the Contact block falls back to
-- contactEmail / contactPhone when the public* fields are null. Wiring
-- lands in a follow-up commit after this migration is applied.
--
-- No backfill. Clubs will fill these fields via Settings → Club after
-- deploy. The fallback chain keeps every existing send compliant with
-- CAN-SPAM until each owner completes their information.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "clubs"
    ADD COLUMN IF NOT EXISTS "mailingAddress"  TEXT,
    ADD COLUMN IF NOT EXISTS "mailingAddress2" TEXT,
    ADD COLUMN IF NOT EXISTS "mailingCity"     TEXT,
    ADD COLUMN IF NOT EXISTS "mailingState"    TEXT,
    ADD COLUMN IF NOT EXISTS "mailingZip"      TEXT,
    ADD COLUMN IF NOT EXISTS "mailingCountry"  TEXT,
    ADD COLUMN IF NOT EXISTS "publicEmail"     TEXT,
    ADD COLUMN IF NOT EXISTS "publicPhone"     TEXT;

-- ─────────────────────────────────────────────────────────────────────────
-- ROLLBACK:
--   ALTER TABLE "clubs"
--       DROP COLUMN IF EXISTS "publicPhone",
--       DROP COLUMN IF EXISTS "publicEmail",
--       DROP COLUMN IF EXISTS "mailingCountry",
--       DROP COLUMN IF EXISTS "mailingZip",
--       DROP COLUMN IF EXISTS "mailingState",
--       DROP COLUMN IF EXISTS "mailingCity",
--       DROP COLUMN IF EXISTS "mailingAddress2",
--       DROP COLUMN IF EXISTS "mailingAddress";
-- ─────────────────────────────────────────────────────────────────────────
