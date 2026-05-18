-- Branded mobile-app configuration on Club (idempotent).
ALTER TABLE "clubs" ADD COLUMN IF NOT EXISTS "brandedAppConfig" JSONB;
