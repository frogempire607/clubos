-- Client change requests on reactivation offers (additive only).
--
-- A client reviewing an offer may request changes instead of confirming. The
-- request NEVER mutates billing data — it locks the offer's confirmation until
-- the owner approves (regenerating a new offer version) or denies it.
--   changeRequest        JSON  { fields: {membership?, purchaseOption?, billingDate?,
--                               frequency?, payer?, paymentMethod?}, note?, requestedAt,
--                               byUserId?, byEmail? }
--   changeRequestStatus  OPEN | APPROVED | DENIED (null = none)
ALTER TABLE "membership_reactivations" ADD COLUMN "changeRequest" JSONB;
ALTER TABLE "membership_reactivations" ADD COLUMN "changeRequestStatus" TEXT;
ALTER TABLE "membership_reactivations" ADD COLUMN "changeRequestAt" TIMESTAMP(3);
ALTER TABLE "membership_reactivations" ADD COLUMN "changeRequestResolvedAt" TIMESTAMP(3);
ALTER TABLE "membership_reactivations" ADD COLUMN "changeRequestResolvedById" TEXT;
