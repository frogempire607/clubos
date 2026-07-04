-- Invoice splitting (Client UX Phase 7, behind FEATURE_INVOICE_SPLIT).
-- Standing two-guardian cost-split agreements per athlete, with a
-- guardian → co-guardian → staff approval lifecycle and a JSON audit trail.
-- Purely additive: new table + FKs, no existing data touched.

CREATE TABLE "invoice_splits" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "proposerUserId" TEXT NOT NULL,
    "responderUserId" TEXT NOT NULL,
    "proposerPercent" INTEGER NOT NULL,
    "responderPercent" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_GUARDIAN',
    "note" TEXT,
    "events" JSONB NOT NULL DEFAULT '[]',
    "proposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "guardianRespondedAt" TIMESTAMP(3),
    "staffReviewedAt" TIMESTAMP(3),
    "staffUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoice_splits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "invoice_splits_clubId_status_idx" ON "invoice_splits"("clubId", "status");
CREATE INDEX "invoice_splits_memberId_status_idx" ON "invoice_splits"("memberId", "status");

ALTER TABLE "invoice_splits" ADD CONSTRAINT "invoice_splits_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "invoice_splits" ADD CONSTRAINT "invoice_splits_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
