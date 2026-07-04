-- Discounts everywhere: codes can now cover any purchase type. appliesTo is a
-- JSON array of type keys (MEMBERSHIP | EVENT | CLASS | PRODUCT |
-- PRIVATE_PACK); [] keeps the default "applies to everything". Additive with
-- a default — safe.
ALTER TABLE "discounts" ADD COLUMN "appliesTo" JSONB NOT NULL DEFAULT '[]';

-- Existing codes that were narrowed to specific membership plans stay
-- memberships-only (they shouldn't silently start applying to products).
UPDATE "discounts"
SET "appliesTo" = '["MEMBERSHIP"]'
WHERE "membershipIds"::text <> '[]';
