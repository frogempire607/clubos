-- Event discount codes — schema only.
--
-- Additive only. Every column is nullable or carries a default that reproduces
-- today's exact behavior, so applying this changes nothing until the code that
-- reads it ships. No backfill, no rewrite: Postgres 11+ adds a nullable column
-- (and a column with a non-volatile default) as a catalog-only change, so this
-- is a metadata update on `event_registrations` and `discounts`, not a table
-- rewrite. Safe to apply to production while the app is serving traffic.
--
-- Folder sorts after 20260804000000_members_experience (required — `prisma
-- migrate deploy` sorts lexicographically and warns loudly on out-of-order
-- folders).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. event_registrations — the discount the registrant actually agreed to
-- ─────────────────────────────────────────────────────────────────────────────
-- Today an event discount is applied in-flight and then thrown away. The
-- member path (app/api/member/events/[id]/register/route.ts) folds it into
-- `amountDue` and smuggles the code into the `autoChargeConsent` JSON blob so
-- the charge engine can stamp it on a Transaction; the staff at-the-door path
-- (app/api/events/[id]/charge/route.ts) writes it onto the Transaction after
-- settlement. Neither leaves anything on the registration itself, so:
--
--   * the roster cannot show why a row owes less than the event's price;
--   * POST /api/events/[id]/reprice-registrations sees a discounted row as a
--     stale snapshot and rewrites it back to full price (lib/eventRepricing
--     planReprice → `changed`), silently deleting the discount;
--   * bill-registrants flags every discounted row as an AMOUNT_MISMATCH and
--     makes the owner confirm past a warning that means nothing;
--   * a payment link sent later charges the undiscounted price.
--
-- These five columns record the RULE, not just the result. `discountType` +
-- `discountValue` are a snapshot of the Discount row as it stood when the
-- registrant accepted it: the owner may later edit, expire, or delete that
-- code, and none of that may retroactively change what an existing registrant
-- owes. `discountAmount` is the derived dollars-off, recomputed and rewritten
-- by the same paths that write `amountDue` (it is a cache for display and
-- reconciliation — the rule above it is the source of truth).
--
-- `discountId` is a deliberate soft pointer with NO foreign key: the snapshot
-- must outlive deletion of the Discount row. It exists for redemption
-- accounting and audit, never as a read path for pricing.
--
-- `amountDue` keeps its current meaning throughout: the NET amount this
-- registrant owes, after the discount. Nothing about existing rows changes.
ALTER TABLE "event_registrations"
  ADD COLUMN "discountId"     TEXT,
  ADD COLUMN "discountCode"   TEXT,
  ADD COLUMN "discountType"   TEXT,
  ADD COLUMN "discountValue"  DECIMAL(10, 2),
  ADD COLUMN "discountAmount" DECIMAL(10, 2);

COMMENT ON COLUMN "event_registrations"."discountId" IS
  'Discount row this registration redeemed. Soft pointer, no FK — the rule snapshot below must survive deletion of the code. Never read for pricing.';
COMMENT ON COLUMN "event_registrations"."discountType" IS
  'PERCENT | FIXED — snapshot of the rule at redemption. Editing the Discount row later must not change what this registrant owes.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. discounts.eventIds — a code scoped to specific events
-- ─────────────────────────────────────────────────────────────────────────────
-- `appliesTo` already answers "does this code work on events at all?"
-- (["EVENT"] = events generally; [] = every purchase type). It cannot answer
-- "this code works on the College Combine and nothing else."
--
-- This mirrors `membershipIds` exactly — same column type, same default, same
-- semantics — so the existing discount admin gains one more checklist rather
-- than a second place to manage codes:
--
--   []            → every event (the default, and what every existing row gets)
--   ["evt_abc"]   → only that event
--
-- NOT NULL DEFAULT '[]' reproduces today's behavior for all existing rows.
-- Unlike `membershipIds`, this needs no legacy back-compat guard: no row can
-- already carry a non-empty value.
ALTER TABLE "discounts"
  ADD COLUMN "eventIds" JSONB NOT NULL DEFAULT '[]';

COMMENT ON COLUMN "discounts"."eventIds" IS
  'Events this code covers when it applies to EVENT purchases. [] = every event. Mirrors membershipIds.';
