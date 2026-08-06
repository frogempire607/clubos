-- Phase 4.5 — Members Full Design Handoff. ALL of 4.5.1 → 4.5.11 in ONE migration.
--
-- Additive only. Nothing is dropped, nothing is renamed, no row loses data.
-- Every column is nullable or carries a default that reproduces today's
-- behavior, so applying this changes nothing until the Phase 4.5 code reads it.
--
-- Folder sorts after 20260803000000_family_accounts (required — `prisma migrate
-- deploy` sorts lexicographically and warns loudly on out-of-order folders).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION DELIBERATELY DOES **NOT** CONTAIN
-- ─────────────────────────────────────────────────────────────────────────────
-- Two things the Phase 4.5 plan lists as migrations are ALREADY IN PRODUCTION.
-- Re-adding either would be a no-op at best and a conflict at worst.
--
--   1. ImportBatch.sourceLabel  (plan 4.5.10, "no hard-coded vendor names")
--      Shipped 2026-07-29 in 20260731030000_historical_imports as
--      import_batches."sourceLabel" TEXT. The 2.5.10 import wizard already
--      writes it at step 1 and /api/reports/imports already reads it.
--      Members reach it through members."importBatchId" (also already live).
--      → nothing to migrate; 4.5.10's source-label work is render-side only.
--
--   2. member_guardian_users per-permission columns  (plan 4.5.6 / old M21/M27)
--      Shipped 2026-08-03 in 20260803000000_family_accounts, which explicitly
--      absorbed M27. The live columns are canBook, canPay, canSignWaivers,
--      canReceiveEmails, status, isPrimary, source, createdByUserId,
--      confirmedAt, revokedAt.
--      NOTE the names differ from plan.md 4.5.6, which says `canWaivers` and
--      `canMessages`. The SHIPPED names win. Do not "reconcile" the plan by
--      adding a second pair of columns.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY
-- ─────────────────────────────────────────────────────────────────────────────
-- The three new tables below get NO RLS policy here, matching every table added
-- since 20260702000000_enable_rls (invoice_splits, stripe_reconciliations,
-- parental_consents, membership_transfers, …). The RLS project is built but not
-- yet applied to production (web/rls/README.md). Fold these three in with the
-- rest when that rollout resumes:
--     member_invitation_deliveries · saved_member_views · member_subscription_events
--
-- ─────────────────────────────────────────────────────────────────────────────
-- BACKFILLS
-- ─────────────────────────────────────────────────────────────────────────────
-- None run inline. members."reviewedAt" needs a judgement call per row (it is
-- inferred from MemberMigrationEvent NOTE rows, not from a column), and
-- member_subscription_events needs one synthesized history per subscription.
-- Both live in scripts/members-experience-backfill.ts — dry-run by default,
-- allowlist required for --apply, run by Julian from his own terminal.
-- Applying THIS file without running that script is safe: every new column
-- simply reads null, and every derived surface degrades to its "unknown" state.

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. members — migration step 2 ("Information reviewed") and the Blocked state
-- ═════════════════════════════════════════════════════════════════════════════
-- Track 3 of the status model has seven steps. Step 2 is the only one with no
-- fact behind it today: the migration roster infers "setup complete" from a
-- NOTE MemberMigrationEvent, which is a side effect of someone having edited
-- the row, not a record that anyone reviewed it. Two staff can therefore
-- disagree about whether a person has been reviewed. These columns make it a
-- fact with an actor.
--
-- blockedReason / snoozedUntil drive the two states the redesign adds to the
-- work queue: a person who stops consuming invitation sends because delivery
-- keeps failing, and a person the owner has explicitly set aside for a week.

ALTER TABLE "members"
  ADD COLUMN IF NOT EXISTS "reviewedAt"       TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "reviewedByUserId" TEXT,
  -- Deliberately TEXT, not a Postgres enum. Every other lifecycle field on this
  -- table is TEXT with a documented value set (migrationStatus, approvalStatus,
  -- paymentSetupStatus, requestedPaymentMethod), and a TEXT column can gain a
  -- value without a migration — which matters because the blocked-reason list
  -- will grow as real delivery failures are observed.
  --   EMAIL_BOUNCED | EMAIL_MISSING | REPEATED_NO_OPEN | SETUP_FAILED
  --   | CONFLICTING_DATA | MANUAL
  ADD COLUMN IF NOT EXISTS "blockedReason"    TEXT,
  -- "Snooze 7 days" on the next-action banner. While now() < snoozedUntil the
  -- member drops out of "Needs you" and the banner stays hidden. Never affects
  -- billing, access, or migration progress — it is a staff view preference with
  -- an expiry.
  ADD COLUMN IF NOT EXISTS "snoozedUntil"     TIMESTAMP(3);

