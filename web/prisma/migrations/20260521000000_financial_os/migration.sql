-- Financial OS: entity-aware money tracking, categories, receipts, donations.
-- Idempotent so a re-run after a partial apply is safe.
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "category" TEXT;
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "paymentMethod" TEXT DEFAULT 'STRIPE';
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "legalEntityId" TEXT;
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "source" TEXT;
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "notes" TEXT;
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "manual" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "txDate" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "transactions_legalEntityId_idx" ON "transactions"("legalEntityId");
ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "transactions_legalEntityId_fkey";
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "legal_entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "vendor" TEXT;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "paymentMethod" TEXT;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "legalEntityId" TEXT;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "reimbursable" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "receiptUrl" TEXT;
CREATE INDEX IF NOT EXISTS "expenses_legalEntityId_idx" ON "expenses"("legalEntityId");
ALTER TABLE "expenses" DROP CONSTRAINT IF EXISTS "expenses_legalEntityId_fkey";
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "legal_entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "clubs" ADD COLUMN IF NOT EXISTS "defaultLegalEntityId" TEXT;

CREATE TABLE IF NOT EXISTS "donations" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "donorName" TEXT NOT NULL,
    "donorEmail" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "fund" TEXT,
    "restricted" BOOLEAN NOT NULL DEFAULT false,
    "sponsorship" BOOLEAN NOT NULL DEFAULT false,
    "paymentMethod" TEXT NOT NULL DEFAULT 'CASH',
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receiptUrl" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "donations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "donations_clubId_idx" ON "donations"("clubId");
CREATE INDEX IF NOT EXISTS "donations_legalEntityId_idx" ON "donations"("legalEntityId");
CREATE INDEX IF NOT EXISTS "donations_date_idx" ON "donations"("date");
ALTER TABLE "donations" DROP CONSTRAINT IF EXISTS "donations_clubId_fkey";
ALTER TABLE "donations" ADD CONSTRAINT "donations_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "donations" DROP CONSTRAINT IF EXISTS "donations_legalEntityId_fkey";
ALTER TABLE "donations" ADD CONSTRAINT "donations_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "legal_entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
