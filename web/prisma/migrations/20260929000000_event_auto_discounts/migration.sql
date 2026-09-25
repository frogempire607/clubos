-- B3 slice 1 — automatic sibling / group-rate discounts on events, and a
-- coach discount at approval. Additive only; every default reproduces today:
-- an event with '{}' has no automatic discount, and a registration with a
-- null discountSource reads exactly as before.
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "autoDiscounts" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "event_registrations" ADD COLUMN IF NOT EXISTS "discountSource" TEXT;
ALTER TABLE "event_registrations" ADD COLUMN IF NOT EXISTS "discountLabel" TEXT;
ALTER TABLE "event_registrations" ADD COLUMN IF NOT EXISTS "groupValue" TEXT;
