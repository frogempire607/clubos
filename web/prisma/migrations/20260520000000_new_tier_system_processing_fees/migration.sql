-- New tier system: no Starter/free plan. Existing Starter clubs move to Growth.
ALTER TABLE "clubs" ALTER COLUMN "tier" SET DEFAULT 'growth';
UPDATE "clubs" SET "tier" = 'growth' WHERE "tier" = 'starter' OR "tier" IS NULL;

-- Optional pass-through of Stripe processing fees to the customer at checkout.
ALTER TABLE "clubs" ADD COLUMN "passProcessingFees" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "clubs" ADD COLUMN "processingFeeNote" TEXT;
