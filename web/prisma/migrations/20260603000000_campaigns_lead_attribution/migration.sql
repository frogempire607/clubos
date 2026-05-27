ALTER TABLE "members"
  ADD COLUMN IF NOT EXISTS "leadSource" TEXT NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS "leadStage" TEXT NOT NULL DEFAULT 'NEW',
  ADD COLUMN IF NOT EXISTS "leadSourceUpdatedAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "campaigns" (
  "id" TEXT NOT NULL,
  "clubId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "startAt" TIMESTAMP(3),
  "endAt" TIMESTAMP(3),
  "audienceFilters" JSONB NOT NULL DEFAULT '{}',
  "linkedAnnouncementIds" JSONB NOT NULL DEFAULT '[]',
  "linkedMessageGroupIds" JSONB NOT NULL DEFAULT '[]',
  "channelPlan" JSONB NOT NULL DEFAULT '[]',
  "revenueAttribution" TEXT NOT NULL DEFAULT 'AUTO',
  "leadAttribution" TEXT NOT NULL DEFAULT 'AUTO',
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "campaign_attributions" (
  "id" TEXT NOT NULL,
  "clubId" TEXT NOT NULL,
  "campaignId" TEXT,
  "memberId" TEXT,
  "transactionId" TEXT,
  "source" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "stage" TEXT NOT NULL DEFAULT 'NEW',
  "revenueAmount" DECIMAL(10, 2),
  "firstTouchAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastTouchAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "campaign_attributions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "campaigns_clubId_idx" ON "campaigns"("clubId");
CREATE INDEX IF NOT EXISTS "campaigns_status_idx" ON "campaigns"("status");
CREATE INDEX IF NOT EXISTS "campaign_attributions_clubId_idx" ON "campaign_attributions"("clubId");
CREATE INDEX IF NOT EXISTS "campaign_attributions_campaignId_idx" ON "campaign_attributions"("campaignId");
CREATE INDEX IF NOT EXISTS "campaign_attributions_memberId_idx" ON "campaign_attributions"("memberId");
CREATE INDEX IF NOT EXISTS "campaign_attributions_source_idx" ON "campaign_attributions"("source");
CREATE INDEX IF NOT EXISTS "campaign_attributions_stage_idx" ON "campaign_attributions"("stage");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'campaigns_clubId_fkey'
  ) THEN
    ALTER TABLE "campaigns"
      ADD CONSTRAINT "campaigns_clubId_fkey"
      FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'campaign_attributions_clubId_fkey'
  ) THEN
    ALTER TABLE "campaign_attributions"
      ADD CONSTRAINT "campaign_attributions_clubId_fkey"
      FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'campaign_attributions_campaignId_fkey'
  ) THEN
    ALTER TABLE "campaign_attributions"
      ADD CONSTRAINT "campaign_attributions_campaignId_fkey"
      FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'campaign_attributions_memberId_fkey'
  ) THEN
    ALTER TABLE "campaign_attributions"
      ADD CONSTRAINT "campaign_attributions_memberId_fkey"
      FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'campaign_attributions_transactionId_fkey'
  ) THEN
    ALTER TABLE "campaign_attributions"
      ADD CONSTRAINT "campaign_attributions_transactionId_fkey"
      FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
