-- Billing truth columns (additive only).
--
-- stripeFeeAmount / netAmount: EXACT Stripe processing fee and net from the
-- charge's balance transaction. Never computed locally — written only from
-- Stripe data. platformFee keeps its existing AthletixOS-application-fee
-- meaning and is untouched.
--
-- paymentSource: normalized money origin, one of
--   STRIPE | CASH | CHECK | EXTERNAL_READER | COMP | MANUAL_ADJUSTMENT
--
-- reconciliationStatus: whether the row is backed by a confirmed Stripe
-- object, one of
--   VERIFIED   — Stripe-confirmed (carries Stripe ids)
--   OFFLINE    — cash/check/comp; nothing in Stripe to verify against
--   UNVERIFIED — a card record NOT confirmed by Stripe (external reader /
--                assumed collection); must never count as verified revenue
--   REVIEW     — claims to be Stripe money but has no Stripe id; needs
--                reconciliation
--   VOID       — voided/reclassified; excluded from all revenue

ALTER TABLE "transactions" ADD COLUMN "stripeFeeAmount" DECIMAL(10,2);
ALTER TABLE "transactions" ADD COLUMN "netAmount" DECIMAL(10,2);
ALTER TABLE "transactions" ADD COLUMN "paymentSource" TEXT;
ALTER TABLE "transactions" ADD COLUMN "reconciliationStatus" TEXT;

-- Deterministic backfill of existing rows from facts already on the row.
UPDATE "transactions" SET
  "paymentSource" = CASE
    WHEN "stripePaymentIntentId" IS NOT NULL OR "stripeInvoiceId" IS NOT NULL OR "stripeChargeId" IS NOT NULL THEN 'STRIPE'
    WHEN "paymentMethod" = 'CASH'   THEN 'CASH'
    WHEN "paymentMethod" = 'CHECK'  THEN 'CHECK'
    WHEN "paymentMethod" = 'CREDIT' THEN 'EXTERNAL_READER'
    WHEN "paymentMethod" = 'COMP'   THEN 'COMP'
    WHEN "paymentMethod" = 'STRIPE' THEN 'STRIPE'
    ELSE 'MANUAL_ADJUSTMENT'
  END,
  "reconciliationStatus" = CASE
    WHEN "stripePaymentIntentId" IS NOT NULL OR "stripeInvoiceId" IS NOT NULL OR "stripeChargeId" IS NOT NULL THEN 'VERIFIED'
    WHEN "paymentMethod" IN ('CASH','CHECK','COMP') THEN 'OFFLINE'
    WHEN "paymentMethod" = 'CREDIT' THEN 'UNVERIFIED'
    WHEN "paymentMethod" = 'STRIPE' THEN 'REVIEW'
    ELSE 'OFFLINE'
  END
WHERE "paymentSource" IS NULL;

CREATE INDEX "transactions_clubId_reconciliationStatus_idx" ON "transactions"("clubId", "reconciliationStatus");
