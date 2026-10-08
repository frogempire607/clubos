-- What a coach syncs to their calendar: classes, private lessons, events (any
-- mix). ADDITIVE: three columns that default to ON, so every existing link
-- keeps showing everything it showed before.
ALTER TABLE "staff_calendar_feeds" ADD COLUMN IF NOT EXISTS "includeClasses" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "staff_calendar_feeds" ADD COLUMN IF NOT EXISTS "includePrivates" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "staff_calendar_feeds" ADD COLUMN IF NOT EXISTS "includeEvents" BOOLEAN NOT NULL DEFAULT true;
