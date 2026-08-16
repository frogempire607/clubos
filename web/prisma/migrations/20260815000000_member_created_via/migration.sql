-- Member.createdVia — how this athlete record came to exist.
--
-- WRITTEN BUT NOT APPLIED (plan §7.2 / Schema). Julian applies it:
--     cd web && npx prisma migrate deploy
--
-- WHY: today the only way to tell how a member was created is to infer it from
-- migrationStatus and timestamps. The whole §7.0 audit had to be done that way,
-- which is how "3 of the 4 self-guardian members appeared in the last 24 days"
-- took a morning to establish instead of a query. §7.2 now creates members from
-- four genuinely different paths; recording which one is what makes the next
-- audit a SELECT.
--
-- Values (free text, validated in application code — deliberately NOT a
-- Postgres enum, so a new signup path doesn't need a migration to be legible):
--     ADULT_SELF         member portal signup, the signer is the athlete
--     CHILD_BY_GUARDIAN  member portal signup, a guardian added their child
--     STAFF              created on /dashboard/members by owner or staff
--     IMPORT             CSV migration import
--     ACTIVATION         created during /activate/[token]
--
-- SAFETY: additive and nullable. No backfill — every existing row stays NULL,
-- which reads correctly as "created before this column existed". Inferring a
-- value for 287 historical rows would manufacture the same guesswork this
-- column exists to end.
--
-- ORDER OF OPERATIONS — this matters, do not shortcut it:
--   1. Apply this migration (adds the column to the database).
--   2. ONLY THEN add `createdVia String?` to Member in prisma/schema.prisma and
--      start writing it from the signup / import / staff-create paths.
-- `schema.prisma` is deliberately UNCHANGED in this commit. Prisma selects every
-- scalar field a model declares, so a schema that names a column the database
-- does not have makes EVERY member read fail with
-- "column members.createdVia does not exist" the moment it deploys. Adding the
-- field before the column exists would take the whole app down, not just the
-- signup path.

ALTER TABLE "members" ADD COLUMN IF NOT EXISTS "createdVia" TEXT;

CREATE INDEX IF NOT EXISTS "members_clubId_createdVia_idx" ON "members" ("clubId", "createdVia");
