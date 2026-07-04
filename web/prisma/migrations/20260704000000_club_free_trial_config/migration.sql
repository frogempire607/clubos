-- One club-level free-trial offer (name/days/memberships/rules) replacing the
-- per-membership trial flags. Null = legacy fallback to membership columns.
ALTER TABLE "clubs" ADD COLUMN IF NOT EXISTS "freeTrialConfig" JSONB;
