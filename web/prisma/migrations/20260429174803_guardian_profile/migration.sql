-- Normalize guardian data into a profile table without assuming inline
-- guardian columns already exist.
--
-- Fresh migration history:
--   - 20260425040936_init creates "guardians" as the legacy User <-> Member
--     join table.
--   - This migration renames that table to "member_guardian_users", creates
--     the new guardian profile table, and links members by "guardianId".
--
-- Existing databases:
--   - Some environments received inline member guardian columns via db push.
--   - Backfill runs only when "members"."guardianEmail" existed before this
--     migration started. Missing columns are added for the final Prisma schema
--     but are not treated as proof that backfill data exists.

CREATE TEMP TABLE "_guardian_profile_migration_state" AS
SELECT
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'members'
      AND column_name = 'guardianEmail'
  ) AS had_guardian_email,
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'members'
      AND column_name = 'isMinor'
  ) AS had_is_minor;

-- Preserve the legacy User <-> Member join table if it is still named
-- "guardians". Only rename when the table has the legacy shape.
DO $$
BEGIN
  IF to_regclass('public.guardians') IS NOT NULL
     AND to_regclass('public.member_guardian_users') IS NULL
     AND EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'guardians'
         AND column_name = 'memberId'
     )
     AND NOT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'guardians'
         AND column_name = 'clubId'
     ) THEN
    ALTER TABLE "guardians" RENAME TO "member_guardian_users";
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "member_guardian_users" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "relationship" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "member_guardian_users_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'guardians_pkey'
      AND conrelid = 'public.member_guardian_users'::regclass
  ) THEN
    ALTER TABLE "member_guardian_users"
      RENAME CONSTRAINT "guardians_pkey" TO "member_guardian_users_pkey";
  END IF;
END $$;

DROP INDEX IF EXISTS "guardians_userId_memberId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "member_guardian_users_userId_memberId_key"
  ON "member_guardian_users"("userId", "memberId");

ALTER TABLE "member_guardian_users"
  DROP CONSTRAINT IF EXISTS "guardians_userId_fkey",
  DROP CONSTRAINT IF EXISTS "guardians_memberId_fkey";

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'member_guardian_users_userId_fkey'
      AND conrelid = 'public.member_guardian_users'::regclass
  ) THEN
    ALTER TABLE "member_guardian_users"
      ADD CONSTRAINT "member_guardian_users_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'member_guardian_users_memberId_fkey'
      AND conrelid = 'public.member_guardian_users'::regclass
  ) THEN
    ALTER TABLE "member_guardian_users"
      ADD CONSTRAINT "member_guardian_users_memberId_fkey"
      FOREIGN KEY ("memberId") REFERENCES "members"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Inline member guardian fields remain in the Prisma schema for compatibility.
-- Add them for fresh databases, but do not use newly-created empty columns as
-- a signal to backfill.
ALTER TABLE "members"
  ADD COLUMN IF NOT EXISTS "isMinor" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "guardianName" TEXT,
  ADD COLUMN IF NOT EXISTS "guardianEmail" TEXT,
  ADD COLUMN IF NOT EXISTS "guardianPhone" TEXT,
  ADD COLUMN IF NOT EXISTS "guardianRelationship" TEXT;

CREATE TABLE IF NOT EXISTS "guardians" (
  "id" TEXT NOT NULL,
  "clubId" TEXT NOT NULL,
  "firstName" TEXT NOT NULL,
  "lastName" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "userId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "guardians_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "guardians_userId_key" ON "guardians"("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "guardians_clubId_email_key" ON "guardians"("clubId", "email");
CREATE INDEX IF NOT EXISTS "guardians_clubId_idx" ON "guardians"("clubId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'guardians_clubId_fkey'
      AND conrelid = 'public.guardians'::regclass
  ) THEN
    ALTER TABLE "guardians"
      ADD CONSTRAINT "guardians_clubId_fkey"
      FOREIGN KEY ("clubId") REFERENCES "clubs"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'guardians_userId_fkey'
      AND conrelid = 'public.guardians'::regclass
  ) THEN
    ALTER TABLE "guardians"
      ADD CONSTRAINT "guardians_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "members" ADD COLUMN IF NOT EXISTS "guardianId" TEXT;
CREATE INDEX IF NOT EXISTS "members_guardianId_idx" ON "members"("guardianId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'members_guardianId_fkey'
      AND conrelid = 'public.members'::regclass
  ) THEN
    ALTER TABLE "members"
      ADD CONSTRAINT "members_guardianId_fkey"
      FOREIGN KEY ("guardianId") REFERENCES "guardians"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Backfill only if the source email column existed before this migration.
-- The SQL is dynamic and guarded so databases without legacy inline columns do
-- not parse or execute references to missing source columns.
DO $$
DECLARE
  should_backfill BOOLEAN;
  should_require_minor BOOLEAN;
  minor_filter TEXT;
BEGIN
  SELECT had_guardian_email, had_is_minor
  INTO should_backfill, should_require_minor
  FROM "_guardian_profile_migration_state";

  IF NOT should_backfill THEN
    RETURN;
  END IF;

  minor_filter := CASE
    WHEN should_require_minor THEN 'AND m."isMinor" = true'
    ELSE ''
  END;

  EXECUTE '
    INSERT INTO "guardians" ("id", "clubId", "firstName", "lastName", "email", "phone", "createdAt", "updatedAt")
    SELECT
      ''g_bf_'' || md5(m."clubId" || ''|'' || lower(m."guardianEmail")) AS "id",
      m."clubId",
      COALESCE(NULLIF(split_part(m."guardianName", '' '', 1), ''''), ''Guardian'') AS "firstName",
      COALESCE(NULLIF(regexp_replace(m."guardianName", ''^[^ ]+\s*'', ''''), ''''), '''') AS "lastName",
      lower(m."guardianEmail") AS "email",
      COALESCE(m."guardianPhone", '''') AS "phone",
      NOW(),
      NOW()
    FROM "members" m
    WHERE m."guardianEmail" IS NOT NULL
      AND m."guardianEmail" <> ''''
      ' || minor_filter || '
    ON CONFLICT ("clubId", "email") DO NOTHING';

  EXECUTE '
    UPDATE "members" m
    SET "guardianId" = g."id"
    FROM "guardians" g
    WHERE m."guardianEmail" IS NOT NULL
      AND m."guardianEmail" <> ''''
      ' || minor_filter || '
      AND g."clubId" = m."clubId"
      AND g."email" = lower(m."guardianEmail")';
END $$;
