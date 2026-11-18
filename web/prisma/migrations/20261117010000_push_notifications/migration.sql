-- ═══════════════════════════════════════════════════════════════════════════
-- Push notifications — device tokens, per-person switches, "already told them"
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ADDITIVE ONLY. Three new tables. No existing table, column or row is changed.
--
-- ORDER MATTERS: apply BEFORE deploying the code that reads it.
--
--   pg_dump first (CLAUDE.md, "Database safety"), then:
--   cd web && npx prisma migrate deploy
--
-- NOT `migrate dev`. NEVER pass a production URL to --shadow-database-url.
--
-- Until the APNs / Firebase variables are set in Netlify nothing is sent; the
-- tables only fill as phones register.
--
-- Idempotent throughout, so a partial apply can be re-run safely.

-- A phone that can receive push for one login. appId + platform record which
-- app issued the token, so a per-club branded app can use its own credentials.
CREATE TABLE IF NOT EXISTS "device_tokens" (
  "id"             TEXT NOT NULL,
  "clubId"         TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "platform"       TEXT NOT NULL,
  "appId"          TEXT NOT NULL,
  "token"          TEXT NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "disabledAt"     TIMESTAMP(3),
  "disabledReason" TEXT,
  CONSTRAINT "device_tokens_pkey" PRIMARY KEY ("id")
);
-- A token belongs to one login at a time: when someone else signs in on the
-- same phone the row moves to them instead of both receiving the other's news.
CREATE UNIQUE INDEX IF NOT EXISTS "device_tokens_appId_token_key" ON "device_tokens" ("appId", "token");
CREATE INDEX IF NOT EXISTS "device_tokens_userId_idx" ON "device_tokens" ("userId");
CREATE INDEX IF NOT EXISTS "device_tokens_clubId_idx" ON "device_tokens" ("clubId");
DO $$ BEGIN
  ALTER TABLE "device_tokens"
    ADD CONSTRAINT "device_tokens_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One person's on/off switch for one kind of push. No row means ON.
CREATE TABLE IF NOT EXISTS "notification_preferences" (
  "id"        TEXT NOT NULL,
  "clubId"    TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "type"      TEXT NOT NULL,
  "enabled"   BOOLEAN NOT NULL DEFAULT true,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "notification_preferences_userId_type_key" ON "notification_preferences" ("userId", "type");
CREATE INDEX IF NOT EXISTS "notification_preferences_clubId_idx" ON "notification_preferences" ("clubId");
DO $$ BEGIN
  ALTER TABLE "notification_preferences"
    ADD CONSTRAINT "notification_preferences_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- "Already told them." The unique index is the whole point: a reminder for one
-- membership period reaches each person once per channel, even if the hourly
-- job runs twice or two runs overlap.
CREATE TABLE IF NOT EXISTS "notification_logs" (
  "id"           TEXT NOT NULL,
  "clubId"       TEXT NOT NULL,
  "type"         TEXT NOT NULL,
  "dedupeKey"    TEXT NOT NULL,
  "recipientKey" TEXT NOT NULL,
  "channel"      TEXT NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "notification_logs_dedupeKey_recipientKey_channel_key"
  ON "notification_logs" ("dedupeKey", "recipientKey", "channel");
CREATE INDEX IF NOT EXISTS "notification_logs_clubId_type_idx" ON "notification_logs" ("clubId", "type");

-- Row-level security: each table is visible to, and writable for, its own club.
ALTER TABLE "device_tokens" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "device_tokens";
CREATE POLICY tenant_isolation ON "device_tokens" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK (
    "clubId" = app.current_club_id()
    AND EXISTS (SELECT 1 FROM "users" u WHERE u."id" = "device_tokens"."userId" AND u."clubId" = app.current_club_id())
  );

ALTER TABLE "notification_preferences" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "notification_preferences";
CREATE POLICY tenant_isolation ON "notification_preferences" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK (
    "clubId" = app.current_club_id()
    AND EXISTS (SELECT 1 FROM "users" u WHERE u."id" = "notification_preferences"."userId" AND u."clubId" = app.current_club_id())
  );

ALTER TABLE "notification_logs" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "notification_logs";
CREATE POLICY tenant_isolation ON "notification_logs" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK ("clubId" = app.current_club_id());
