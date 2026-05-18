-- Club outgoing email identity (idempotent).
ALTER TABLE "clubs" ADD COLUMN IF NOT EXISTS "emailFromName" TEXT;
ALTER TABLE "clubs" ADD COLUMN IF NOT EXISTS "emailReplyTo" TEXT;
