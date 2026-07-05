-- COPPA parental consent.
--
-- Two new tables, purely additive (no existing data touched):
--   parental_consents        — IMMUTABLE, append-only audit record of a
--                              guardian's explicit consent to collect/use a
--                              specific minor's information. A trigger blocks
--                              UPDATE and DELETE so consent is tamper-evident.
--                              FKs are RESTRICT so an audit row can never be
--                              removed by a cascade from clubs/members/users.
--   guardian_consent_requests — mutable operational token behind the emailed
--                              "complete consent" link. Fulfilling it writes a
--                              parental_consents row; this table can expire /
--                              be consumed / be re-issued.

CREATE TABLE "parental_consents" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "childUserId" TEXT,
    "guardianUserId" TEXT,
    "guardianName" TEXT NOT NULL,
    "guardianEmail" TEXT NOT NULL,
    "relationship" TEXT,
    "termsVersion" TEXT NOT NULL,
    "privacyVersion" TEXT NOT NULL,
    "consentVersion" TEXT NOT NULL,
    "consentText" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "source" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parental_consents_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "parental_consents_memberId_idx" ON "parental_consents"("memberId");
CREATE INDEX "parental_consents_guardianUserId_idx" ON "parental_consents"("guardianUserId");
CREATE INDEX "parental_consents_clubId_idx" ON "parental_consents"("clubId");

ALTER TABLE "parental_consents" ADD CONSTRAINT "parental_consents_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "parental_consents" ADD CONSTRAINT "parental_consents_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "parental_consents" ADD CONSTRAINT "parental_consents_guardianUserId_fkey"
    FOREIGN KEY ("guardianUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "parental_consents" ADD CONSTRAINT "parental_consents_childUserId_fkey"
    FOREIGN KEY ("childUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Immutability: parental_consents is append-only. Block every UPDATE and
-- DELETE at the database level so the record can never be silently edited or
-- removed — the only lawful way to change consent is to INSERT a new row
-- (e.g. re-consent after a Terms/Privacy version change).
CREATE OR REPLACE FUNCTION "parental_consents_block_mutation"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'parental_consents is append-only: % is not permitted (consent records are immutable)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "parental_consents_no_update"
    BEFORE UPDATE ON "parental_consents"
    FOR EACH ROW EXECUTE FUNCTION "parental_consents_block_mutation"();

CREATE TRIGGER "parental_consents_no_delete"
    BEFORE DELETE ON "parental_consents"
    FOR EACH ROW EXECUTE FUNCTION "parental_consents_block_mutation"();

CREATE TABLE "guardian_consent_requests" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "guardianName" TEXT,
    "guardianEmail" TEXT NOT NULL,
    "relationship" TEXT,
    "token" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "guardian_consent_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "guardian_consent_requests_token_key" ON "guardian_consent_requests"("token");
CREATE INDEX "guardian_consent_requests_memberId_idx" ON "guardian_consent_requests"("memberId");

ALTER TABLE "guardian_consent_requests" ADD CONSTRAINT "guardian_consent_requests_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "guardian_consent_requests" ADD CONSTRAINT "guardian_consent_requests_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
