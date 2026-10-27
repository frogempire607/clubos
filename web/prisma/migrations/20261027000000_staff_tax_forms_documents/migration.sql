-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 12.1 — encrypted TINs, staff worker type + W-9, staff documents
-- Design: web/docs/accounting/plan.md ("1099 — the TIN question")
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ADDITIVE ONLY. Three new tables and a set of nullable columns. Nothing is
-- renamed, dropped or retyped, and no existing row is rewritten — every new
-- column is either nullable or carries a default that reproduces today's
-- behaviour exactly.
--
-- ORDER MATTERS: apply BEFORE deploying the code that reads it.
--
--   cd web && npx prisma migrate deploy
--
-- NOT `migrate dev` — the shadow database is blocked by the Supabase pooler.
-- NEVER pass a production URL to --shadow-database-url.
--
-- ⚠️  THIS MIGRATION CREATES A TABLE THAT HOLDS TAX IDENTIFICATION NUMBERS.
--     `contractor_w9_submissions.taxIdEncrypted` is AES-256-GCM ciphertext and
--     is only readable with FIELD_ENCRYPTION_KEY. Set that variable BEFORE
--     anybody submits a W-9: the app refuses to save a TIN without it and
--     never falls back to plaintext. Keep a copy of the key in a password
--     manager — a lost key means the stored TINs can never be read again.
--     There is deliberately no index on the ciphertext and nothing joins
--     through it.
--
-- Idempotent throughout, so a partial apply can be re-run safely.

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1 — Contractor: address, and the W-9 pointers
-- ═══════════════════════════════════════════════════════════════════════════
-- A 1099-NEC needs the payee's address and there was nowhere to put one;
-- Phase 12 filed it as a blocker. Column names match `members` so one address
-- formatter serves both.
ALTER TABLE "contractors" ADD COLUMN IF NOT EXISTS "streetAddress" TEXT;
ALTER TABLE "contractors" ADD COLUMN IF NOT EXISTS "city" TEXT;
ALTER TABLE "contractors" ADD COLUMN IF NOT EXISTS "state" TEXT;
ALTER TABLE "contractors" ADD COLUMN IF NOT EXISTS "zipCode" TEXT;

-- NOT_STARTED | SUBMITTED. The default matches every existing contractor's
-- real state: nobody has filled in a W-9 in the app yet.
ALTER TABLE "contractors" ADD COLUMN IF NOT EXISTS "w9Status" TEXT NOT NULL DEFAULT 'NOT_STARTED';

-- A POINTER to the submission in force, not a copy of it. CLAUDE.md records
-- four production bugs caused by a member-level field duplicating a fact that
-- lived elsewhere; copying the TIN ciphertext onto the contractor would be a
-- fifth of exactly that shape, and the stale copy would be the one the 1099
-- report read.
ALTER TABLE "contractors" ADD COLUMN IF NOT EXISTS "w9CurrentSubmissionId" TEXT;

-- The ONLY plaintext fragment of a tax id anywhere: the last four digits, so a
-- list can render "•••-••-1234" without a decryption call. Masked display must
-- never be a decrypt — that is how a decrypt ends up in a log line.
ALTER TABLE "contractors" ADD COLUMN IF NOT EXISTS "taxIdLast4" TEXT;
-- SSN | EIN — which mask to draw. Not sensitive on its own.
ALTER TABLE "contractors" ADD COLUMN IF NOT EXISTS "taxIdKind" TEXT;

ALTER TABLE "contractors" ADD COLUMN IF NOT EXISTS "w9RequestedAt" TIMESTAMP(3);
ALTER TABLE "contractors" ADD COLUMN IF NOT EXISTS "w9RequestedByUserId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "contractors_w9CurrentSubmissionId_key"
  ON "contractors"("w9CurrentSubmissionId");
