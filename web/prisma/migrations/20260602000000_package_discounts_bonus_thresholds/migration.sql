-- Private packages: tier-aware discount pricing.
-- pricingMode = FLAT (legacy, price field is the prepaid total),
--               PERCENT or FIXED (discountValue applied per-lesson against the
--               selected lesson type / coach tier price at purchase).
ALTER TABLE "private_packages"
  ADD COLUMN IF NOT EXISTS "pricingMode" TEXT NOT NULL DEFAULT 'FLAT';

ALTER TABLE "private_packages"
  ADD COLUMN IF NOT EXISTS "discountValue" DECIMAL(10, 2);

-- Compensation bonuses: min/max threshold counts.
-- Items at or below minThreshold are not paid; items above maxThreshold are
-- not paid. Null = no bound.
ALTER TABLE "compensation_bonuses"
  ADD COLUMN IF NOT EXISTS "minThreshold" INTEGER;

ALTER TABLE "compensation_bonuses"
  ADD COLUMN IF NOT EXISTS "maxThreshold" INTEGER;
