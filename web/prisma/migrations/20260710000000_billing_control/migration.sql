-- Billing control center + reactivation (2026-07-10). Purely additive:
-- new nullable member columns for migration triage/payer/last-editor, an
-- append-only billing audit table, and the reactivation-offer table.

-- Member: migration triage + payer + last-billing-editor columns
ALTER TABLE "members" ADD COLUMN "migrationGroup" TEXT;
ALTER TABLE "members" ADD COLUMN "migrationFinalAction" TEXT;
ALTER TABLE "members" ADD COLUMN "migrationGroupNote" TEXT;
ALTER TABLE "members" ADD COLUMN "migrationFinalBillingDate" TIMESTAMP(3);
ALTER TABLE "members" ADD COLUMN "responsiblePayerUserId" TEXT;
ALTER TABLE "members" ADD COLUMN "billingUpdatedAt" TIMESTAMP(3);
ALTER TABLE "members" ADD COLUMN "billingUpdatedById" TEXT;

-- Append-only billing audit trail
CREATE TABLE "billing_audit_logs" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "memberId" TEXT,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "billing_audit_logs_clubId_createdAt_idx" ON "billing_audit_logs"("clubId", "createdAt");
CREATE INDEX "billing_audit_logs_memberId_idx" ON "billing_audit_logs"("memberId");

ALTER TABLE "billing_audit_logs" ADD CONSTRAINT "billing_audit_logs_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "billing_audit_logs" ADD CONSTRAINT "billing_audit_logs_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Membership reactivation offers (secure expiring confirm links)
CREATE TABLE "membership_reactivations" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "tokenExpires" TIMESTAMP(3) NOT NULL,
    "offerVersion" INTEGER NOT NULL DEFAULT 1,
    "offer" JSONB NOT NULL,
    "personalNote" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "emailSentAt" TIMESTAMP(3),
    "emailSendCount" INTEGER NOT NULL DEFAULT 0,
    "sentToEmail" TEXT,
    "viewedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "confirmedByUserId" TEXT,
    "consent" JSONB,
    "memberSubscriptionId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "membership_reactivations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "membership_reactivations_token_key" ON "membership_reactivations"("token");
CREATE INDEX "membership_reactivations_clubId_status_idx" ON "membership_reactivations"("clubId", "status");
CREATE INDEX "membership_reactivations_memberId_idx" ON "membership_reactivations"("memberId");

ALTER TABLE "membership_reactivations" ADD CONSTRAINT "membership_reactivations_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "membership_reactivations" ADD CONSTRAINT "membership_reactivations_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
