-- Multiple Plaid bank connections per club. The legacy single-account columns
-- on `clubs` (plaidAccessToken/plaidItemId) stay for back-compat; new
-- connections are stored in plaid_connections. Transactions and expenses can
-- now optionally be tagged with the bank account they came from so the
-- financials/reports surfaces can filter by account. All idempotent.

CREATE TABLE IF NOT EXISTS "plaid_connections" (
  "id"              TEXT PRIMARY KEY,
  "clubId"          TEXT NOT NULL,
  "label"           TEXT,
  "institutionName" TEXT,
  "accessToken"     TEXT NOT NULL,
  "itemId"          TEXT NOT NULL,
  "accountsCache"   JSONB,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt"       TIMESTAMP(3)
);

CREATE UNIQUE INDEX IF NOT EXISTS "plaid_connections_itemId_key" ON "plaid_connections"("itemId");
CREATE INDEX        IF NOT EXISTS "plaid_connections_clubId_idx" ON "plaid_connections"("clubId");

ALTER TABLE "plaid_connections"
  DROP CONSTRAINT IF EXISTS "plaid_connections_clubId_fkey";
ALTER TABLE "plaid_connections"
  ADD CONSTRAINT "plaid_connections_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Optional FK on Transaction.
ALTER TABLE "transactions"
  ADD COLUMN IF NOT EXISTS "plaidConnectionId" TEXT;
ALTER TABLE "transactions"
  DROP CONSTRAINT IF EXISTS "transactions_plaidConnectionId_fkey";
ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_plaidConnectionId_fkey"
  FOREIGN KEY ("plaidConnectionId") REFERENCES "plaid_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Optional FK on Expense.
ALTER TABLE "expenses"
  ADD COLUMN IF NOT EXISTS "plaidConnectionId" TEXT;
ALTER TABLE "expenses"
  DROP CONSTRAINT IF EXISTS "expenses_plaidConnectionId_fkey";
ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_plaidConnectionId_fkey"
  FOREIGN KEY ("plaidConnectionId") REFERENCES "plaid_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Best-effort backfill: if a club already has a legacy single Plaid connection,
-- mirror it into plaid_connections so the new UI/API can see it. We only
-- insert when the legacy itemId doesn't already exist in the new table.
INSERT INTO "plaid_connections" ("id", "clubId", "accessToken", "itemId", "createdAt", "updatedAt")
SELECT
  'legacy_' || c."id",
  c."id",
  c."plaidAccessToken",
  c."plaidItemId",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "clubs" c
WHERE c."plaidAccessToken" IS NOT NULL
  AND c."plaidItemId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "plaid_connections" pc WHERE pc."itemId" = c."plaidItemId"
  );
