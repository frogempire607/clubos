-- Staff pay reminders. Additive only: one nullable column + one new table.

-- Which payday a PAYROLL payout settles (date-only).
ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "payPeriodEnd" DATE;
CREATE INDEX IF NOT EXISTS "payouts_clubId_payeeUserId_payPeriodEnd_idx"
  ON "payouts" ("clubId", "payeeUserId", "payPeriodEnd");

CREATE TABLE IF NOT EXISTS "staff_pay_schedules" (
  "id"             TEXT NOT NULL,
  "clubId"         TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "frequency"      TEXT NOT NULL,
  "anchorDate"     DATE NOT NULL,
  "active"         BOOLEAN NOT NULL DEFAULT true,
  "lastEmailedFor" DATE,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "staff_pay_schedules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "staff_pay_schedules_userId_key"
  ON "staff_pay_schedules" ("userId");
CREATE INDEX IF NOT EXISTS "staff_pay_schedules_clubId_idx"
  ON "staff_pay_schedules" ("clubId");

-- Same tenant policy as every other club table (20260702000000_enable_rls).
ALTER TABLE "staff_pay_schedules" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "staff_pay_schedules";
CREATE POLICY tenant_isolation ON "staff_pay_schedules" FOR ALL
  USING ("clubId" = app.current_club_id())
  WITH CHECK ("clubId" = app.current_club_id());
