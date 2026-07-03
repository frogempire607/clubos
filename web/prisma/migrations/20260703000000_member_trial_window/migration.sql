-- Membership-agnostic free-trial window on the member. Granted by staff
-- (attendance "Trial" check-in or member edit); while active the member can
-- book classes free in the portal without committing to a specific plan.
ALTER TABLE "members" ADD COLUMN IF NOT EXISTS "trialEndsAt" TIMESTAMP(3);
