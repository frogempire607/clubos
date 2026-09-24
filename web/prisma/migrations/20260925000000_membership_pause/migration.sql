-- B13 slice 2 — a pause is a fact on the membership row, not just a roster
-- label. Additive; every existing row stays null.
--
-- pausedAt / pausedUntil already exist in production: they were added by
-- 20260429192044_add_missing_core_tables and later dropped from the Prisma
-- schema without a migration. IF NOT EXISTS makes this safe on both the
-- production database (columns present) and a fresh one (columns absent).
ALTER TABLE "member_subscriptions" ADD COLUMN IF NOT EXISTS "pausedAt" TIMESTAMP(3);
ALTER TABLE "member_subscriptions" ADD COLUMN IF NOT EXISTS "pausedUntil" TIMESTAMP(3);
ALTER TABLE "member_subscriptions" ADD COLUMN IF NOT EXISTS "cancelReason" TEXT;
