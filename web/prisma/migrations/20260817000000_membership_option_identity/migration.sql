-- Phase 8 — option identity and the minimum-term floor.
--
-- WRITTEN BUT NOT APPLIED (plan.md §8.9.1, P8-1/P8-2/P8-3). Julian applies it:
--     cd web && npx prisma migrate deploy
--
-- WHY optionId: a membership option is identified today by its LABEL, matched
-- with `===`. That is not an identity. The migration/approve path writes
-- `optionLabel: planName`, so production carries subscription rows labelled
-- "MS/HS" and "Jr Frogs" beside rows labelled "Monthly" — same plan, same
-- price, same period. Kellan Lister reads "Upfront" for an option since renamed
-- "3 months Upfront". And the billing period is not an identity either: MS/HS
-- already has TWO options billed MONTHLY ($175 full, $110 Tue/Thu), which is
-- why the bulk price tool refuses that plan with AMBIGUOUS_PERIOD. Collapsing
-- the commitment plan into MS/HS makes it FOUR monthly options. An opaque id is
-- the only field that is stable under rename and unique within a plan.
--
-- Nullable, no FK: the target is a key inside a JSON array, not a table. NULL
-- means "not yet identified", and lib/membershipOptions.resolveSubscriptionOption
-- falls back to a unique (billingPeriod, price) match, flagged as inferred, and
-- refuses to guess when that is not unique.
--
-- WHY minimumTermEndsAt, and why NOT `commitmentEndDate`: Stripe has no
-- minimum-term primitive — Subscription Schedules define phases but do not
-- prevent cancellation — so a commitment can only live on our side. It must not
-- reuse the existing `Member.commitmentEndDate`, which means the OPPOSITE
-- thing: that value is passed to Stripe as `cancel_at` and written to
-- `MemberSubscription.endDate`, i.e. the date the membership ENDS. A minimum
-- term is a floor, not a ceiling. Two names, both commented, pointing at each
-- other.
--
-- SAFETY: additive and nullable. No backfill in this migration — option ids are
-- minted and stamped by a separate dry-run-first script, which against today's
-- production data resolves 18 of 27 live subscriptions, leaves 9 null with a
-- printed report, and finds 0 ambiguous.
--
-- ORDER OF OPERATIONS — this matters, do not shortcut it:
--   1. Apply this migration (adds the columns to the database).
--   2. ONLY THEN add `optionId String?` and `minimumTermEndsAt DateTime?` to
--      MemberSubscription in prisma/schema.prisma.
-- `schema.prisma` is deliberately UNCHANGED in this commit. Prisma selects every
-- scalar a model declares, so naming a column the database does not have makes
-- EVERY subscription read fail with "column member_subscriptions.optionId does
-- not exist" the moment it deploys — the billing centre, the member portal, all
-- nine coverage call-sites, the price tool. Not just the new code. This is the
-- same hazard the 20260815000000_member_created_via migration documents.

ALTER TABLE "member_subscriptions" ADD COLUMN IF NOT EXISTS "optionId" TEXT;

ALTER TABLE "member_subscriptions" ADD COLUMN IF NOT EXISTS "minimumTermEndsAt" TIMESTAMP(3);

-- The bulk price tool groups a plan's subscribers by option.
CREATE INDEX IF NOT EXISTS "member_subscriptions_membershipId_optionId_idx"
  ON "member_subscriptions" ("membershipId", "optionId");
