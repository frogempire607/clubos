-- Labeled external links on an event. Additive only: one nullable column.

-- Array of { "label": string, "url": string } (max 8), written through
-- lib/eventLinks.normalizeEventLinks. NULL = no links. The older
-- "registrationLink" column is left in place and is still read as a fallback.
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "externalLinks" JSONB;
