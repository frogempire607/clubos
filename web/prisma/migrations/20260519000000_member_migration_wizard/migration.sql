-- Member migration / software-switch fields
ALTER TABLE "members" ADD COLUMN "legacySource" TEXT;
ALTER TABLE "members" ADD COLUMN "legacyMemberId" TEXT;
ALTER TABLE "members" ADD COLUMN "importedAt" TIMESTAMP(3);
ALTER TABLE "members" ADD COLUMN "migrationStatus" TEXT;
ALTER TABLE "members" ADD COLUMN "paymentSetupStatus" TEXT;
ALTER TABLE "members" ADD COLUMN "legacyMembershipName" TEXT;
ALTER TABLE "members" ADD COLUMN "legacyMembershipPrice" DECIMAL(10,2);
ALTER TABLE "members" ADD COLUMN "legacyBillingFrequency" TEXT;
ALTER TABLE "members" ADD COLUMN "membershipStartDate" TIMESTAMP(3);
ALTER TABLE "members" ADD COLUMN "nextBillingDate" TIMESTAMP(3);
ALTER TABLE "members" ADD COLUMN "billingAnchorDate" TIMESTAMP(3);
ALTER TABLE "members" ADD COLUMN "commitmentEndDate" TIMESTAMP(3);
ALTER TABLE "members" ADD COLUMN "activationToken" TEXT;
ALTER TABLE "members" ADD COLUMN "activationTokenExpires" TIMESTAMP(3);
ALTER TABLE "members" ADD COLUMN "activationEmailSentAt" TIMESTAMP(3);
ALTER TABLE "members" ADD COLUMN "activationEmailSendCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "members" ADD COLUMN "activatedAt" TIMESTAMP(3);
ALTER TABLE "members" ADD COLUMN "migrationCompletedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "members_activationToken_key" ON "members"("activationToken");

-- Migration audit / history log
CREATE TABLE "member_migration_events" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "member_migration_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "member_migration_events_clubId_idx" ON "member_migration_events"("clubId");
CREATE INDEX "member_migration_events_memberId_idx" ON "member_migration_events"("memberId");
ALTER TABLE "member_migration_events" ADD CONSTRAINT "member_migration_events_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "member_migration_events" ADD CONSTRAINT "member_migration_events_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
