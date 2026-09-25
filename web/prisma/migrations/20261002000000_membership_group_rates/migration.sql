-- B3 slice 3 — membership group rates the club defines (any number, any name),
-- and each athlete's answer per rate. Additive: '[]' / '{}' = none.
ALTER TABLE "clubs" ADD COLUMN IF NOT EXISTS "groupRates" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "members" ADD COLUMN IF NOT EXISTS "groupValues" JSONB NOT NULL DEFAULT '{}';
