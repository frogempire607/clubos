CREATE TABLE IF NOT EXISTS "announcement_engagements" (
  "id" TEXT NOT NULL,
  "clubId" TEXT NOT NULL,
  "announcementId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "openedAt" TIMESTAMP(3),
  "openCount" INTEGER NOT NULL DEFAULT 0,
  "clickedAt" TIMESTAMP(3),
  "clickCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "announcement_engagements_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "group_message_receipts" (
  "id" TEXT NOT NULL,
  "clubId" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "groupMessageId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "group_message_receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "announcement_engagements_announcementId_userId_key"
  ON "announcement_engagements"("announcementId", "userId");
CREATE INDEX IF NOT EXISTS "announcement_engagements_clubId_idx" ON "announcement_engagements"("clubId");
CREATE INDEX IF NOT EXISTS "announcement_engagements_userId_idx" ON "announcement_engagements"("userId");

CREATE UNIQUE INDEX IF NOT EXISTS "group_message_receipts_groupMessageId_userId_key"
  ON "group_message_receipts"("groupMessageId", "userId");
CREATE INDEX IF NOT EXISTS "group_message_receipts_clubId_idx" ON "group_message_receipts"("clubId");
CREATE INDEX IF NOT EXISTS "group_message_receipts_groupId_idx" ON "group_message_receipts"("groupId");
CREATE INDEX IF NOT EXISTS "group_message_receipts_userId_idx" ON "group_message_receipts"("userId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'announcement_engagements_clubId_fkey'
  ) THEN
    ALTER TABLE "announcement_engagements"
      ADD CONSTRAINT "announcement_engagements_clubId_fkey"
      FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'announcement_engagements_announcementId_fkey'
  ) THEN
    ALTER TABLE "announcement_engagements"
      ADD CONSTRAINT "announcement_engagements_announcementId_fkey"
      FOREIGN KEY ("announcementId") REFERENCES "announcements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'announcement_engagements_userId_fkey'
  ) THEN
    ALTER TABLE "announcement_engagements"
      ADD CONSTRAINT "announcement_engagements_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'group_message_receipts_clubId_fkey'
  ) THEN
    ALTER TABLE "group_message_receipts"
      ADD CONSTRAINT "group_message_receipts_clubId_fkey"
      FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'group_message_receipts_groupMessageId_fkey'
  ) THEN
    ALTER TABLE "group_message_receipts"
      ADD CONSTRAINT "group_message_receipts_groupMessageId_fkey"
      FOREIGN KEY ("groupMessageId") REFERENCES "group_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'group_message_receipts_userId_fkey'
  ) THEN
    ALTER TABLE "group_message_receipts"
      ADD CONSTRAINT "group_message_receipts_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
