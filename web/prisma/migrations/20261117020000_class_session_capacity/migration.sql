-- ═══════════════════════════════════════════════════════════════════════════
-- Class limits — a limit for one class day
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ADDITIVE ONLY. One nullable column. No existing row is rewritten: every
-- class day reads NULL, which means "use the class's own limit", which is
-- exactly today's behaviour.
--
--   pg_dump first (CLAUDE.md, "Database safety"), then:
--   cd web && npx prisma migrate deploy
--
-- Idempotent.

ALTER TABLE "class_sessions" ADD COLUMN IF NOT EXISTS "capacity" INTEGER;
