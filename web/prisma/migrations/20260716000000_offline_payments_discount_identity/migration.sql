-- Staff payment-method control + discount identity (additive only).
--
-- clubs.offlineActivationPolicy: when a CASH/CHECK offer is accepted by the
-- client, does the membership activate immediately ('ON_ACCEPTANCE', payment
-- still due) or only when staff records the money as physically received
-- ('ON_PAYMENT')? NULL = code default (ON_PAYMENT — the safer rule — for
-- migration/reactivation offers).
ALTER TABLE "clubs" ADD COLUMN "offlineActivationPolicy" TEXT;

-- Discount identity on the money ledger itself: which discount produced this
-- amount. Populated wherever a staff/member purchase applies a discount, so
-- Financials/reports/receipts can say "SIBLING Discount Applied" without
-- parsing free text.
ALTER TABLE "transactions" ADD COLUMN "discountCode" TEXT;
ALTER TABLE "transactions" ADD COLUMN "discountAmount" DECIMAL(10,2);
