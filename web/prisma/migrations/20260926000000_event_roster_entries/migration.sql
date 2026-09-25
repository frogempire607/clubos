-- B16 slice 2 — roster positions and registration entries. Additive only:
-- three new tables and five new columns on events, every existing row
-- untouched (defaults false / null). One migration for all of B16, so the
-- multiple-entries slice needs no second one.
--
-- Rosters are the columns of the coach's grid (divisions, skill levels…),
-- positions the rows (weights, positions…). A registration's ENTRIES are the
-- spots it asked for; the registration stays the money spine and entries carry
-- no money. Capacity is per cell: a position's capacity applies inside each
-- roster separately.

CREATE TABLE IF NOT EXISTS "event_rosters" (
  "id"        TEXT NOT NULL,
  "eventId"   TEXT NOT NULL,
  "label"     TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "event_rosters_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "event_rosters_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "event_rosters_eventId_idx" ON "event_rosters"("eventId");

CREATE TABLE IF NOT EXISTS "event_roster_positions" (
  "id"        TEXT NOT NULL,
  "eventId"   TEXT NOT NULL,
  "label"     TEXT NOT NULL,
  -- Per cell (this position inside each roster). NULL = unlimited.
  "capacity"  INTEGER,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "event_roster_positions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "event_roster_positions_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "event_roster_positions_eventId_idx" ON "event_roster_positions"("eventId");

CREATE TABLE IF NOT EXISTS "event_registration_entries" (
  "id"             TEXT NOT NULL,
  "registrationId" TEXT NOT NULL,
  "eventId"        TEXT NOT NULL,
  "clubId"         TEXT NOT NULL,
  -- SET NULL, never cascade: removing a roster or position that entries use is
  -- refused by the API, and a hard event delete cascades through eventId.
  "rosterId"       TEXT,
  "positionId"     TEXT,
  -- Per-entry answers (slice 3). Registration-level answers stay on
  -- event_registrations.formResponses.
  "answers"        JSONB NOT NULL DEFAULT '{}',
  -- ACTIVE (holds or requests the spot) | WAITLIST (asked for a full spot) | DROPPED
  "status"         TEXT NOT NULL DEFAULT 'ACTIVE',
  "sortOrder"      INTEGER NOT NULL DEFAULT 0,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "event_registration_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "event_registration_entries_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "event_registrations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "event_registration_entries_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "event_registration_entries_rosterId_fkey" FOREIGN KEY ("rosterId") REFERENCES "event_rosters"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "event_registration_entries_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "event_roster_positions"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "event_registration_entries_registrationId_idx" ON "event_registration_entries"("registrationId");
CREATE INDEX IF NOT EXISTS "event_registration_entries_cell_idx" ON "event_registration_entries"("eventId", "rosterId", "positionId");
CREATE INDEX IF NOT EXISTS "event_registration_entries_clubId_idx" ON "event_registration_entries"("clubId");

ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "allowMultipleEntries" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "maxEntries" INTEGER;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "additionalEntryPrice" DECIMAL(10,2);
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "allowSameRosterTwice" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "entriesOnPublicLink" BOOLEAN NOT NULL DEFAULT false;

-- Tenant isolation, the same shape as event_sessions / event_registrations
-- (20260702000000_enable_rls). The app's main client connects as the table
-- owner and is unaffected; this closes the tables to Supabase's API roles.
ALTER TABLE "event_rosters" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "event_rosters";
CREATE POLICY tenant_isolation ON "event_rosters" FOR ALL
  USING (EXISTS (SELECT 1 FROM events e WHERE e.id = "event_rosters"."eventId" AND e."clubId" = app.current_club_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM events e WHERE e.id = "event_rosters"."eventId" AND e."clubId" = app.current_club_id()));

ALTER TABLE "event_roster_positions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "event_roster_positions";
CREATE POLICY tenant_isolation ON "event_roster_positions" FOR ALL
  USING (EXISTS (SELECT 1 FROM events e WHERE e.id = "event_roster_positions"."eventId" AND e."clubId" = app.current_club_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM events e WHERE e.id = "event_roster_positions"."eventId" AND e."clubId" = app.current_club_id()));

ALTER TABLE "event_registration_entries" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "event_registration_entries";
CREATE POLICY tenant_isolation ON "event_registration_entries" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK ("clubId" = app.current_club_id());
