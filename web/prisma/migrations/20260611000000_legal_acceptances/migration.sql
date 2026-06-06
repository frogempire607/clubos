-- Task 8 — record of ToS + Privacy acceptance at signup time.
-- Pure additive; every statement guarded with IF (NOT) EXISTS so re-runs
-- are no-ops. Matches the project's hand-written migration pattern
-- (prisma migrate dev is blocked locally on shadow-DB perms).

CREATE TABLE IF NOT EXISTS "legal_acceptances" (
  "id"           TEXT PRIMARY KEY,
  "userId"       TEXT         NOT NULL,
  "clubId"       TEXT,
  "documentType" TEXT         NOT NULL,
  "version"      TEXT         NOT NULL,
  "acceptedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ipAddress"    TEXT,
  "userAgent"    TEXT
);

CREATE INDEX IF NOT EXISTS "legal_acceptances_userId_documentType_idx"
  ON "legal_acceptances"("userId", "documentType");

CREATE INDEX IF NOT EXISTS "legal_acceptances_clubId_documentType_idx"
  ON "legal_acceptances"("clubId", "documentType");

ALTER TABLE "legal_acceptances"
  DROP CONSTRAINT IF EXISTS "legal_acceptances_userId_fkey";
ALTER TABLE "legal_acceptances"
  ADD CONSTRAINT "legal_acceptances_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "legal_acceptances"
  DROP CONSTRAINT IF EXISTS "legal_acceptances_clubId_fkey";
ALTER TABLE "legal_acceptances"
  ADD CONSTRAINT "legal_acceptances_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "clubs"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
