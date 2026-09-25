-- B3 slice 2 — sibling membership discount. Additive only: '{}' = off, and
-- null source/label/type/value on a subscription reads exactly as before
-- ("a typed code, or nothing").
ALTER TABLE "clubs" ADD COLUMN IF NOT EXISTS "siblingDiscount" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "member_subscriptions" ADD COLUMN IF NOT EXISTS "discountSource" TEXT;
ALTER TABLE "member_subscriptions" ADD COLUMN IF NOT EXISTS "discountLabel" TEXT;
ALTER TABLE "member_subscriptions" ADD COLUMN IF NOT EXISTS "discountType" TEXT;
ALTER TABLE "member_subscriptions" ADD COLUMN IF NOT EXISTS "discountValue" DECIMAL(10,2);
