-- B21 staff profile. Additive only: one nullable column + one new table.
ALTER TABLE "staff_profiles" ADD COLUMN IF NOT EXISTS "phone" TEXT;

CREATE TABLE IF NOT EXISTS "staff_activity" (
  "id"          TEXT NOT NULL,
  "clubId"      TEXT NOT NULL,
  "staffUserId" TEXT NOT NULL,
  "actorUserId" TEXT,
  "actorName"   TEXT,
  "kind"        TEXT NOT NULL,
  "summary"     TEXT NOT NULL,
  "selfMade"    BOOLEAN NOT NULL DEFAULT false,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "staff_activity_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "staff_activity_clubId_staffUserId_createdAt_idx"
  ON "staff_activity" ("clubId", "staffUserId", "createdAt");

-- Same tenant policy as every other club table (20260702000000_enable_rls).
ALTER TABLE "staff_activity" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "staff_activity";
CREATE POLICY tenant_isolation ON "staff_activity" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK ("clubId" = app.current_club_id());
