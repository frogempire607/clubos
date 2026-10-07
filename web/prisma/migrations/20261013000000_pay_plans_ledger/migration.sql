-- Branch 2 — pay plans + pay ledger. ADDITIVE, plus one constraint change:
-- a coach may now hold more than one pay plan, so the one-plan-per-coach
-- unique index on staff_compensations("userId") is dropped. No row is
-- changed or removed. Existing plans keep their id, amounts, bonuses and
-- scopes; they are named "Pay plan" and dated from the day they were made.

-- ── Pay plans: many named, dated plans per coach ────────────────────────────
DROP INDEX IF EXISTS "staff_compensations_userId_key";

ALTER TABLE "staff_compensations"
  ADD COLUMN IF NOT EXISTS "name" TEXT NOT NULL DEFAULT 'Pay plan',
  ADD COLUMN IF NOT EXISTS "effectiveFrom" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "effectiveTo" DATE,
  ADD COLUMN IF NOT EXISTS "copiedFromId" TEXT,
  ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "createdByUserId" TEXT;

-- Plans that already exist were in force from the day they were created.
UPDATE "staff_compensations" SET "effectiveFrom" = "createdAt"::date WHERE "effectiveFrom" > "createdAt"::date;

CREATE INDEX IF NOT EXISTS "staff_compensations_clubId_userId_idx" ON "staff_compensations"("clubId", "userId");

-- Existing bonuses keep counting over the pay period, exactly as today.
ALTER TABLE "compensation_bonuses" ADD COLUMN IF NOT EXISTS "countPer" TEXT NOT NULL DEFAULT 'PERIOD';

-- ── Payouts: what a ledger payout covers, and when it was locked ────────────
ALTER TABLE "payouts"
  ADD COLUMN IF NOT EXISTS "periodStart" DATE,
  ADD COLUMN IF NOT EXISTS "lockedAt" TIMESTAMP(3);

-- ── Pay ledger ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "pay_lines" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "component" TEXT NOT NULL DEFAULT 'BASE',
    "workDate" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "units" DECIMAL(10,4) NOT NULL DEFAULT 1,
    "rateCents" INTEGER,
    "amountCents" INTEGER,
    "rateSource" TEXT NOT NULL DEFAULT 'PLAN',
    "planId" TEXT,
    "planName" TEXT,
    "planAmountCents" INTEGER,
    "overrideReason" TEXT,
    "overrideByUserId" TEXT,
    "overrideAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ESTIMATED',
    "reviewReason" TEXT,
    "voidReason" TEXT,
    "voidedByUserId" TEXT,
    "voidedAt" TIMESTAMP(3),
    "payoutId" TEXT,
    "periodStart" DATE,
    "periodEnd" DATE,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pay_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "pay_lines_userId_sourceType_sourceId_component_key" ON "pay_lines"("userId", "sourceType", "sourceId", "component");
CREATE INDEX IF NOT EXISTS "pay_lines_clubId_userId_workDate_idx" ON "pay_lines"("clubId", "userId", "workDate");
CREATE INDEX IF NOT EXISTS "pay_lines_clubId_status_idx" ON "pay_lines"("clubId", "status");
CREATE INDEX IF NOT EXISTS "pay_lines_payoutId_idx" ON "pay_lines"("payoutId");

DO $$ BEGIN
  ALTER TABLE "pay_lines" ADD CONSTRAINT "pay_lines_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "pay_lines" ADD CONSTRAINT "pay_lines_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "payouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Row level security: same tenant policy as every other club table ────────
ALTER TABLE "pay_lines" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "pay_lines";
CREATE POLICY tenant_isolation ON "pay_lines" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK ("clubId" = app.current_club_id());

-- ── The approved cut-over (Julian, 2026-10-07): the pay ledger starts on
-- Tuesday 2026-10-13 for Frog Empire. Nothing before that date ever gets a pay
-- line. Set only if it has not been set; other clubs choose their own date in
-- Settings → Scheduling.
UPDATE "club_schedule_settings" SET "payLedgerStartsOn" = DATE '2026-10-13'
 WHERE "clubId" = 'cmq9xyrjx00008tc4xck1k9qo' AND "payLedgerStartsOn" IS NULL;
