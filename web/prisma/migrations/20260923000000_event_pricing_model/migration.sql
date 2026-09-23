-- Event pricing model — B11 slice 2.
--
-- WRITTEN BUT NOT APPLIED. Julian applies it, BEFORE the code that reads these
-- columns is deployed:
--     cd web && npx prisma migrate deploy
--
-- Everything here is ADDITIVE and BACKFILLED. No column is dropped, no value
-- is rewritten: the old columns (variableCostEnabled, dropInFee, visibility,
-- purchaseAccess, publicRegistration, invoiceScheduledAt) stay exactly as they
-- are and keep being written by the API, so the old reads keep working and the
-- backfill can be checked against them row by row. Existing registrations are
-- not touched: EventRegistration.amountDue is a snapshot and stays one.
--
-- pricingModel   FREE | FIXED | SPLIT      derived from variableCostEnabled + prices
-- signupAccess   MEMBERS | PUBLIC_LINK | STAFF_ONLY
--                staff-only wins over everything, public link wins over members
-- splitInvoiceWhen  AFTER_EVENT | ON_DATE  (SPLIT only; ON_DATE when a date was already picked)
-- sellIndividualSessions                   true where a drop-in fee existed
-- event_sessions.price                     backfilled from dropInFee on multi-session events
-- event_registrations.sessionIds           which sessions a per-session purchase bought ([] = whole event)

ALTER TABLE "event_sessions" ADD COLUMN "price" DECIMAL(10,2);

ALTER TABLE "events" ADD COLUMN "pricingModel" TEXT NOT NULL DEFAULT 'FIXED';
ALTER TABLE "events" ADD COLUMN "signupAccess" TEXT NOT NULL DEFAULT 'MEMBERS';
ALTER TABLE "events" ADD COLUMN "splitInvoiceWhen" TEXT;
ALTER TABLE "events" ADD COLUMN "sellIndividualSessions" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "event_registrations" ADD COLUMN "sessionIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- pricingModel
UPDATE "events" SET "pricingModel" = 'SPLIT' WHERE "variableCostEnabled" = true;
UPDATE "events" SET "pricingModel" = 'FREE'
 WHERE "variableCostEnabled" = false
   AND COALESCE("memberPrice", 0) = 0
   AND COALESCE("nonMemberPrice", 0) = 0
   AND COALESCE("dropInFee", 0) = 0;

-- signupAccess
UPDATE "events" SET "signupAccess" = 'STAFF_ONLY'
 WHERE "purchaseAccess" = 'STAFF_ONLY' OR "visibility" = 'STAFF_ONLY';
UPDATE "events" SET "signupAccess" = 'PUBLIC_LINK'
 WHERE "signupAccess" = 'MEMBERS' AND "publicRegistration" = true;

-- splitInvoiceWhen (SPLIT only)
UPDATE "events" SET "splitInvoiceWhen" = CASE WHEN "invoiceScheduledAt" IS NOT NULL THEN 'ON_DATE' ELSE 'AFTER_EVENT' END
 WHERE "pricingModel" = 'SPLIT';

-- sellIndividualSessions + per-session price from the old single drop-in fee
UPDATE "events" SET "sellIndividualSessions" = true
 WHERE "pricingModel" = 'FIXED' AND COALESCE("dropInFee", 0) > 0;
UPDATE "event_sessions" s SET "price" = e."dropInFee"
  FROM "events" e
 WHERE s."eventId" = e.id
   AND e."sellIndividualSessions" = true
   AND s."price" IS NULL;
