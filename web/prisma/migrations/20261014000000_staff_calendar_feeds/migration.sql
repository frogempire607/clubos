-- Branch 3 — per-coach calendar subscription links. ADDITIVE: one new table,
-- nothing existing is changed. (Private-lesson pay lines and the CSV export
-- need no schema change: they use pay_lines as it is.)
CREATE TABLE IF NOT EXISTS "staff_calendar_feeds" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMP(3),
    "rotatedByUserId" TEXT,
    "lastAccessedAt" TIMESTAMP(3),

    CONSTRAINT "staff_calendar_feeds_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "staff_calendar_feeds_userId_key" ON "staff_calendar_feeds"("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "staff_calendar_feeds_token_key" ON "staff_calendar_feeds"("token");
CREATE INDEX IF NOT EXISTS "staff_calendar_feeds_clubId_idx" ON "staff_calendar_feeds"("clubId");

DO $$ BEGIN
  ALTER TABLE "staff_calendar_feeds" ADD CONSTRAINT "staff_calendar_feeds_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Row level security: same tenant policy as every other club table.
ALTER TABLE "staff_calendar_feeds" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "staff_calendar_feeds";
CREATE POLICY tenant_isolation ON "staff_calendar_feeds" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK ("clubId" = app.current_club_id());
