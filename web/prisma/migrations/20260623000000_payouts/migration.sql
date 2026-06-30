-- P2 unified payout ledger: track PENDING/PAID payouts to staff, guest
-- clinicians, contractors, and event workers (separate from payroll).

CREATE TABLE "payouts" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "payeeType" TEXT NOT NULL DEFAULT 'STAFF',
    "payeeUserId" TEXT,
    "contractorId" TEXT,
    "payeeName" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'OTHER',
    "eventId" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "method" TEXT,
    "paidAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "payouts_clubId_idx" ON "payouts"("clubId");
CREATE INDEX "payouts_status_idx" ON "payouts"("status");
CREATE INDEX "payouts_eventId_idx" ON "payouts"("eventId");
