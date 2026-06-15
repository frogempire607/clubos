-- Registration options (#5) + expiring fully-paid membership (#6)
--
-- Adds the member-facing registration choices captured on the activation link
-- and an owner flag for an already-paid final period. All additive: every
-- column is nullable except the boolean, which defaults false — so existing
-- rows are unaffected and this is safe to apply to a live database.

-- #6: owner marks the member as already paid through their final period. The
-- activation link then shows "active through <commitmentEndDate>", collects no
-- card, and completes as a non-renewing membership (no subscription).
ALTER TABLE "members" ADD COLUMN "migrationFinalPeriodPaid" BOOLEAN NOT NULL DEFAULT false;

-- #5: member-requested cancellation / end date (owner reviews on approval; it
-- becomes commitmentEndDate + the Stripe subscription's cancel_at).
ALTER TABLE "members" ADD COLUMN "requestedCancellationDate" TIMESTAMP(3);

-- #5: "CARD" | "CASH" | "CHECK" — the payment method chosen at registration.
-- CASH/CHECK collect no card and require full owner approval.
ALTER TABLE "members" ADD COLUMN "requestedPaymentMethod" TEXT;

-- #5: the membership option the member chose at registration, stored as
-- { label, price, billingPeriod }. Honored over the plan's default option.
ALTER TABLE "members" ADD COLUMN "migrationSelectedOption" JSONB;
