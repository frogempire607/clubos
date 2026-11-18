-- ═══════════════════════════════════════════════════════════════════════════
-- Sign in with Google / Sign in with Apple — linked sign-in methods
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ADDITIVE ONLY. One new table. No existing table, column or row is changed.
--
-- ORDER MATTERS: apply BEFORE deploying the code that reads it.
--
--   pg_dump first (CLAUDE.md, "Database safety"), then:
--   cd web && npx prisma migrate deploy
--
-- NOT `migrate dev`. NEVER pass a production URL to --shadow-database-url.
--
-- Until the Google / Apple variables are set in Netlify the buttons do not
-- appear and nothing writes to this table.
--
-- `refreshTokenEnc` holds an Apple refresh token as AES-256-GCM ciphertext
-- (FIELD_ENCRYPTION_KEY, already set). It exists for one purpose: revoking the
-- token when the person deletes their account, which Apple requires.
--
-- Idempotent throughout, so a partial apply can be re-run safely.

CREATE TABLE IF NOT EXISTS "user_identities" (
  "id"              TEXT NOT NULL,
  "userId"          TEXT NOT NULL,
  "clubId"          TEXT NOT NULL,
  "provider"        TEXT NOT NULL,
  "providerSubject" TEXT NOT NULL,
  "email"           TEXT,
  "emailIsRelay"    BOOLEAN NOT NULL DEFAULT false,
  "refreshTokenEnc" TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt"      TIMESTAMP(3),
  CONSTRAINT "user_identities_pkey" PRIMARY KEY ("id")
);

-- One Google (or Apple) person maps to at most one account per club. This is
-- what stops the same Google account being attached to two logins.
CREATE UNIQUE INDEX IF NOT EXISTS "user_identities_clubId_provider_providerSubject_key"
  ON "user_identities" ("clubId", "provider", "providerSubject");
CREATE INDEX IF NOT EXISTS "user_identities_userId_idx" ON "user_identities" ("userId");

DO $$ BEGIN
  ALTER TABLE "user_identities"
    ADD CONSTRAINT "user_identities_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Row-level security, same shape as every table since the RLS rollout: a row
-- is visible to its own club only, and may only be written for a user who
-- belongs to that club.
ALTER TABLE "user_identities" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "user_identities";
CREATE POLICY tenant_isolation ON "user_identities" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK (
    "clubId" = app.current_club_id()
    AND EXISTS (
      SELECT 1 FROM "users" u
      WHERE u."id" = "user_identities"."userId"
        AND u."clubId" = app.current_club_id()
    )
  );
