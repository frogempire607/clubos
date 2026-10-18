-- Pricing overhaul (2026-10-18): base + platform-fee model.
--
-- SAFE / ADDITIVE. No column is dropped or renamed, no row is deleted.
--   1. clubs.passPlatformFee  — new boolean, default false (club absorbs the
--      AthletixOS platform fee, as specified). Every existing club gets false.
--   2. clubs.feeChoiceMadeAt  — new nullable timestamp. NULL for every existing
--      club, which is what triggers the one-time owner redirect to Member
--      payments settings.
--   3. clubs.passProcessingFees default false → true for NEW clubs only.
--      Existing rows keep the value they have (Frog Empire is already true).
--   4. clubs.tier default 'growth' → 'starter', and the legacy 'growth' rows
--      become 'starter'. 'pro' and 'enterprise' rows are untouched (Frog
--      Empire stays 'enterprise'). lib/tier.ts also reads 'growth' as Starter,
--      so code and data agree whether or not step 4 has run yet.
--
-- Apply BEFORE pushing the branch: the new schema names passPlatformFee and
-- feeChoiceMadeAt, and Prisma 500s every Club read if they don't exist.

ALTER TABLE "clubs" ADD COLUMN IF NOT EXISTS "passPlatformFee" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "clubs" ADD COLUMN IF NOT EXISTS "feeChoiceMadeAt" TIMESTAMP(3);
ALTER TABLE "clubs" ALTER COLUMN "passProcessingFees" SET DEFAULT true;
ALTER TABLE "clubs" ALTER COLUMN "tier" SET DEFAULT 'starter';
UPDATE "clubs" SET "tier" = 'starter' WHERE "tier" = 'growth';
