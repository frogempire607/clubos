-- B13 slice 2 — a pause is a fact on the membership row, not just a roster
-- label. Additive; every existing row stays null.
ALTER TABLE "member_subscriptions" ADD COLUMN "pausedAt" TIMESTAMP(3);
ALTER TABLE "member_subscriptions" ADD COLUMN "pausedUntil" TIMESTAMP(3);
ALTER TABLE "member_subscriptions" ADD COLUMN "cancelReason" TEXT;
