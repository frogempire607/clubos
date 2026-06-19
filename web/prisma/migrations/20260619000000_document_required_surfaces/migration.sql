-- Documents can now be marked REQUIRED at specific surfaces, not only at
-- activation: ONBOARDING | SIGNUP | PURCHASE | EVENT. Additive + safe on a
-- live DB. Backfill preserves existing behavior: any doc currently `required`
-- becomes required at ONBOARDING (which is exactly what `required` enforced
-- during activation before this change).
ALTER TABLE "documents" ADD COLUMN "requiredAt" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
UPDATE "documents" SET "requiredAt" = ARRAY['ONBOARDING'] WHERE "required" = true;
