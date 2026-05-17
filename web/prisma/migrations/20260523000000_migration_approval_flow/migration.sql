-- Migration approval flow: owner-assigned plan, editable-field config,
-- client requests, and setup-mode payment held until owner approval.
ALTER TABLE "members" ADD COLUMN IF NOT EXISTS "migrationMembershipId" TEXT;
ALTER TABLE "members" ADD COLUMN IF NOT EXISTS "activationEditableFields" JSONB;
ALTER TABLE "members" ADD COLUMN IF NOT EXISTS "requestedBillingDate" TIMESTAMP(3);
ALTER TABLE "members" ADD COLUMN IF NOT EXISTS "requestedBillingNote" TEXT;
ALTER TABLE "members" ADD COLUMN IF NOT EXISTS "activationNote" TEXT;
ALTER TABLE "members" ADD COLUMN IF NOT EXISTS "approvalStatus" TEXT;
ALTER TABLE "members" ADD COLUMN IF NOT EXISTS "stripeSetupCustomerId" TEXT;
ALTER TABLE "members" ADD COLUMN IF NOT EXISTS "stripeSetupPaymentMethodId" TEXT;
