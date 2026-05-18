-- Multiple purchase options per private lesson type (idempotent).
ALTER TABLE "private_lesson_types"
  ADD COLUMN IF NOT EXISTS "priceOptions" JSONB NOT NULL DEFAULT '[]';
