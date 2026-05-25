-- Conditional thresholds on staff compensation bonuses: apply the bonus only
-- after minThreshold attendees/signups and cap at maxThreshold. Idempotent.
ALTER TABLE "compensation_bonuses" ADD COLUMN IF NOT EXISTS "minThreshold" INTEGER;
ALTER TABLE "compensation_bonuses" ADD COLUMN IF NOT EXISTS "maxThreshold" INTEGER;
