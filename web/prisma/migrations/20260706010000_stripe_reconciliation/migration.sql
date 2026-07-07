-- Reconciliation: cache Stripe facts on member subscriptions + a review queue
-- for Stripe subscriptions that can't be confidently matched to a member.
-- Additive + idempotent. No existing data is modified.

ALTER TABLE "member_subscriptions" ADD COLUMN IF NOT EXISTS "stripeProductId" TEXT;
ALTER TABLE "member_subscriptions" ADD COLUMN IF NOT EXISTS "currentPeriodEnd" TIMESTAMP(3);
ALTER TABLE "member_subscriptions" ADD COLUMN IF NOT EXISTS "stripeStatus" TEXT;
ALTER TABLE "member_subscriptions" ADD COLUMN IF NOT EXISTS "stripeSnapshot" JSONB;

CREATE TABLE IF NOT EXISTS "stripe_reconciliations" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "stripeSubscriptionId" TEXT NOT NULL,
    "stripeCustomerId" TEXT,
    "customerEmail" TEXT,
    "customerName" TEXT,
    "stripeStatus" TEXT,
    "amountCents" INTEGER,
    "interval" TEXT,
    "priceId" TEXT,
    "productId" TEXT,
    "currentPeriodEnd" TIMESTAMP(3),
    "suggestedMemberId" TEXT,
    "matchConfidence" TEXT NOT NULL DEFAULT 'NONE',
    "snapshot" JSONB,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolvedMemberId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "stripe_reconciliations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "stripe_reconciliations_stripeSubscriptionId_key" ON "stripe_reconciliations"("stripeSubscriptionId");
CREATE INDEX IF NOT EXISTS "stripe_reconciliations_clubId_status_idx" ON "stripe_reconciliations"("clubId", "status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'stripe_reconciliations_clubId_fkey'
  ) THEN
    ALTER TABLE "stripe_reconciliations"
      ADD CONSTRAINT "stripe_reconciliations_clubId_fkey"
      FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
