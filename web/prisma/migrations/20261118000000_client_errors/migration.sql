-- ═══════════════════════════════════════════════════════════════════════════
-- Client errors — one row each time a screen crashes in someone's browser
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Crash audit 2026-11-18 (docs/CRASH-AUDIT-2026-11-18.md): the staff profile
-- and the import wizard showed the error screen on every open and nothing,
-- anywhere, recorded it. This table is where the error screen now writes.
--
-- ADDITIVE ONLY. One new table. No existing table, column or row is changed.
--
-- ORDER: apply BEFORE or AFTER the code — either is safe. The endpoint that
-- writes here swallows a failed insert (and still prints the error to the
-- function log), so the code runs correctly while the table does not exist.
-- Nothing is recorded until it does.
--
--   pg_dump first (CLAUDE.md, "Database safety"), then:
--   cd web && npx prisma migrate deploy
--
-- NOT `migrate dev`. NEVER pass a production URL to --shadow-database-url.
--
-- What a row holds: which screen (the address with ids and tokens replaced),
-- the error text and stack, the kind of account (role) and — when signed in —
-- the user and club ids. No names, no emails, no member data, no IP address.
-- No foreign keys on purpose: a report must be storable for someone who is
-- signed out, and must survive the account it came from being deleted.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS "client_errors" (
  "id"          TEXT NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source"      TEXT NOT NULL,
  "path"        TEXT NOT NULL,
  "message"     TEXT NOT NULL,
  "stack"       TEXT,
  "digest"      TEXT,
  "fingerprint" TEXT NOT NULL,
  "clubId"      TEXT,
  "userId"      TEXT,
  "role"        TEXT,
  "userAgent"   TEXT,
  "viewport"    TEXT,
  "release"     TEXT,
  CONSTRAINT "client_errors_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "client_errors_createdAt_idx" ON "client_errors" ("createdAt");
CREATE INDEX IF NOT EXISTS "client_errors_clubId_createdAt_idx" ON "client_errors" ("clubId", "createdAt");
CREATE INDEX IF NOT EXISTS "client_errors_fingerprint_idx" ON "client_errors" ("fingerprint");
