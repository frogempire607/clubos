-- Stripe product catalog on memberships (connected-account Product/Price ids).
-- Additive + idempotent. Existing rows get NULL product id and an empty price map.
ALTER TABLE "memberships" ADD COLUMN IF NOT EXISTS "stripeProductId" TEXT;
ALTER TABLE "memberships" ADD COLUMN IF NOT EXISTS "stripePriceIds" JSONB NOT NULL DEFAULT '{}';
