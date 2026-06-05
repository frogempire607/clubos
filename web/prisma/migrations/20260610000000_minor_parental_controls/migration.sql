-- P4 / M3 — minor parental-controls foundation.
--
-- Pure additive:
--   * members.birthdayLockedAt (nullable) — when set, the minor cannot
--     edit their own DOB from the member portal. Owner/guardian server
--     actions clear this field first.
--   * members.parentControls (nullable JSONB) — per-minor parent toggles.
--     Shape: { requirePaymentApproval, monitoredMessaging,
--              allowPackagePurchase, dailySpendLimit? }.
--     Null = no controls = existing behavior. Stored as JSON so future
--     toggles don't need a migration each time.
--   * pending_approvals — gate row written when a controlled minor
--     attempts a paid action; guardian approves/declines and the booking
--     flow replays the payload.
--
-- Idempotent: every statement guarded by IF (NOT) EXISTS. Re-runs are
-- no-ops, which matches the rest of this project's hand-written
-- migrations (shadow DB doesn't work locally so `prisma migrate dev` is
-- bypassed in favor of `migrate deploy` against pre-written SQL).

ALTER TABLE "members"
  ADD COLUMN IF NOT EXISTS "birthdayLockedAt" TIMESTAMP(3);

ALTER TABLE "members"
  ADD COLUMN IF NOT EXISTS "parentControls" JSONB;

CREATE TABLE IF NOT EXISTS "pending_approvals" (
  "id"            TEXT PRIMARY KEY,
  "clubId"        TEXT         NOT NULL,
  "memberId"      TEXT         NOT NULL,
  "kind"          TEXT         NOT NULL,
  "payload"       JSONB        NOT NULL,
  "amount"        DECIMAL(10,2),
  "status"        TEXT         NOT NULL DEFAULT 'PENDING',
  "requestedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "respondedAt"   TIMESTAMP(3),
  "respondedById" TEXT
);

CREATE INDEX IF NOT EXISTS "pending_approvals_clubId_idx"
  ON "pending_approvals"("clubId");

CREATE INDEX IF NOT EXISTS "pending_approvals_memberId_status_idx"
  ON "pending_approvals"("memberId", "status");

ALTER TABLE "pending_approvals"
  DROP CONSTRAINT IF EXISTS "pending_approvals_clubId_fkey";
ALTER TABLE "pending_approvals"
  ADD CONSTRAINT "pending_approvals_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "clubs"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pending_approvals"
  DROP CONSTRAINT IF EXISTS "pending_approvals_memberId_fkey";
ALTER TABLE "pending_approvals"
  ADD CONSTRAINT "pending_approvals_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "members"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
