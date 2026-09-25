-- Positions that only exist in some rosters (e.g. "40 (K4 only)", "84 (K8 only)").
-- rosterIds lists the rosters a position is offered in; EMPTY = every roster,
-- which is what every existing position means today. Additive.
ALTER TABLE "event_roster_positions" ADD COLUMN IF NOT EXISTS "rosterIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
