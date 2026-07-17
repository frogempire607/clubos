-- Bundle purchases require a payment decision. Additive only.

ALTER TABLE "event_bundles" ADD COLUMN IF NOT EXISTS "paymentMethods" JSONB;

CREATE TABLE IF NOT EXISTS "event_bundle_purchases" (
  "id"                      TEXT NOT NULL,
  "clubId"                  TEXT NOT NULL,
  "bundleId"                TEXT NOT NULL,
  "memberId"                TEXT NOT NULL,
  "status"                  TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
  "paymentMethod"           TEXT,
  "amountDue"               DECIMAL(10,2),
  "amountPaid"              DECIMAL(10,2),
  "transactionId"           TEXT,
  "stripeCheckoutSessionId" TEXT,
  "stripePaymentIntentId"   TEXT,
  "lastChargeError"         TEXT,
  "paidAt"                  TIMESTAMP(3),
  "paidVia"                 TEXT,
  "receivedById"            TEXT,
  "checkReference"          TEXT,
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"               TIMESTAMP(3) NOT NULL,
  CONSTRAINT "event_bundle_purchases_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "event_bundle_purchases_clubId_status_idx" ON "event_bundle_purchases"("clubId", "status");
CREATE INDEX IF NOT EXISTS "event_bundle_purchases_bundleId_memberId_idx" ON "event_bundle_purchases"("bundleId", "memberId");
-- One LIVE purchase per member per bundle — duplicate clicks cannot create
-- duplicate purchases no matter how they race. CANCELED and PAYMENT_FAILED
-- rows are excluded so a member can retry after a decline.
CREATE UNIQUE INDEX IF NOT EXISTS "event_bundle_purchases_live_unique"
  ON "event_bundle_purchases"("bundleId", "memberId")
  WHERE "status" NOT IN ('CANCELED', 'PAYMENT_FAILED');
ALTER TABLE "event_bundle_purchases"
  ADD CONSTRAINT "event_bundle_purchases_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "event_bundle_purchases"
  ADD CONSTRAINT "event_bundle_purchases_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "event_bundles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "event_bundle_purchases"
  ADD CONSTRAINT "event_bundle_purchases_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
