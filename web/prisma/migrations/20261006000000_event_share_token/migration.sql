-- Private share links for events (/e/s-<token>). Additive only: one new table.
-- Nothing existing is altered, so every current page keeps working whether or
-- not this has been applied; only the private-link feature itself needs it.

CREATE TABLE IF NOT EXISTS "event_share_links" (
  "id"              TEXT NOT NULL,
  "eventId"         TEXT NOT NULL,
  "clubId"          TEXT NOT NULL,
  "token"           TEXT NOT NULL,
  "createdByUserId" TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "event_share_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "event_share_links_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "event_share_links_eventId_key"
  ON "event_share_links" ("eventId");
CREATE UNIQUE INDEX IF NOT EXISTS "event_share_links_token_key"
  ON "event_share_links" ("token");
CREATE INDEX IF NOT EXISTS "event_share_links_clubId_idx"
  ON "event_share_links" ("clubId");

-- Same tenant policy as every other club table (20260702000000_enable_rls).
ALTER TABLE "event_share_links" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "event_share_links";
CREATE POLICY tenant_isolation ON "event_share_links" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK ("clubId" = app.current_club_id());
