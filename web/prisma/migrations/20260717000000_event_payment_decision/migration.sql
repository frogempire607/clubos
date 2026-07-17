-- Event registration payment decision
-- Owners configure which payment methods an event's registration offers
-- (CARD | AUTO_CARD | CASH | CHECK); registrants must pick one, and the
-- registration's status tracks the money (PENDING_PAYMENT / SCHEDULED /
-- AWAITING_CASH / AWAITING_CHECK / PAYMENT_FAILED / PAID). Additive only.

-- events: allowed methods + auto-charge timing + check-in gate
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "paymentMethods" JSONB;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "autoChargeDate" TIMESTAMP(3);
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "requirePaymentBeforeCheckin" BOOLEAN NOT NULL DEFAULT false;

-- event_registrations: the registrant's payment decision + settlement facts
ALTER TABLE "event_registrations" ADD COLUMN IF NOT EXISTS "paymentMethod" TEXT;
ALTER TABLE "event_registrations" ADD COLUMN IF NOT EXISTS "autoChargeConsent" JSONB;
ALTER TABLE "event_registrations" ADD COLUMN IF NOT EXISTS "scheduledChargeAt" TIMESTAMP(3);
ALTER TABLE "event_registrations" ADD COLUMN IF NOT EXISTS "chargeAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "event_registrations" ADD COLUMN IF NOT EXISTS "lastChargeError" TEXT;
ALTER TABLE "event_registrations" ADD COLUMN IF NOT EXISTS "paidAt" TIMESTAMP(3);
ALTER TABLE "event_registrations" ADD COLUMN IF NOT EXISTS "paidVia" TEXT;
ALTER TABLE "event_registrations" ADD COLUMN IF NOT EXISTS "receivedById" TEXT;
ALTER TABLE "event_registrations" ADD COLUMN IF NOT EXISTS "checkReference" TEXT;
ALTER TABLE "event_registrations" ADD COLUMN IF NOT EXISTS "transactionId" TEXT;

CREATE INDEX IF NOT EXISTS "event_registrations_clubId_status_idx"
  ON "event_registrations"("clubId", "status");
CREATE INDEX IF NOT EXISTS "event_registrations_status_scheduledChargeAt_idx"
  ON "event_registrations"("status", "scheduledChargeAt");
