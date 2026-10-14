-- Financials: bank accounts per entity, QuickBooks imports, receipt inbox;
-- Events: audience rules. ADDITIVE — new tables and nullable / defaulted
-- columns only. Existing bank rows get their account rows created here
-- (unassigned to an entity until the owner picks one in Financials → Bank).

ALTER TABLE "plaid_connections" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'PLAID';

ALTER TABLE "plaid_transactions" ADD COLUMN IF NOT EXISTS "legalEntityId" TEXT;
ALTER TABLE "plaid_transactions" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'PLAID';
ALTER TABLE "plaid_transactions" ADD COLUMN IF NOT EXISTS "importId" TEXT;
CREATE INDEX IF NOT EXISTS "plaid_transactions_entity_idx" ON "plaid_transactions"("clubId", "legalEntityId", "date");
CREATE INDEX IF NOT EXISTS "plaid_transactions_importId_idx" ON "plaid_transactions"("importId");

ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "audience" JSONB;

CREATE TABLE IF NOT EXISTS "bank_accounts" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "plaidConnectionId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT,
    "officialName" TEXT,
    "mask" TEXT,
    "type" TEXT,
    "subtype" TEXT,
    "legalEntityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "bank_accounts_plaidConnectionId_accountId_key" ON "bank_accounts"("plaidConnectionId", "accountId");
CREATE INDEX IF NOT EXISTS "bank_accounts_clubId_idx" ON "bank_accounts"("clubId");
CREATE INDEX IF NOT EXISTS "bank_accounts_legalEntityId_idx" ON "bank_accounts"("legalEntityId");
DO $$ BEGIN
  ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_plaidConnectionId_fkey" FOREIGN KEY ("plaidConnectionId") REFERENCES "plaid_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "legal_entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One account row for every account that already has bank rows.
INSERT INTO "bank_accounts" ("id", "clubId", "plaidConnectionId", "accountId", "updatedAt")
SELECT 'ba_' || md5(t."plaidConnectionId" || ':' || t."accountId"), t."clubId", t."plaidConnectionId", t."accountId", CURRENT_TIMESTAMP
FROM (SELECT DISTINCT "clubId", "plaidConnectionId", "accountId" FROM "plaid_transactions") t
ON CONFLICT ("plaidConnectionId", "accountId") DO NOTHING;

CREATE TABLE IF NOT EXISTS "receipts" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "vendor" TEXT,
    "amount" DECIMAL(12,2),
    "receiptDate" DATE,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "plaidTransactionId" TEXT,
    "legalEntityId" TEXT,
    "matchedAt" TIMESTAMP(3),
    "matchedByUserId" TEXT,
    "uploadedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "receipts_clubId_status_idx" ON "receipts"("clubId", "status");
CREATE INDEX IF NOT EXISTS "receipts_plaidTransactionId_idx" ON "receipts"("plaidTransactionId");
DO $$ BEGIN
  ALTER TABLE "receipts" ADD CONSTRAINT "receipts_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "ledger_imports" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'QUICKBOOKS',
    "fileName" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "rows" JSONB NOT NULL,
    "mapping" JSONB NOT NULL DEFAULT '{}',
    "summary" JSONB,
    "applied" JSONB,
    "createdByUserId" TEXT,
    "committedAt" TIMESTAMP(3),
    "undoneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ledger_imports_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ledger_imports_clubId_idx" ON "ledger_imports"("clubId");
DO $$ BEGIN
  ALTER TABLE "ledger_imports" ADD CONSTRAINT "ledger_imports_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Row level security: the same tenant policy as every other club table.
ALTER TABLE "bank_accounts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "bank_accounts";
CREATE POLICY tenant_isolation ON "bank_accounts" FOR ALL USING ("clubId" = app.current_club_id()) WITH CHECK ("clubId" = app.current_club_id());
ALTER TABLE "receipts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "receipts";
CREATE POLICY tenant_isolation ON "receipts" FOR ALL USING ("clubId" = app.current_club_id()) WITH CHECK ("clubId" = app.current_club_id());
ALTER TABLE "ledger_imports" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ledger_imports";
CREATE POLICY tenant_isolation ON "ledger_imports" FOR ALL USING ("clubId" = app.current_club_id()) WITH CHECK ("clubId" = app.current_club_id());
