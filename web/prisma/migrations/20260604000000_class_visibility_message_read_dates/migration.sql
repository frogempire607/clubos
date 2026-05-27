-- Per-class visibility (PUBLIC | MEMBERS_ONLY | PRIVATE).
-- Idempotent — safe to re-run.
ALTER TABLE "recurring_classes"
  ADD COLUMN IF NOT EXISTS "visibility" TEXT NOT NULL DEFAULT 'MEMBERS_ONLY';
