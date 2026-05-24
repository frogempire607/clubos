-- Multi-athlete private lesson bookings: partner table for non-primary
-- participants (other club members, outside non-members, or "need help" placeholders).
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS "private_booking_partners" (
  "id"                    TEXT PRIMARY KEY,
  "clubId"                TEXT NOT NULL,
  "bookingId"             TEXT NOT NULL,
  "kind"                  TEXT NOT NULL,
  "memberId"              TEXT,
  "outsideName"           TEXT,
  "outsideEmail"          TEXT,
  "outsidePhone"          TEXT,
  "outsideInfo"           JSONB,
  "inviteToken"           TEXT,
  "inviteTokenExpiresAt"  TIMESTAMP(3),
  "status"                TEXT NOT NULL DEFAULT 'PENDING_COACH',
  "confirmedAt"           TIMESTAMP(3),
  "respondedAt"           TIMESTAMP(3),
  "notes"                 TEXT,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$ BEGIN
  ALTER TABLE "private_booking_partners"
    ADD CONSTRAINT "private_booking_partners_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "private_booking_partners"
    ADD CONSTRAINT "private_booking_partners_bookingId_fkey"
    FOREIGN KEY ("bookingId") REFERENCES "private_bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "private_booking_partners"
    ADD CONSTRAINT "private_booking_partners_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "private_booking_partners_inviteToken_key" ON "private_booking_partners"("inviteToken");
CREATE INDEX IF NOT EXISTS "private_booking_partners_clubId_idx" ON "private_booking_partners"("clubId");
CREATE INDEX IF NOT EXISTS "private_booking_partners_bookingId_idx" ON "private_booking_partners"("bookingId");
CREATE INDEX IF NOT EXISTS "private_booking_partners_memberId_idx" ON "private_booking_partners"("memberId");
CREATE INDEX IF NOT EXISTS "private_booking_partners_inviteToken_idx" ON "private_booking_partners"("inviteToken");
