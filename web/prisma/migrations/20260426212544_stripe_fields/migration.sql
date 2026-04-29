/*
  Warnings:

  - A unique constraint covering the columns `[stripeAccountId]` on the table `clubs` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[stripeSubscriptionId]` on the table `clubs` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "clubs" ADD COLUMN     "stripeAccountId" TEXT,
ADD COLUMN     "stripeChargesEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stripeOnboardingComplete" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stripePayoutsEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stripeSubscriptionId" TEXT,
ADD COLUMN     "subscriptionStatus" TEXT;

-- AlterTable
ALTER TABLE "members" ADD COLUMN     "stripeCustomerId" TEXT;

-- CreateTable
CREATE TABLE "member_subscriptions" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "optionLabel" TEXT NOT NULL,
    "stripeSubscriptionId" TEXT,
    "stripePriceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "startedAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "member_subscriptions_stripeSubscriptionId_key" ON "member_subscriptions"("stripeSubscriptionId");

-- CreateIndex
CREATE INDEX "member_subscriptions_memberId_idx" ON "member_subscriptions"("memberId");

-- CreateIndex
CREATE INDEX "member_subscriptions_membershipId_idx" ON "member_subscriptions"("membershipId");

-- CreateIndex
CREATE UNIQUE INDEX "clubs_stripeAccountId_key" ON "clubs"("stripeAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "clubs_stripeSubscriptionId_key" ON "clubs"("stripeSubscriptionId");

-- AddForeignKey
ALTER TABLE "member_subscriptions" ADD CONSTRAINT "member_subscriptions_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_subscriptions" ADD CONSTRAINT "member_subscriptions_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;
