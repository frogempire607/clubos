-- Public-link registrants with no account can save a card for a "saved card,
-- charged later" event (Finger Lakes Duals, 2026-09-25). A member's card lives
-- on the member; a guest has no member row, so the Stripe customer and payment
-- method saved through the public link live on the registration itself.
-- Additive; every existing row stays null.
ALTER TABLE "event_registrations" ADD COLUMN IF NOT EXISTS "guestStripeCustomerId" TEXT;
ALTER TABLE "event_registrations" ADD COLUMN IF NOT EXISTS "guestStripePaymentMethodId" TEXT;
