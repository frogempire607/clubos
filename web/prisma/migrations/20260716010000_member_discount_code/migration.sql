-- Owner-selected discount for a member's staged membership offer (staff
-- dropdown). Lives on the member (not the request) so offer staleness
-- comparisons can rebuild the current setup deterministically.
ALTER TABLE "members" ADD COLUMN "migrationDiscountCode" TEXT;
