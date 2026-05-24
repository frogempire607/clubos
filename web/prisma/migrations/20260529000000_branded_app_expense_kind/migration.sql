-- Branded app personalization (Club) + Expense.kind (FIXED|VARIABLE).
-- Idempotent.
ALTER TABLE "clubs" ADD COLUMN IF NOT EXISTS "appFontFamily" TEXT;
ALTER TABLE "clubs" ADD COLUMN IF NOT EXISTS "appTextAlign" TEXT;
ALTER TABLE "clubs" ADD COLUMN IF NOT EXISTS "appHomeContent" TEXT;
ALTER TABLE "clubs" ADD COLUMN IF NOT EXISTS "appCopy" JSONB;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "kind" TEXT;
