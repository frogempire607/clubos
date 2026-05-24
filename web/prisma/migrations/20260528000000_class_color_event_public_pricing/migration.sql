-- Per-class calendar color + per-event public registration pricing.
-- Idempotent (safe to re-run).
ALTER TABLE "recurring_classes" ADD COLUMN IF NOT EXISTS "color" TEXT;
ALTER TABLE "recurring_classes" ADD COLUMN IF NOT EXISTS "textColor" TEXT;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "publicPricingOption" TEXT;
