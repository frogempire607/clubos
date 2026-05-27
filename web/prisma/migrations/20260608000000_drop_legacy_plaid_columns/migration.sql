-- Drop the legacy single-bank Plaid columns on `clubs`. Every club row was
-- already backfilled into `plaid_connections` by migration
-- `20260607000000_plaid_multiple_banks`, and the runtime no longer reads
-- these columns — so removing them just cleans up the schema.
-- Idempotent: IF EXISTS guards make a re-run safe.

ALTER TABLE "clubs" DROP COLUMN IF EXISTS "plaidAccessToken";
ALTER TABLE "clubs" DROP COLUMN IF EXISTS "plaidItemId";
