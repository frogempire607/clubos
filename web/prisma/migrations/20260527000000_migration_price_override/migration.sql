-- Owner price override + discount note for member migration (idempotent).
ALTER TABLE "members" ADD COLUMN IF NOT EXISTS "migrationPriceOverride" DECIMAL(10,2);
ALTER TABLE "members" ADD COLUMN IF NOT EXISTS "migrationDiscountNote" TEXT;
