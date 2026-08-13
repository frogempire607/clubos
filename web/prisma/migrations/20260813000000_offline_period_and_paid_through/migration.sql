-- Offline subscription periods + paid-through tracking.
--
-- WRITTEN, NOT APPLIED. Apply from the web/ directory with:
--   npx prisma migrate deploy
-- (never `migrate dev` — the shadow database is blocked by the pooler).
--
-- ── Why ─────────────────────────────────────────────────────────────────────
--
-- `member_subscriptions.currentPeriodEnd` was written only by the Stripe
-- reconciler (lib/stripeSync.ts), so every cash-paid subscription had it null.
-- Nothing in the app knew when a paid-up quarter or year expired: renewal
-- alerts, "who owes money", and the unused-time credit on a price change were
-- all blind to offline members. Code now stamps it at creation; this migration
-- adds the second half — a record of how far the money reaches.
--
-- `paidThroughDate` is deliberately NOT the same field as `currentPeriodEnd`.
-- A family can hand over two quarters at once, which puts paidThroughDate six
-- months out while the current billing period still ends in three. Collapsing
-- them would make a prepayment indistinguishable from an early renewal.
--
-- The `covers*` columns on transactions are the auditable side: they record
-- what a specific payment bought, so paidThroughDate can always be re-derived
-- rather than trusted blindly.
--
-- ── Safety ──────────────────────────────────────────────────────────────────
--
-- Purely additive. Four nullable columns, no defaults, no backfill, no rewrite
-- of any existing row. Every column starts NULL, which the code reads as
-- "unknown" — the same thing it reads today for the absent data. Nothing
-- changes behaviour until the backfill is run deliberately
-- (scripts/backfill-offline-periods.ts, dry-run by default).
--
-- Reversible: DROP the four columns.

-- How far the money reaches on this subscription. NULL = unknown; never
-- interpreted as "paid" and never inferred.
ALTER TABLE "member_subscriptions"
  ADD COLUMN IF NOT EXISTS "paidThroughDate" TIMESTAMP(3);

-- What span of membership a given payment actually bought. NULL on every
-- payment that does not buy membership time (event fees, products,
-- adjustments), which is why there is no default.
ALTER TABLE "transactions"
  ADD COLUMN IF NOT EXISTS "coversPeriods" INTEGER,
  ADD COLUMN IF NOT EXISTS "coversStart"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "coversEnd"     TIMESTAMP(3);

-- Renewal sweeps and the "expiring soon" probes filter on these dates across a
-- club, so both get an index. Partial: the vast majority of rows are NULL and
-- indexing those buys nothing.
CREATE INDEX IF NOT EXISTS "member_subscriptions_paidThroughDate_idx"
  ON "member_subscriptions" ("paidThroughDate")
  WHERE "paidThroughDate" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "transactions_coversEnd_idx"
  ON "transactions" ("coversEnd")
  WHERE "coversEnd" IS NOT NULL;
