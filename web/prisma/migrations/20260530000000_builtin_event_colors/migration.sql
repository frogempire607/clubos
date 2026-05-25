-- Per-club overrides for built-in EventType badge colors.
ALTER TABLE "clubs" ADD COLUMN IF NOT EXISTS "builtInEventColors" JSONB;
