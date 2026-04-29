/*
  Warnings:

  - You are about to drop the column `price` on the `events` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[stripeChargeId]` on the table `transactions` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE "guardians" DROP CONSTRAINT "guardians_clubId_fkey";

-- AlterTable
ALTER TABLE "clubs" ADD COLUMN     "notificationPrefs" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "plaidAccessToken" TEXT,
ADD COLUMN     "plaidItemId" TEXT;

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "deliveryTrigger" TEXT NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "requiresGuardianSignature" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "events" DROP COLUMN "price",
ADD COLUMN     "allowMembershipPayment" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "customEventTypeId" TEXT,
ADD COLUMN     "divisions" TEXT,
ADD COLUMN     "dropInFee" DECIMAL(10,2),
ADD COLUMN     "imageUrl" TEXT,
ADD COLUMN     "isTournament" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "memberPrice" DECIMAL(10,2),
ADD COLUMN     "nonMemberPrice" DECIMAL(10,2),
ADD COLUMN     "pricingOptions" JSONB,
ADD COLUMN     "publishAt" TIMESTAMP(3),
ADD COLUMN     "purchaseAccess" TEXT NOT NULL DEFAULT 'ANYONE',
ADD COLUMN     "registrationDeadline" TIMESTAMP(3),
ADD COLUMN     "registrationLink" TEXT,
ADD COLUMN     "registrationOpen" BOOLEAN,
ADD COLUMN     "unpublishAt" TIMESTAMP(3),
ADD COLUMN     "visibility" TEXT NOT NULL DEFAULT 'PUBLIC';

-- AlterTable
ALTER TABLE "guardians" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "member_subscriptions" ADD COLUMN     "autoRenew" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "billingAnchorDate" TIMESTAMP(3),
ADD COLUMN     "billingDay" INTEGER,
ADD COLUMN     "billingPeriod" TEXT,
ADD COLUMN     "billingType" TEXT NOT NULL DEFAULT 'RECURRING',
ADD COLUMN     "discountAmount" DECIMAL(10,2),
ADD COLUMN     "discountCode" TEXT,
ADD COLUMN     "effectiveStartDate" TIMESTAMP(3),
ADD COLUMN     "endDate" TIMESTAMP(3),
ADD COLUMN     "expiredAt" TIMESTAMP(3),
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "pausedAt" TIMESTAMP(3),
ADD COLUMN     "pausedUntil" TIMESTAMP(3),
ADD COLUMN     "price" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "renewedFromId" TEXT,
ADD COLUMN     "startDate" TIMESTAMP(3),
ADD COLUMN     "startMode" TEXT NOT NULL DEFAULT 'IMMEDIATE',
ADD COLUMN     "stripeCheckoutSessionId" TEXT;

-- AlterTable
ALTER TABLE "members" ADD COLUMN     "city" TEXT,
ADD COLUMN     "customFieldValues" TEXT NOT NULL DEFAULT '{}',
ADD COLUMN     "email" TEXT,
ADD COLUMN     "gender" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "profileImageUrl" TEXT,
ADD COLUMN     "state" TEXT,
ADD COLUMN     "streetAddress" TEXT,
ADD COLUMN     "zipCode" TEXT;

-- AlterTable
ALTER TABLE "memberships" ADD COLUMN     "allowBillingDayOverride" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "allowCustomDates" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "allowManualRenewal" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "autoRenewDefault" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "contractMonths" INTEGER,
ADD COLUMN     "defaultBillingDay" INTEGER,
ADD COLUMN     "purchaseAccess" TEXT NOT NULL DEFAULT 'ANYONE';

-- AlterTable
ALTER TABLE "staff_profiles" ADD COLUMN     "appointmentPrice" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "stripeChargeId" TEXT,
ADD COLUMN     "stripeInvoiceId" TEXT,
ADD COLUMN     "stripeSubscriptionId" TEXT,
ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'CHARGE';

-- CreateTable
CREATE TABLE "custom_fields" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "fieldType" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "options" TEXT NOT NULL DEFAULT '[]',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "club_event_types" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#F1EFE8',
    "textColor" TEXT NOT NULL DEFAULT '#5F5E5A',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "club_event_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_sessions" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "name" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "event_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'OTHER',
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isRecurring" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_groups" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'GROUP',
    "filterType" TEXT,
    "filterValue" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_group_members" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "message_group_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_messages" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "club_profiles" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "termForMember" TEXT NOT NULL DEFAULT 'Member',
    "termForCoach" TEXT NOT NULL DEFAULT 'Coach',
    "termForClass" TEXT NOT NULL DEFAULT 'Class',
    "termForEvent" TEXT NOT NULL DEFAULT 'Event',
    "termForMembership" TEXT NOT NULL DEFAULT 'Membership',
    "welcomeMessage" TEXT,
    "accentColor" TEXT,
    "portalSections" JSONB NOT NULL DEFAULT '["schedule","documents","profile"]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "club_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_entities" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "locationId" TEXT,
    "name" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "ein" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "legal_entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "donation_links" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "url" TEXT,
    "stripePaymentLinkId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "donation_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discounts" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "value" DECIMAL(10,2) NOT NULL,
    "maxUses" INTEGER,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "membershipIds" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" DECIMAL(10,2) NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'OTHER',
    "imageUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "trackInventory" BOOLEAN NOT NULL DEFAULT false,
    "inventory" INTEGER,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_sales" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "memberId" TEXT,
    "soldById" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "totalAmount" DECIMAL(10,2) NOT NULL,
    "discountCode" TEXT,
    "discountAmount" DECIMAL(10,2),
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "stripeCheckoutSessionId" TEXT,
    "stripePaymentIntentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_availability" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_availability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_availability_exceptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'BLOCKED',
    "startTime" TEXT,
    "endTime" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_availability_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_staff_assignments" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'COACH',

    CONSTRAINT "event_staff_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "private_lesson_types" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "locationId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "durationMin" INTEGER NOT NULL DEFAULT 60,
    "maxAthletes" INTEGER NOT NULL DEFAULT 1,
    "basePrice" DECIMAL(10,2) NOT NULL,
    "coachTierLabel" TEXT,
    "eligibleCoachIds" JSONB NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "private_lesson_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "private_packages" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "lessonTypeId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "credits" INTEGER NOT NULL,
    "bonusCredits" INTEGER NOT NULL DEFAULT 0,
    "price" DECIMAL(10,2) NOT NULL,
    "expiresAfterDays" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "private_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "private_credit_ledger" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "packageId" TEXT,
    "lessonTypeId" TEXT,
    "creditsGranted" INTEGER NOT NULL,
    "creditsUsed" INTEGER NOT NULL DEFAULT 0,
    "purchaseType" TEXT NOT NULL DEFAULT 'PACKAGE',
    "expiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "stripeCheckoutSessionId" TEXT,
    "stripePaymentIntentId" TEXT,
    "pricePaid" DECIMAL(10,2),
    "notes" TEXT,
    "adjustedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "private_credit_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "private_bookings" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "lessonTypeId" TEXT NOT NULL,
    "coachId" TEXT,
    "requestedSlots" JSONB NOT NULL DEFAULT '[]',
    "confirmedStartAt" TIMESTAMP(3),
    "confirmedEndAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "creditLedgerId" TEXT,
    "paymentType" TEXT,
    "pricePaid" DECIMAL(10,2),
    "stripeCheckoutSessionId" TEXT,
    "allowUnpaid" BOOLEAN NOT NULL DEFAULT false,
    "ownerApproved" BOOLEAN NOT NULL DEFAULT false,
    "canceledAt" TIMESTAMP(3),
    "canceledById" TEXT,
    "cancelReason" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "private_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "private_lesson_pay_rates" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lessonTypeId" TEXT NOT NULL,
    "payType" TEXT NOT NULL,
    "payValue" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "private_lesson_pay_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurring_classes" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "locationId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "daysOfWeek" JSONB NOT NULL DEFAULT '[]',
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "capacity" INTEGER,
    "recurrenceStartDate" TIMESTAMP(3) NOT NULL,
    "recurrenceEndDate" TIMESTAMP(3),
    "pricingOptions" JSONB NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "recurring_classes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "class_sessions" (
    "id" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "canceled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "class_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_records" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "classSessionId" TEXT,
    "eventId" TEXT,
    "memberId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PRESENT',
    "checkedInAt" TIMESTAMP(3),
    "addedById" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "custom_fields_clubId_idx" ON "custom_fields"("clubId");

-- CreateIndex
CREATE INDEX "club_event_types_clubId_idx" ON "club_event_types"("clubId");

-- CreateIndex
CREATE INDEX "event_sessions_eventId_idx" ON "event_sessions"("eventId");

-- CreateIndex
CREATE INDEX "expenses_clubId_idx" ON "expenses"("clubId");

-- CreateIndex
CREATE INDEX "expenses_date_idx" ON "expenses"("date");

-- CreateIndex
CREATE INDEX "message_groups_clubId_idx" ON "message_groups"("clubId");

-- CreateIndex
CREATE UNIQUE INDEX "message_group_members_groupId_userId_key" ON "message_group_members"("groupId", "userId");

-- CreateIndex
CREATE INDEX "group_messages_groupId_idx" ON "group_messages"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "club_profiles_clubId_key" ON "club_profiles"("clubId");

-- CreateIndex
CREATE INDEX "legal_entities_clubId_idx" ON "legal_entities"("clubId");

-- CreateIndex
CREATE INDEX "donation_links_clubId_idx" ON "donation_links"("clubId");

-- CreateIndex
CREATE INDEX "discounts_clubId_idx" ON "discounts"("clubId");

-- CreateIndex
CREATE UNIQUE INDEX "discounts_clubId_code_key" ON "discounts"("clubId", "code");

-- CreateIndex
CREATE INDEX "products_clubId_idx" ON "products"("clubId");

-- CreateIndex
CREATE INDEX "product_sales_clubId_idx" ON "product_sales"("clubId");

-- CreateIndex
CREATE INDEX "product_sales_memberId_idx" ON "product_sales"("memberId");

-- CreateIndex
CREATE INDEX "staff_availability_userId_idx" ON "staff_availability"("userId");

-- CreateIndex
CREATE INDEX "staff_availability_clubId_idx" ON "staff_availability"("clubId");

-- CreateIndex
CREATE INDEX "staff_availability_exceptions_userId_idx" ON "staff_availability_exceptions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "staff_availability_exceptions_userId_date_key" ON "staff_availability_exceptions"("userId", "date");

-- CreateIndex
CREATE INDEX "event_staff_assignments_clubId_idx" ON "event_staff_assignments"("clubId");

-- CreateIndex
CREATE INDEX "event_staff_assignments_eventId_idx" ON "event_staff_assignments"("eventId");

-- CreateIndex
CREATE INDEX "event_staff_assignments_userId_idx" ON "event_staff_assignments"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "event_staff_assignments_eventId_userId_key" ON "event_staff_assignments"("eventId", "userId");

-- CreateIndex
CREATE INDEX "private_lesson_types_clubId_idx" ON "private_lesson_types"("clubId");

-- CreateIndex
CREATE INDEX "private_packages_clubId_idx" ON "private_packages"("clubId");

-- CreateIndex
CREATE INDEX "private_credit_ledger_clubId_idx" ON "private_credit_ledger"("clubId");

-- CreateIndex
CREATE INDEX "private_credit_ledger_memberId_idx" ON "private_credit_ledger"("memberId");

-- CreateIndex
CREATE INDEX "private_credit_ledger_status_idx" ON "private_credit_ledger"("status");

-- CreateIndex
CREATE INDEX "private_bookings_clubId_idx" ON "private_bookings"("clubId");

-- CreateIndex
CREATE INDEX "private_bookings_memberId_idx" ON "private_bookings"("memberId");

-- CreateIndex
CREATE INDEX "private_bookings_coachId_idx" ON "private_bookings"("coachId");

-- CreateIndex
CREATE INDEX "private_bookings_status_idx" ON "private_bookings"("status");

-- CreateIndex
CREATE INDEX "private_lesson_pay_rates_clubId_idx" ON "private_lesson_pay_rates"("clubId");

-- CreateIndex
CREATE UNIQUE INDEX "private_lesson_pay_rates_userId_lessonTypeId_key" ON "private_lesson_pay_rates"("userId", "lessonTypeId");

-- CreateIndex
CREATE INDEX "recurring_classes_clubId_idx" ON "recurring_classes"("clubId");

-- CreateIndex
CREATE INDEX "class_sessions_classId_idx" ON "class_sessions"("classId");

-- CreateIndex
CREATE INDEX "class_sessions_clubId_idx" ON "class_sessions"("clubId");

-- CreateIndex
CREATE INDEX "class_sessions_date_idx" ON "class_sessions"("date");

-- CreateIndex
CREATE INDEX "attendance_records_clubId_idx" ON "attendance_records"("clubId");

-- CreateIndex
CREATE INDEX "attendance_records_memberId_idx" ON "attendance_records"("memberId");

-- CreateIndex
CREATE INDEX "attendance_records_classSessionId_idx" ON "attendance_records"("classSessionId");

-- CreateIndex
CREATE INDEX "attendance_records_eventId_idx" ON "attendance_records"("eventId");

-- CreateIndex
CREATE INDEX "member_subscriptions_status_idx" ON "member_subscriptions"("status");

-- CreateIndex
CREATE INDEX "member_subscriptions_endDate_idx" ON "member_subscriptions"("endDate");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_stripeChargeId_key" ON "transactions"("stripeChargeId");

-- AddForeignKey
ALTER TABLE "custom_fields" ADD CONSTRAINT "custom_fields_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "club_event_types" ADD CONSTRAINT "club_event_types_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_customEventTypeId_fkey" FOREIGN KEY ("customEventTypeId") REFERENCES "club_event_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_sessions" ADD CONSTRAINT "event_sessions_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_groups" ADD CONSTRAINT "message_groups_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_group_members" ADD CONSTRAINT "message_group_members_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "message_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_group_members" ADD CONSTRAINT "message_group_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_messages" ADD CONSTRAINT "group_messages_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "message_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_messages" ADD CONSTRAINT "group_messages_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "club_profiles" ADD CONSTRAINT "club_profiles_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_entities" ADD CONSTRAINT "legal_entities_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_entities" ADD CONSTRAINT "legal_entities_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "donation_links" ADD CONSTRAINT "donation_links_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "donation_links" ADD CONSTRAINT "donation_links_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "legal_entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_sales" ADD CONSTRAINT "product_sales_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_sales" ADD CONSTRAINT "product_sales_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_sales" ADD CONSTRAINT "product_sales_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_availability" ADD CONSTRAINT "staff_availability_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_availability" ADD CONSTRAINT "staff_availability_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_availability_exceptions" ADD CONSTRAINT "staff_availability_exceptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_availability_exceptions" ADD CONSTRAINT "staff_availability_exceptions_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_staff_assignments" ADD CONSTRAINT "event_staff_assignments_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_staff_assignments" ADD CONSTRAINT "event_staff_assignments_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_staff_assignments" ADD CONSTRAINT "event_staff_assignments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "private_lesson_types" ADD CONSTRAINT "private_lesson_types_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "private_lesson_types" ADD CONSTRAINT "private_lesson_types_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "private_packages" ADD CONSTRAINT "private_packages_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "private_packages" ADD CONSTRAINT "private_packages_lessonTypeId_fkey" FOREIGN KEY ("lessonTypeId") REFERENCES "private_lesson_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "private_credit_ledger" ADD CONSTRAINT "private_credit_ledger_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "private_credit_ledger" ADD CONSTRAINT "private_credit_ledger_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "private_credit_ledger" ADD CONSTRAINT "private_credit_ledger_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "private_packages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "private_bookings" ADD CONSTRAINT "private_bookings_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "private_bookings" ADD CONSTRAINT "private_bookings_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "private_bookings" ADD CONSTRAINT "private_bookings_lessonTypeId_fkey" FOREIGN KEY ("lessonTypeId") REFERENCES "private_lesson_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "private_bookings" ADD CONSTRAINT "private_bookings_coachId_fkey" FOREIGN KEY ("coachId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "private_bookings" ADD CONSTRAINT "private_bookings_creditLedgerId_fkey" FOREIGN KEY ("creditLedgerId") REFERENCES "private_credit_ledger"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "private_lesson_pay_rates" ADD CONSTRAINT "private_lesson_pay_rates_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "private_lesson_pay_rates" ADD CONSTRAINT "private_lesson_pay_rates_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "private_lesson_pay_rates" ADD CONSTRAINT "private_lesson_pay_rates_lessonTypeId_fkey" FOREIGN KEY ("lessonTypeId") REFERENCES "private_lesson_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_classes" ADD CONSTRAINT "recurring_classes_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_classes" ADD CONSTRAINT "recurring_classes_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_classId_fkey" FOREIGN KEY ("classId") REFERENCES "recurring_classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_classSessionId_fkey" FOREIGN KEY ("classSessionId") REFERENCES "class_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
