-- Event payroll (guest clinicians + staff compensation per event) and
-- reusable event documents. Additive only.

-- Per-event revenue attribution + refund tracking for percentage comp.
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "eventId" TEXT;
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "refundedAmount" DECIMAL(10,2);
CREATE INDEX IF NOT EXISTS "transactions_eventId_idx" ON "transactions"("eventId");

-- Owner's strict no-refunds policy: percent comp ignores refunds/chargebacks.
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "compNoRefunds" BOOLEAN NOT NULL DEFAULT false;

-- Event attachment semantics on documents.
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "appliesToAllEvents" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "eventRequirement" TEXT NOT NULL DEFAULT 'INFO';

-- Who works an event and how they're paid for it (staff or guest clinician).
CREATE TABLE IF NOT EXISTS "event_comp_assignments" (
  "id"           TEXT NOT NULL,
  "clubId"       TEXT NOT NULL,
  "eventId"      TEXT NOT NULL,
  "payeeType"    TEXT NOT NULL DEFAULT 'STAFF',
  "userId"       TEXT,
  "contractorId" TEXT,
  "payeeName"    TEXT NOT NULL,
  "compMethod"   TEXT NOT NULL DEFAULT 'NONE',
  "flatAmount"   DECIMAL(10,2),
  "percent"      DECIMAL(5,2),
  "basis"        TEXT NOT NULL DEFAULT 'GROSS_COLLECTED',
  "notes"        TEXT,
  "payoutId"     TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "event_comp_assignments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "event_comp_assignments_payoutId_key" ON "event_comp_assignments"("payoutId");
CREATE INDEX IF NOT EXISTS "event_comp_assignments_clubId_idx" ON "event_comp_assignments"("clubId");
CREATE INDEX IF NOT EXISTS "event_comp_assignments_eventId_idx" ON "event_comp_assignments"("eventId");
ALTER TABLE "event_comp_assignments"
  ADD CONSTRAINT "event_comp_assignments_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "event_comp_assignments"
  ADD CONSTRAINT "event_comp_assignments_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "event_comp_assignments"
  ADD CONSTRAINT "event_comp_assignments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "event_comp_assignments"
  ADD CONSTRAINT "event_comp_assignments_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "contractors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Attach existing documents to specific events (All Events lives on documents).
CREATE TABLE IF NOT EXISTS "event_document_links" (
  "id"         TEXT NOT NULL,
  "clubId"     TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "eventId"    TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "event_document_links_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "event_document_links_documentId_eventId_key" ON "event_document_links"("documentId", "eventId");
CREATE INDEX IF NOT EXISTS "event_document_links_clubId_idx" ON "event_document_links"("clubId");
CREATE INDEX IF NOT EXISTS "event_document_links_eventId_idx" ON "event_document_links"("eventId");
ALTER TABLE "event_document_links"
  ADD CONSTRAINT "event_document_links_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "event_document_links"
  ADD CONSTRAINT "event_document_links_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "event_document_links"
  ADD CONSTRAINT "event_document_links_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
