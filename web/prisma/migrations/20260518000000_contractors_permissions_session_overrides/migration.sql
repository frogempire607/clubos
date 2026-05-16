-- Lightweight contractor / guest coach (no auth account)
CREATE TABLE "contractors" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "role" TEXT,
    "w9Url" TEXT,
    "payoutNotes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "convertedUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "contractors_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "contractors_convertedUserId_key" ON "contractors"("convertedUserId");
CREATE INDEX "contractors_clubId_idx" ON "contractors"("clubId");
ALTER TABLE "contractors" ADD CONSTRAINT "contractors_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "contractor_payments" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "contractorId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "service" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "contractor_payments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "contractor_payments_clubId_idx" ON "contractor_payments"("clubId");
CREATE INDEX "contractor_payments_contractorId_idx" ON "contractor_payments"("contractorId");
ALTER TABLE "contractor_payments" ADD CONSTRAINT "contractor_payments_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "contractor_payments" ADD CONSTRAINT "contractor_payments_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "contractors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Per-occurrence class session overrides
ALTER TABLE "class_sessions" ADD COLUMN "staffOverride" JSONB;
ALTER TABLE "class_sessions" ADD COLUMN "note" TEXT;
ALTER TABLE "class_sessions" ADD COLUMN "overridden" BOOLEAN NOT NULL DEFAULT false;
