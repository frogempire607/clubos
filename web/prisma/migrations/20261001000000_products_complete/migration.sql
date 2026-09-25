-- B10 slice 3 — products: the public page (/p/{slug}), QR scan count, guest
-- buyers, the Transaction link that puts product money in Financials, and
-- bookings for Bookable products. Additive only; no existing row changes.

ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "publicSlug" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "scanCount" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS "products_publicSlug_key" ON "products"("publicSlug");

ALTER TABLE "product_sales" ADD COLUMN IF NOT EXISTS "guestName" TEXT;
ALTER TABLE "product_sales" ADD COLUMN IF NOT EXISTS "guestEmail" TEXT;
ALTER TABLE "product_sales" ADD COLUMN IF NOT EXISTS "transactionId" TEXT;

CREATE TABLE IF NOT EXISTS "product_bookings" (
  "id" TEXT NOT NULL,
  "clubId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "memberId" TEXT,
  "guestName" TEXT,
  "guestEmail" TEXT,
  "guestPhone" TEXT,
  "bookedByUserId" TEXT,
  "tierName" TEXT,
  "durationMins" INTEGER NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "guests" INTEGER NOT NULL DEFAULT 1,
  "addOns" JSONB NOT NULL DEFAULT '[]',
  "answers" JSONB NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "paymentMode" TEXT NOT NULL DEFAULT 'FULL',
  "amountTotal" DECIMAL(10,2) NOT NULL,
  "dueNow" DECIMAL(10,2) NOT NULL,
  "amountPaid" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "stripeCheckoutSessionId" TEXT,
  "stripePaymentIntentId" TEXT,
  "transactionId" TEXT,
  "declinedReason" TEXT,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "product_bookings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "product_bookings_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "product_bookings_clubId_startsAt_idx" ON "product_bookings"("clubId", "startsAt");
CREATE INDEX IF NOT EXISTS "product_bookings_productId_startsAt_idx" ON "product_bookings"("productId", "startsAt");
CREATE INDEX IF NOT EXISTS "product_bookings_clubId_status_idx" ON "product_bookings"("clubId", "status");

-- Same tenant policy as every other club table (20260702000000_enable_rls).
ALTER TABLE "product_bookings" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "product_bookings";
CREATE POLICY tenant_isolation ON "product_bookings" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK ("clubId" = app.current_club_id());
