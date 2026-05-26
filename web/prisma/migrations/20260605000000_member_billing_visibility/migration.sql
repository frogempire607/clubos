-- Owner-controlled toggle for which billing info members can see on the
-- portal (plan name, next billing date, price, invoice history). null = all
-- visible (default). Idempotent.
ALTER TABLE "clubs" ADD COLUMN IF NOT EXISTS "memberBillingVisibility" JSONB;
