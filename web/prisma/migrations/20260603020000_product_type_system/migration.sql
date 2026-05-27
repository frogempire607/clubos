ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "productType" TEXT NOT NULL DEFAULT 'GEAR',
  ADD COLUMN IF NOT EXISTS "visibility" TEXT NOT NULL DEFAULT 'MEMBERS_AND_PUBLIC',
  ADD COLUMN IF NOT EXISTS "showLocation" TEXT NOT NULL DEFAULT 'MEMBER_PORTAL',
  ADD COLUMN IF NOT EXISTS "taxable" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "internalNotes" TEXT,
  ADD COLUMN IF NOT EXISTS "settings" JSONB NOT NULL DEFAULT '{}';

UPDATE "products"
SET "productType" = CASE
  WHEN "category" IN ('GEAR', 'APPAREL') THEN 'GEAR'
  WHEN "category" = 'FACILITY' THEN 'FACILITY_RENTAL'
  WHEN "category" = 'SERVICE' THEN 'OTHER'
  ELSE 'OTHER'
END
WHERE "productType" = 'GEAR' AND "category" NOT IN ('GEAR', 'APPAREL');

CREATE INDEX IF NOT EXISTS "products_productType_idx" ON "products"("productType");
CREATE INDEX IF NOT EXISTS "products_visibility_idx" ON "products"("visibility");
CREATE INDEX IF NOT EXISTS "products_showLocation_idx" ON "products"("showLocation");
