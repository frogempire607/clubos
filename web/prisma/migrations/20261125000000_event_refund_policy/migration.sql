-- ═══════════════════════════════════════════════════════════════════════════
-- Event refund policy
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ADDITIVE ONLY. Four nullable columns on "events". No existing row is
-- rewritten: every event reads NULL, which means "not set", and families are
-- shown nothing until staff pick a policy.
--
--   refundPolicy     ANYTIME | UNTIL | UNTIL_CHARGED | NONE  (NULL = not set)
--   refundUntilAt    UNTIL, a date and time: the moment refunds stop
--   refundUntilDays  UNTIL, days before the event starts (in the club's timezone)
--   refundNote       optional words, e.g. "Weigh-in fees are non-refundable"
--
--   pg_dump first (CLAUDE.md, "Database safety"), then, BEFORE the code that
--   reads these columns is pushed:
--   cd web && npx prisma migrate deploy
--
-- Idempotent.

ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "refundPolicy" TEXT;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "refundUntilAt" TIMESTAMP(3);
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "refundUntilDays" INTEGER;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "refundNote" TEXT;