CREATE INDEX IF NOT EXISTS "contractors_clubId_w9Status_idx"
  ON "contractors"("clubId", "w9Status");

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 2 — the refund fee Phase 12's posting path had nothing to read
-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 12 built planRefund's fee path (the movement goes against 6400
-- Payment Processing Fees) and documented that nothing filled the figure. This
-- is the column, written by the `charge.refunded` webhook from the REFUND's
-- own balance transaction. NULL on every existing row, and NULL means "no fee
-- movement known", which is exactly how Phase 12 behaved.
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "refundFeeAmount" DECIMAL(10,2);

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3 — staff worker type
-- ═══════════════════════════════════════════════════════════════════════════
-- EMPLOYEE (payroll) | CONTRACTOR (W-9 / 1099).
--
-- NULLABLE WITH NO DEFAULT, on purpose. Worker classification is a legal
-- determination with tax consequences, and AthletixOS must not make it for a
-- club by defaulting everyone to one or the other. NULL means "not classified
-- yet" and the UI says so.
ALTER TABLE "staff_profiles" ADD COLUMN IF NOT EXISTS "workerType" TEXT;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 4 — contractor_w9_submissions (HOLDS ENCRYPTED TAX IDS)
-- ═══════════════════════════════════════════════════════════════════════════
-- Every submission is kept. An owner can ask for a fresh W-9 and the old one
-- is superseded rather than overwritten, because what the contractor certified
-- at the time is the record that matters.
CREATE TABLE IF NOT EXISTS "contractor_w9_submissions" (
  "id"                 TEXT NOT NULL,
  "clubId"             TEXT NOT NULL,
  "contractorId"       TEXT NOT NULL,

  "legalName"          TEXT NOT NULL,
  "businessName"       TEXT,
  "taxClassification"  TEXT NOT NULL,
  "classificationNote" TEXT,

  "streetAddress"      TEXT NOT NULL,
  "city"               TEXT NOT NULL,
  "state"              TEXT NOT NULL,
  "zipCode"            TEXT NOT NULL,

  "taxIdKind"          TEXT NOT NULL,
  -- AES-256-GCM, formatted `v1:<keyId>:<iv>:<ciphertext>:<tag>`.
  -- See web/lib/fieldCrypto.ts. No index, and nothing joins through it.
  "taxIdEncrypted"     TEXT NOT NULL,
  -- Last four digits ONLY, plaintext, for masked display.
  "taxIdLast4"         TEXT NOT NULL,

  -- The certification text is snapshotted: what they agreed to must not change
  -- when the app's copy does.
  "certificationText"  TEXT NOT NULL,
  "signedName"         TEXT NOT NULL,
  "signedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "signedByUserId"     TEXT,
  "ipAddress"          TEXT,
  "userAgent"          TEXT,

  "fileId"             TEXT,
  "fileUrl"            TEXT,
  "staffDocumentId"    TEXT,

  "supersededAt"       TIMESTAMP(3),
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "contractor_w9_submissions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "contractor_w9_submissions_clubId_contractorId_idx"
  ON "contractor_w9_submissions"("clubId", "contractorId");
CREATE INDEX IF NOT EXISTS "contractor_w9_submissions_contractorId_signedAt_idx"
  ON "contractor_w9_submissions"("contractorId", "signedAt");

-- A stored tax id must be ciphertext in this format, never a readable value.
-- The service refuses to write plaintext; this is the database saying so too,
-- which is the backstop if anything ever bypasses the service.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contractor_w9_taxid_is_ciphertext') THEN
    ALTER TABLE "contractor_w9_submissions" ADD CONSTRAINT "contractor_w9_taxid_is_ciphertext"
      CHECK ("taxIdEncrypted" ~ '^v[0-9]+:[A-Za-z0-9_-]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contractor_w9_last4_is_four_digits') THEN
    ALTER TABLE "contractor_w9_submissions" ADD CONSTRAINT "contractor_w9_last4_is_four_digits"
      CHECK ("taxIdLast4" ~ '^[0-9]{4}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contractor_w9_taxid_kind') THEN
    ALTER TABLE "contractor_w9_submissions" ADD CONSTRAINT "contractor_w9_taxid_kind"
      CHECK ("taxIdKind" IN ('SSN', 'EIN'));
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 5 — documents: audience + version
-- ═══════════════════════════════════════════════════════════════════════════
-- MEMBER | STAFF. The default reproduces today's behaviour for every existing
-- row and every existing write; only the new staff surfaces write 'STAFF'.
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "audience" TEXT NOT NULL DEFAULT 'MEMBER';
-- Bumped when a STAFF document's body or title changes, so a staff signature
-- can record which version it signed and a new version requires re-signing
-- while the old signatures are kept. Member documents ignore it and keep using
-- signatureValidForDays.
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS "documents_clubId_audience_idx" ON "documents"("clubId", "audience");

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 6 — staff document assignments + signatures
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS "staff_document_assignments" (
  "id"              TEXT NOT NULL,
  "clubId"          TEXT NOT NULL,
  "documentId"      TEXT NOT NULL,
  "scope"           TEXT NOT NULL DEFAULT 'ALL',
  "staffUserId"     TEXT,
  "role"            TEXT,
  "dueDate"         DATE,
  "createdByUserId" TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "staff_document_assignments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "staff_doc_assignment_document_staff_key"
  ON "staff_document_assignments"("documentId", "staffUserId");
CREATE INDEX IF NOT EXISTS "staff_document_assignments_clubId_documentId_idx"
  ON "staff_document_assignments"("clubId", "documentId");
CREATE INDEX IF NOT EXISTS "staff_document_assignments_staffUserId_idx"
  ON "staff_document_assignments"("staffUserId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_doc_assignment_scope') THEN
    ALTER TABLE "staff_document_assignments" ADD CONSTRAINT "staff_doc_assignment_scope"
      CHECK (
        ("scope" = 'ALL'   AND "staffUserId" IS NULL AND "role" IS NULL)
        OR ("scope" = 'ROLE'  AND "staffUserId" IS NULL AND "role" IS NOT NULL)
        OR ("scope" = 'STAFF' AND "staffUserId" IS NOT NULL)
      );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "staff_document_signatures" (
  "id"               TEXT NOT NULL,
  "clubId"           TEXT NOT NULL,
  "documentId"       TEXT NOT NULL,
  "staffUserId"      TEXT NOT NULL,
  "signerName"       TEXT NOT NULL,
  "documentVersion"  INTEGER NOT NULL DEFAULT 1,
  "signedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ipAddress"        TEXT,
  "userAgent"        TEXT,
  "signatureDataUrl" TEXT,
  CONSTRAINT "staff_document_signatures_pkey" PRIMARY KEY ("id")
);

-- One signature per person per VERSION: re-signing a new version is allowed
-- and the old row is kept, which is the whole point.
CREATE UNIQUE INDEX IF NOT EXISTS "staff_doc_signature_unique"
  ON "staff_document_signatures"("documentId", "staffUserId", "documentVersion");
CREATE INDEX IF NOT EXISTS "staff_document_signatures_clubId_documentId_idx"
  ON "staff_document_signatures"("clubId", "documentId");
CREATE INDEX IF NOT EXISTS "staff_document_signatures_staffUserId_idx"
  ON "staff_document_signatures"("staffUserId");

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 7 — foreign keys
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contractor_w9_submissions_clubId_fkey') THEN
    ALTER TABLE "contractor_w9_submissions" ADD CONSTRAINT "contractor_w9_submissions_clubId_fkey"
      FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contractor_w9_submissions_contractorId_fkey') THEN
    ALTER TABLE "contractor_w9_submissions" ADD CONSTRAINT "contractor_w9_submissions_contractorId_fkey"
      FOREIGN KEY ("contractorId") REFERENCES "contractors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  -- SetNull, not Cascade: clearing the pointer must never delete a contractor.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contractors_w9CurrentSubmissionId_fkey') THEN
    ALTER TABLE "contractors" ADD CONSTRAINT "contractors_w9CurrentSubmissionId_fkey"
      FOREIGN KEY ("w9CurrentSubmissionId") REFERENCES "contractor_w9_submissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_document_assignments_clubId_fkey') THEN
    ALTER TABLE "staff_document_assignments" ADD CONSTRAINT "staff_document_assignments_clubId_fkey"
      FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_document_assignments_documentId_fkey') THEN
    ALTER TABLE "staff_document_assignments" ADD CONSTRAINT "staff_document_assignments_documentId_fkey"
      FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_document_assignments_staffUserId_fkey') THEN
    ALTER TABLE "staff_document_assignments" ADD CONSTRAINT "staff_document_assignments_staffUserId_fkey"
      FOREIGN KEY ("staffUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_document_signatures_clubId_fkey') THEN
    ALTER TABLE "staff_document_signatures" ADD CONSTRAINT "staff_document_signatures_clubId_fkey"
      FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_document_signatures_documentId_fkey') THEN
    ALTER TABLE "staff_document_signatures" ADD CONSTRAINT "staff_document_signatures_documentId_fkey"
      FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_document_signatures_staffUserId_fkey') THEN
    ALTER TABLE "staff_document_signatures" ADD CONSTRAINT "staff_document_signatures_staffUserId_fkey"
      FOREIGN KEY ("staffUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 8 — RLS, FK-aware, on the three new tables
-- ═══════════════════════════════════════════════════════════════════════════
-- Cross-club proof: rls/harness/run-tests.ts section T12.
--
-- FK-AWARE where there is an FK to another tenant table. A clubId-only policy
-- is NOT enough there: the clubId check passes and POSTGRES FK CHECKS
-- DELIBERATELY BYPASS RLS, so one club could point a row at another's record.
--
-- Every outer reference is QUALIFIED with its own table name. Phase 12's
-- harness caught a policy that refused every insert because an unqualified
-- column bound to the inner table of the subquery instead of the row being
-- written — and it presented as perfect isolation, because only the positive
-- control failed.

ALTER TABLE "contractor_w9_submissions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "contractor_w9_submissions";
CREATE POLICY tenant_isolation ON "contractor_w9_submissions" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK (
    "clubId" = app.current_club_id()
    AND EXISTS (
      SELECT 1 FROM "contractors" c
      WHERE c."id" = "contractor_w9_submissions"."contractorId"
        AND c."clubId" = app.current_club_id()
    )
  );

ALTER TABLE "staff_document_assignments" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "staff_document_assignments";
CREATE POLICY tenant_isolation ON "staff_document_assignments" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK (
    "clubId" = app.current_club_id()
    AND EXISTS (
      SELECT 1 FROM "documents" d
      WHERE d."id" = "staff_document_assignments"."documentId"
        AND d."clubId" = app.current_club_id()
    )
    -- The staff user must belong to this club too. `users` is club-scoped, so
    -- without this a club could assign its document to another club's staff
    -- member and learn their id exists.
    AND (
      "staff_document_assignments"."staffUserId" IS NULL
      OR EXISTS (
        SELECT 1 FROM "users" u
        WHERE u."id" = "staff_document_assignments"."staffUserId"
          AND u."clubId" = app.current_club_id()
      )
    )
  );

ALTER TABLE "staff_document_signatures" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "staff_document_signatures";
CREATE POLICY tenant_isolation ON "staff_document_signatures" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK (
    "clubId" = app.current_club_id()
    AND EXISTS (
      SELECT 1 FROM "documents" d
      WHERE d."id" = "staff_document_signatures"."documentId"
        AND d."clubId" = app.current_club_id()
    )
    AND EXISTS (
      SELECT 1 FROM "users" u
      WHERE u."id" = "staff_document_signatures"."staffUserId"
        AND u."clubId" = app.current_club_id()
    )
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athletix_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      "contractor_w9_submissions", "staff_document_assignments", "staff_document_signatures"
      TO athletix_app;
  END IF;
END $$;
