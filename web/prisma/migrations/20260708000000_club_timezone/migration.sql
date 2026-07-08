-- Additive: IANA timezone of the physical club (e.g. 'America/Chicago').
-- Used to resolve the wall-clock-UTC class-time convention to real instants
-- for the ICS feed, the /cal embed, and check-in windows. NULL = not set,
-- which keeps the pre-timezone behavior everywhere.
ALTER TABLE "clubs" ADD COLUMN "timezone" TEXT;
