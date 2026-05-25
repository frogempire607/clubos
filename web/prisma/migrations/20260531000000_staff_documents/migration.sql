-- Owner-uploaded documents on staff profiles (tax docs, contracts, etc.).
-- Idempotent.

CREATE TABLE IF NOT EXISTS "staff_documents" (
  "id"              TEXT PRIMARY KEY,
  "clubId"          TEXT NOT NULL,
  "userId"          TEXT NOT NULL,
  "fileId"          TEXT,
  "fileUrl"         TEXT NOT NULL,
  "fileName"        TEXT,
  "mimeType"        TEXT,
  "sizeBytes"       INTEGER,
  "title"           TEXT NOT NULL,
  "kind"            TEXT NOT NULL DEFAULT 'OTHER',
  "notes"           TEXT,
  "sharedWithStaff" BOOLEAN NOT NULL DEFAULT false,
  "uploadedById"    TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt"       TIMESTAMP(3)
);

DO $$ BEGIN
  ALTER TABLE "staff_documents" ADD CONSTRAINT "staff_documents_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "staff_documents" ADD CONSTRAINT "staff_documents_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "staff_documents" ADD CONSTRAINT "staff_documents_uploadedById_fkey"
    FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "staff_documents_clubId_idx" ON "staff_documents"("clubId");
CREATE INDEX IF NOT EXISTS "staff_documents_userId_idx" ON "staff_documents"("userId");