-- reviewedByUserId carries NO foreign key, matching Member.billingUpdatedById,
-- Member.responsiblePayerUserId and MembershipTransfer.performedByUserId. A
-- staff member can be soft-deleted; the record of who reviewed a row must
-- outlive them.

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Indexes for server-side paging, search and the segmented counts
-- ═════════════════════════════════════════════════════════════════════════════
-- 4.5.2 makes server-side pagination mandatory and the person-type segmented
-- control shows a count per segment computed from the query, not the page. On a
-- 5,000-person club those counts are six aggregate queries per page load.
--
-- members(clubId, status) already exists (20260728030000_reports_indexes).
-- These two are the ones the new reads need and nothing provides yet.

-- The migration roster and the funnel both filter by migrationStatus within a
-- club; the funnel does it seven times per load.
CREATE INDEX IF NOT EXISTS "members_clubId_migrationStatus_idx"
  ON "members" ("clubId", "migrationStatus");

-- Every list read is club-scoped AND excludes soft-deleted rows. Without
-- deletedAt in the index Postgres filters it after the fact on every page.
CREATE INDEX IF NOT EXISTS "members_clubId_deletedAt_idx"
  ON "members" ("clubId", "deletedAt");

-- "Needs you" / snooze-aware queries.
CREATE INDEX IF NOT EXISTS "members_clubId_snoozedUntil_idx"
  ON "members" ("clubId", "snoozedUntil")
  WHERE "snoozedUntil" IS NOT NULL;

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. member_invitation_deliveries — one row per invitation SEND
-- ═════════════════════════════════════════════════════════════════════════════
-- Today Member carries activationEmailSentAt + activationEmailSendCount: a
-- timestamp of the last send and a counter. That cannot answer the two
-- questions the redesign puts on screen —
--     "3 sends, never opened"          (drives Blocked)
--     "sent to which address, when"    (drives the next-action banner's evidence)
-- — and it cannot distinguish "we sent it and it bounced" from "we sent it and
-- they ignored it". Those need opposite actions: fix the address vs nudge the
-- person. One row per send, with the address frozen at send time.
--
-- The counters on Member are NOT retired. They stay the cheap read for the list;
-- this table is the detail behind them.

CREATE TABLE IF NOT EXISTS "member_invitation_deliveries" (
  "id"        TEXT NOT NULL,
  "clubId"    TEXT NOT NULL,
  "memberId"  TEXT NOT NULL,

  -- The address at the moment of sending. Frozen on purpose: editing a member's
  -- email later must not rewrite the history of where invitations actually went.
  -- That history is the evidence behind "Try a different email".
  "sentToEmail" TEXT NOT NULL,
  -- SELF | GUARDIAN — whose address this was. A minor's invitation goes to the
  -- guardian, and the banner copy differs ("<Name>'s guardian").
  "recipientKind" TEXT NOT NULL DEFAULT 'SELF',

  "sentAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deliveredAt" TIMESTAMP(3),
  "openedAt"    TIMESTAMP(3),
  "bouncedAt"   TIMESTAMP(3),
  "bounceReason" TEXT,

  -- Who triggered the send, and how. STAFF | BULK | SYSTEM | MEMBER_REQUEST.
  "sentByUserId" TEXT,
  "trigger"      TEXT NOT NULL DEFAULT 'STAFF',

  -- Provider correlation, mirroring email_sends (M16). RESEND when the Resend
  -- API dispatched it, SMTP otherwise — SMTP gives us no lifecycle callbacks,
  -- so deliveredAt/openedAt/bouncedAt stay null on that path and the UI must
  -- read "sent" rather than claiming delivery it cannot observe.
  "provider"          TEXT,
  "providerMessageId" TEXT,

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "member_invitation_deliveries_pkey" PRIMARY KEY ("id")
);

-- "every send for this member, newest first" — the profile's invitation history
-- and the "3 sends, never opened" count.
CREATE INDEX IF NOT EXISTS "member_invitation_deliveries_memberId_sentAt_idx"
  ON "member_invitation_deliveries" ("memberId", "sentAt" DESC);

CREATE INDEX IF NOT EXISTS "member_invitation_deliveries_clubId_sentAt_idx"
  ON "member_invitation_deliveries" ("clubId", "sentAt" DESC);

-- Webhook lookup path: a provider callback carries only its own message id.
-- Partial, because the SMTP path leaves it null and those rows are the majority
-- until RESEND_API_KEY is set.
CREATE UNIQUE INDEX IF NOT EXISTS "member_invitation_deliveries_providerMessageId_key"
  ON "member_invitation_deliveries" ("providerMessageId")
  WHERE "providerMessageId" IS NOT NULL;

-- Finding everyone currently blocked by delivery failure.
CREATE INDEX IF NOT EXISTS "member_invitation_deliveries_clubId_bouncedAt_idx"
  ON "member_invitation_deliveries" ("clubId", "bouncedAt")
  WHERE "bouncedAt" IS NOT NULL;

ALTER TABLE "member_invitation_deliveries"
  ADD CONSTRAINT "member_invitation_deliveries_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "member_invitation_deliveries"
  ADD CONSTRAINT "member_invitation_deliveries_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. saved_member_views — "Save as view" on the members list
-- ═════════════════════════════════════════════════════════════════════════════
-- Per-user, not per-club: two staff working the same roster want different
-- saved slices, and one must not be able to delete the other's.

CREATE TABLE IF NOT EXISTS "saved_member_views" (
  "id"     TEXT NOT NULL,
  "clubId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name"   TEXT NOT NULL,

  -- The whole filter state, stored as the URL carries it:
  --   { personType, search, tags[], membership, gender, ageMin, ageMax,
  --     setupState, customField: {id, value}, waitingOn }
  -- JSON rather than columns because 4.5.2's Filters panel is explicitly
  -- open-ended and every added filter would otherwise be a migration.
  "filters" JSONB NOT NULL DEFAULT '{}',
  "sort"    TEXT,

  -- Which surface the view belongs to: MEMBERS | MIGRATION. The migration queue
  -- reuses the same mechanism with a different filter vocabulary.
  "scope"   TEXT NOT NULL DEFAULT 'MEMBERS',

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "saved_member_views_pkey" PRIMARY KEY ("id")
);

-- One name per user per scope — re-saving a name updates rather than duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS "saved_member_views_userId_scope_name_key"
  ON "saved_member_views" ("userId", "scope", "name");

CREATE INDEX IF NOT EXISTS "saved_member_views_userId_scope_idx"
  ON "saved_member_views" ("userId", "scope");

CREATE INDEX IF NOT EXISTS "saved_member_views_clubId_idx"
  ON "saved_member_views" ("clubId");

ALTER TABLE "saved_member_views"
  ADD CONSTRAINT "saved_member_views_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "saved_member_views"
  ADD CONSTRAINT "saved_member_views_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. member_subscription_events — subscription history (4.5.10)
-- ═════════════════════════════════════════════════════════════════════════════
-- This is the one that unblocks Reports. Phase 2.5.5 computes churn from the
-- CURRENT state of member_subscriptions, which cannot distinguish:
--     a cancel that is really a plan change  (not churn)
--     a cancel followed by a new sub 9 days later  (not churn — 14-day grace)
--     a genuine loss  (churn)
-- so every rate it returns carries reliability: "ESTIMATED". An append-only
-- event log makes those three distinguishable and lets the tab flip to
-- "COMPLETE".
--
-- Sidecar by design: no column is added to member_subscriptions, so no existing
-- billing read changes behavior when this lands.

CREATE TABLE IF NOT EXISTS "member_subscription_events" (
  "id"     TEXT NOT NULL,
  "clubId" TEXT NOT NULL,

  "memberSubscriptionId" TEXT NOT NULL,
  -- Denormalized from the subscription so churn can group by member without a
  -- join, and so the row still names the athlete if the subscription is later
  -- transferred to a different one (Phase 4A moves memberId — this must not
  -- retroactively rewrite who the historical event was about).
  "memberId" TEXT NOT NULL,

  -- CREATED | ACTIVATED | PAUSED | RESUMED | CANCELED | EXPIRED
  --   | PLAN_CHANGED | REACTIVATED
  "kind" TEXT NOT NULL,

  -- Plan identity and price on both sides of the transition. PLAN_CHANGED is the
  -- only kind that populates all four; CREATED/ACTIVATED populate the "to" side;
  -- CANCELED/EXPIRED populate the "from" side. Decimal(10,2) matches
  -- member_subscriptions."price".
  "fromPlan"   TEXT,
  "toPlan"     TEXT,
  "fromAmount" DECIMAL(10,2),
  "toAmount"   DECIMAL(10,2),

  -- When the transition HAPPENED, which is not always when the row was written
  -- (a Stripe webhook can arrive late, and the backfill synthesizes historical
  -- events from createdAt/canceledAt). Every churn window reads this, never
  -- createdAt.
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  "actorUserId" TEXT,
  -- STRIPE_WEBHOOK | OWNER_ACTION | GUARDIAN_ACTION | MEMBER_ACTION | SYSTEM
  -- SYSTEM covers the backfill and the expiry sweep. Reports must be able to
  -- exclude synthesized history from "what changed this month".
  "source" TEXT NOT NULL DEFAULT 'SYSTEM',

  -- Free-form provenance for reconstructing an incident: Stripe event id, the
  -- script run that wrote it, the route that triggered it.
  "detail" JSONB,

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "member_subscription_events_pkey" PRIMARY KEY ("id")
);

-- The churn query: every event in a club over a date range.
CREATE INDEX IF NOT EXISTS "member_subscription_events_clubId_at_idx"
  ON "member_subscription_events" ("clubId", "at");

-- One subscription's timeline, in order.
CREATE INDEX IF NOT EXISTS "member_subscription_events_memberSubscriptionId_at_idx"
  ON "member_subscription_events" ("memberSubscriptionId", "at");

-- Per-member history for the profile's Memberships tab.
CREATE INDEX IF NOT EXISTS "member_subscription_events_memberId_at_idx"
  ON "member_subscription_events" ("memberId", "at");

-- Churn groups by kind within a window; without this the range scan reads every
-- event in the club to count six kinds.
CREATE INDEX IF NOT EXISTS "member_subscription_events_clubId_kind_at_idx"
  ON "member_subscription_events" ("clubId", "kind", "at");

ALTER TABLE "member_subscription_events"
  ADD CONSTRAINT "member_subscription_events_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "member_subscription_events"
  ADD CONSTRAINT "member_subscription_events_memberSubscriptionId_fkey"
  FOREIGN KEY ("memberSubscriptionId") REFERENCES "member_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- memberId carries NO foreign key: it is the denormalized "who this was about"
-- and must survive a member being removed, exactly like
-- membership_transfers."fromMemberId".

-- ═════════════════════════════════════════════════════════════════════════════
-- REVERSE SQL (kept per repo convention — every migration ships its rollback)
-- ═════════════════════════════════════════════════════════════════════════════
-- Safe to run only if the Phase 4.5 code has been reverted first.
--
--   DROP TABLE IF EXISTS "member_subscription_events";
--   DROP TABLE IF EXISTS "saved_member_views";
--   DROP TABLE IF EXISTS "member_invitation_deliveries";
--   DROP INDEX IF EXISTS "members_clubId_snoozedUntil_idx";
--   DROP INDEX IF EXISTS "members_clubId_deletedAt_idx";
--   DROP INDEX IF EXISTS "members_clubId_migrationStatus_idx";
--   ALTER TABLE "members"
--     DROP COLUMN IF EXISTS "snoozedUntil",
--     DROP COLUMN IF EXISTS "blockedReason",
--     DROP COLUMN IF EXISTS "reviewedByUserId",
--     DROP COLUMN IF EXISTS "reviewedAt";
--
-- Dropping the three tables destroys invitation-delivery history and
-- subscription-event history. Neither is reconstructable from anything else, so
-- take a pg_dump first.
