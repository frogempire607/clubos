-- ─────────────────────────────────────────────────────────────────────────
-- 2026-07-28 · Owner-Financials Phase 1A — Transaction columns
-- ─────────────────────────────────────────────────────────────────────────
-- ADDITIVE. Every column is nullable. Historical rows compute the way they
-- compute today; new columns fill in going forward.
--
--   M1: recordedByUserId  → staff who recorded a cash/offline row
--   M2: athleteMemberId   → payer ≠ beneficiary (guardian pays for child)
--   M3: refund fields     → refundedAmount is pre-existing; add refundedAt,
--                            refundReason, refundedByUserId
--   M4: receipt fields    → receiptUrl, receiptSentAt (Expense already has
--                            receiptUrl; Transaction did not)
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "transactions"
  ADD COLUMN IF NOT EXISTS "recordedByUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "athleteMemberId"  TEXT,
  ADD COLUMN IF NOT EXISTS "refundedAt"       TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "refundReason"     TEXT,
  ADD COLUMN IF NOT EXISTS "refundedByUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "receiptUrl"       TEXT,
  ADD COLUMN IF NOT EXISTS "receiptSentAt"    TIMESTAMP(3);

-- Best-effort backfill on refund fields: any row that reconciliation flipped
-- to VOID clearly settled a refund at some point. Stamp `refundedAt` from
-- `updatedAt` and mark the reason so the Cash/Offline UI can distinguish
-- "voided by reconciliation" from "refunded via a Stripe API call" (which
-- Phase 1A intentionally does NOT trigger — no Stripe writes).
UPDATE "transactions"
   SET "refundedAt"   = COALESCE("refundedAt", "updatedAt"),
       "refundReason" = COALESCE("refundReason", 'reconciled_void')
 WHERE "reconciliationStatus" = 'VOID'
   AND "refundedAt" IS NULL;

-- Indexes that make the Cash/Offline tab + recorded-by columns cheap.
CREATE INDEX IF NOT EXISTS "transactions_paymentSource_idx"
    ON "transactions" ("clubId", "paymentSource", "status");
CREATE INDEX IF NOT EXISTS "transactions_athleteMemberId_idx"
    ON "transactions" ("athleteMemberId");
CREATE INDEX IF NOT EXISTS "transactions_recordedByUserId_idx"
    ON "transactions" ("recordedByUserId");

-- ─────────────────────────────────────────────────────────────────────────
-- ROLLBACK (kept here for reference; NEVER auto-executed):
--   ALTER TABLE "transactions"
--     DROP COLUMN IF EXISTS "recordedByUserId",
--     DROP COLUMN IF EXISTS "athleteMemberId",
--     DROP COLUMN IF EXISTS "refundedAt",
--     DROP COLUMN IF EXISTS "refundReason",
--     DROP COLUMN IF EXISTS "refundedByUserId",
--     DROP COLUMN IF EXISTS "receiptUrl",
--     DROP COLUMN IF EXISTS "receiptSentAt";
--   DROP INDEX IF EXISTS "transactions_paymentSource_idx";
--   DROP INDEX IF EXISTS "transactions_athleteMemberId_idx";
--   DROP INDEX IF EXISTS "transactions_recordedByUserId_idx";
-- ─────────────────────────────────────────────────────────────────────────
