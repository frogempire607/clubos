-- Phase 5 — Event registration confirmation + tournament approval workflow.
--
-- ONE migration for the whole phase (plan.md §5.0–§5.12). Everything the
-- confirmation surface (§5.2), the opt-in policy (§5.3), the write path
-- (§5.4), the parent↔coach thread (§5.5), the escalation cron (§5.6) and the
-- visibility surfaces (§5.7) need is here, so no later Phase 5 session has to
-- ask for a second apply.
--
-- Additive only. Every column is nullable or carries a default that reproduces
-- today's exact behavior:
--
--   * `holdSpotDuringReview`, `reminderStage` and `reminderSendFailures` are
--     NOT NULL with a constant default — Postgres 11+ stores that in the
--     catalog, so this is a metadata update on `events` and
--     `event_registrations`, not a table rewrite.
--   * everything else is a nullable column.
--   * NULL is meaningful, not merely "unset": a NULL `requiresCoachApproval`
--     on an event means "inherit the event type's defaultPolicy", and a NULL
--     `approvalStatus` on a registration means "coach approval was never part
--     of this event's contract" (§5.4.3). Do not backfill either to a value.
--
-- Nothing changes until the tournament workflow is turned on for an event, and
-- the workflow ships default OFF everywhere (§5.3). A weekly clinic sees zero
-- behavior change from applying this.
--
-- Folder sorts after 20260807000000_event_discount_codes (required — `prisma
-- migrate deploy` sorts lexicographically and warns loudly on out-of-order
-- folders).
--
-- Apply with:
--   cd <checkout>/web && npx prisma migrate deploy
-- NEVER `migrate dev` (the shadow DB is blocked by the pooler) and never with
-- --shadow-database-url pointed at production.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. events — the per-event opt-in surface (§5.3.2)
-- ─────────────────────────────────────────────────────────────────────────────
-- Each of these OVERRIDES the event type's defaultPolicy when non-null, so the
-- resolution order in resolveEventPolicy() is event → type → hardcoded
-- fallback. That is why they are nullable booleans rather than
-- NOT NULL DEFAULT false: `false` means "this event explicitly opted out",
-- NULL means "whatever the type says". Collapsing the two would make it
-- impossible for an owner to opt one tournament out of a type-wide default.
--
-- `holdSpotDuringReview` is the exception and is a real NOT NULL DEFAULT
-- false: capacity is enforced at approve time, not at registration
-- (§5.4.2/§5.12 item 3), and a null-means-inherit here would give capacity —
-- the one thing that must never be ambiguous — three possible answers.
--
-- `responsibleCoachUserId` is a deliberate soft pointer with NO foreign key,
-- matching how the codebase already stores actor ids (Transaction.recordedBy,
-- Message.subjectMemberId). A staff member who leaves must not cascade-delete
-- or block the deletion of the events they were once responsible for; the
-- reader falls back to "any staff with events:edit can approve" when the id
-- no longer resolves.
ALTER TABLE "events"
  ADD COLUMN "requiresCoachApproval"  BOOLEAN,
  ADD COLUMN "approvalPaymentIntent"  TEXT,
  ADD COLUMN "allowProposedChanges"   BOOLEAN,
  ADD COLUMN "responsibleCoachUserId" TEXT,
  ADD COLUMN "escalationEnabled"      BOOLEAN,
  ADD COLUMN "escalationAnchor"       TEXT,
  ADD COLUMN "escalationSchedule"     TEXT,
  ADD COLUMN "escalationCustomDays"   JSONB,
  ADD COLUMN "cancellationPolicyText" TEXT,
  ADD COLUMN "paymentDueBy"           TIMESTAMP(3),
  ADD COLUMN "holdSpotDuringReview"   BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN "events"."requiresCoachApproval" IS
  'NULL = inherit club_event_types.defaultPolicy. false = explicitly off for this event. Registrations created while true land PENDING_REVIEW.';
COMMENT ON COLUMN "events"."approvalPaymentIntent" IS
  'CARD | APPROVAL_CHARGE | INVOICE | CASH_CHECK | PARENT_CHOOSES. NULL = inherit. APPROVAL_CHARGE charges the saved card on approval — never an authorization hold (plan §5.1).';
COMMENT ON COLUMN "events"."responsibleCoachUserId" IS
  'Soft pointer to users.id, no FK. The one coach who owns approving this event; NULL = any staff with events:edit. Also the recipient of the daily stalled-approval digest.';
COMMENT ON COLUMN "events"."escalationAnchor" IS
  'registrationDeadline | eventStart | autoChargeDate — which date the reminder cadence counts back from. paymentDueBy overrides it when set.';
COMMENT ON COLUMN "events"."escalationSchedule" IS
  'DEFAULT_TOURNAMENT | GENTLE | AGGRESSIVE | CUSTOM. CUSTOM reads escalationCustomDays (array of day-offsets from the anchor).';
COMMENT ON COLUMN "events"."paymentDueBy" IS
  'Owner-set hard payment deadline. Highest-precedence reminder anchor and the due date the confirmation surface prints.';
COMMENT ON COLUMN "events"."holdSpotDuringReview" IS
  'false (default) = PENDING_REVIEW rows do NOT consume capacity; capacity is re-checked inside the approve transaction. true = they do.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. club_event_types — per-type policy defaults (§5.3.1)
-- ─────────────────────────────────────────────────────────────────────────────
-- One JSON blob rather than eleven mirrored columns: this is a defaults
-- template that the owner edits as a unit in the "Manage event types" modal
-- and that is never queried by any individual key. The authoritative shape is
-- EventPolicy in lib/eventPayments.ts; resolveEventPolicy() validates every
-- field on read, so a hand-edited or partial blob degrades to the hardcoded
-- (all-off) fallback instead of throwing.
--
-- NULL = this type has no policy, which is what every existing row gets and
-- what keeps the whole workflow off for clinics, camps and classes.
ALTER TABLE "club_event_types"
  ADD COLUMN "defaultPolicy" JSONB;

COMMENT ON COLUMN "club_event_types"."defaultPolicy" IS
  'Per-type tournament-workflow defaults; NULL = none. Shape: EventPolicy in lib/eventPayments.ts. Overridden per event by the events columns above.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. event_registrations — approval, proposal, escalation, confirmation code
-- ─────────────────────────────────────────────────────────────────────────────
-- approval (§5.4.1, §5.4.6):
--   approvalStatus       NULL | PENDING | APPROVED | DECLINED. NULL is not
--                        "not yet decided" — it is "this event never required
--                        coach approval", which is how every existing row and
--                        every clinic signup reads. Turning approval on for an
--                        event later must NOT retroactively mark old rows
--                        PENDING, which is exactly why this is nullable.
--   approvedByUserId     soft pointer, no FK (same rule as responsibleCoach).
--                        On the parent-accepts-a-proposal path this records
--                        the COACH who proposed, not the parent who accepted.
--   declinedReason       owner-typed, sanitized before storage; it renders in
--                        the parent's email.
--   approvalRequestedAt  when the row entered PENDING_REVIEW. The stalled-
--                        approval probes and the coach digest age off this,
--                        not off createdAt, so a registration that becomes
--                        pending after a guardian approval is aged correctly.
--
-- proposed change (§5.4.6, §5.4.7): a single-slot JSON column. Prior proposals
-- are NOT preserved here — billing_audit_logs
-- (action=EVENT_REGISTRATION_PROPOSAL, before/after) is the archive. Shape:
--   { proposedByUserId, proposedAt (ISO), coachNote?, priceDelta?, changes }
-- proposedChangeAccepted is a three-state: NULL = no response yet,
-- true = accepted, false = declined. Paired with proposedChangeRespondedAt,
-- which is what the parent-response routes treat as immutable-once-set (the
-- terminal-state guard) and what the accept/decline emails key their dedupe on.
--
-- escalation (§5.6): reminderStage is the last stage actually FIRED (0 = none,
-- -1 = sentinel for "three consecutive send failures on the same stage — a
-- human needs to look"). nextReminderAt is the cron's only queue: NULL means
-- this row is not waiting on anything and is skipped, which is how every path
-- that settles money (approve-and-charge, offline receipt, decline, cancel)
-- switches reminders off — by nulling it in the same transaction.
--
-- confirmationCode (§5.2.3): the human-readable registration number printed on
-- the confirmation page, in every lifecycle email, and in the calendar file.
-- Nullable + backfilled compute-on-read (persist when null) rather than
-- backfilled here: deriving it needs the same base32 helper the app uses, and
-- doing that in SQL would give us two implementations that can drift.
ALTER TABLE "event_registrations"
  ADD COLUMN "approvalStatus"            TEXT,
  ADD COLUMN "approvedByUserId"          TEXT,
  ADD COLUMN "approvedAt"                TIMESTAMP(3),
  ADD COLUMN "declinedReason"            TEXT,
  ADD COLUMN "approvalRequestedAt"       TIMESTAMP(3),
  ADD COLUMN "proposedChange"            JSONB,
  ADD COLUMN "proposedChangeRespondedAt" TIMESTAMP(3),
  ADD COLUMN "proposedChangeAccepted"    BOOLEAN,
  ADD COLUMN "reminderStage"             INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastReminderAt"            TIMESTAMP(3),
  ADD COLUMN "nextReminderAt"            TIMESTAMP(3),
  ADD COLUMN "reminderSendFailures"      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "confirmationCode"          TEXT;

COMMENT ON COLUMN "event_registrations"."approvalStatus" IS
  'NULL | PENDING | APPROVED | DECLINED. NULL = coach approval was never part of this event''s contract. Never backfill it.';
COMMENT ON COLUMN "event_registrations"."approvalRequestedAt" IS
  'When this row entered PENDING_REVIEW. Stalled-approval probes and the coach digest age off this, not createdAt.';
COMMENT ON COLUMN "event_registrations"."proposedChange" IS
  'Single-slot coach proposal: { proposedByUserId, proposedAt, coachNote?, priceDelta?, changes }. History lives in billing_audit_logs.';
COMMENT ON COLUMN "event_registrations"."reminderStage" IS
  'Last escalation stage actually sent (0 = none). -1 is the sentinel for three consecutive send failures on one stage.';
COMMENT ON COLUMN "event_registrations"."nextReminderAt" IS
  'The escalation cron''s entire queue. NULL = not waiting on payment; every settle/cancel path nulls it in the same transaction.';
COMMENT ON COLUMN "event_registrations"."confirmationCode" IS
  'Human-readable registration number shown on the confirmation page and in every lifecycle email. Backfilled compute-on-read; the row id remains the true key.';

-- One registration number, globally. A partial unique index (WHERE NOT NULL)
-- rather than a plain UNIQUE constraint so the not-yet-backfilled rows don't
-- collide with each other on NULL — Postgres would allow that anyway, but the
-- partial index also keeps the index small while the backfill is in progress.
-- Prisma cannot model a partial unique index: the @unique in schema.prisma is
-- DOCUMENTATION ONLY and this SQL is authoritative (same rule as the M16
-- email_sends index — see CLAUDE.md; do not "reconcile" the drift).
CREATE UNIQUE INDEX "event_registrations_confirmationCode_key"
  ON "event_registrations" ("confirmationCode")
  WHERE "confirmationCode" IS NOT NULL;

-- The escalation cron's sweep: WHERE nextReminderAt <= now(), ordered by it.
-- Partial so the index only carries rows that are actually queued — the vast
-- majority of registrations have nextReminderAt NULL forever.
CREATE INDEX "event_registrations_nextReminderAt_idx"
  ON "event_registrations" ("nextReminderAt")
  WHERE "nextReminderAt" IS NOT NULL;

-- The roster's "who is waiting on a coach" filter and the Action Center's
-- COACH_APPROVAL_REQUESTED count, both per club.
CREATE INDEX "event_registrations_clubId_approvalStatus_idx"
  ON "event_registrations" ("clubId", "approvalStatus");

-- The stalled-approval probes (EVENT_APPROVAL_STALLED_48H / _PAST_DEADLINE)
-- and the coach daily digest: PENDING rows older than a cutoff.
CREATE INDEX "event_registrations_approvalStatus_approvalRequestedAt_idx"
  ON "event_registrations" ("approvalStatus", "approvalRequestedAt")
  WHERE "approvalStatus" = 'PENDING';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. bookings.bookedByUserId — attribution (§5.4.8, ARCHITECTURE-NOTES M19)
-- ─────────────────────────────────────────────────────────────────────────────
-- Who performed the booking, as distinct from bookings.memberId (who the spot
-- is FOR). A guardian registering a child, a coach approving a PENDING_REVIEW
-- row, and an owner adding a walk-in are three different actors that the table
-- currently cannot tell apart. Soft pointer, no FK; legacy rows stay NULL and
-- every consumer reads NULL as "unknown".
ALTER TABLE "bookings"
  ADD COLUMN "bookedByUserId" TEXT;

COMMENT ON COLUMN "bookings"."bookedByUserId" IS
  'User who created the booking (guardian, approving coach, or staff). NULL on legacy rows = unknown. bookings.memberId is who it is FOR.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Public-path double-submit guard — one registration per (event, email)
-- ─────────────────────────────────────────────────────────────────────────────
-- ARCHITECTURE-NOTES §2.4 M18. A guest double-clicking Register on /e/[slug]
-- creates two rows and two Checkout sessions today.
--
-- This is the one part of Phase 5's schema that can FAIL on real data: any
-- event that already has two non-canceled rows with the same email would abort
-- the whole migration mid-apply. So it is guarded — the index is created only
-- when the data is already clean, and otherwise the migration prints the
-- duplicate count and continues. Deploy is never blocked, and the constraint
-- is never half-applied.
--
-- CANCELED rows are excluded from the index on purpose: removing someone from
-- an event sets CANCELED (never a hard delete), and a family re-registering
-- after a cancellation is legitimate.
--
-- To find out whether it landed:
--   SELECT indexname FROM pg_indexes
--    WHERE tablename = 'event_registrations'
--      AND indexname = 'event_registrations_eventId_email_key';
-- If it did not, list the duplicates, decide per row (the newest is normally
-- the keeper), cancel the losers, and re-run just the CREATE UNIQUE INDEX
-- statement below by hand:
--   SELECT "eventId", LOWER("email") AS email, COUNT(*), ARRAY_AGG(id)
--     FROM "event_registrations"
--    WHERE "status" <> 'CANCELED' AND "email" <> ''
--    GROUP BY 1, 2 HAVING COUNT(*) > 1;
DO $$
DECLARE
  dupes INTEGER;
BEGIN
  SELECT COUNT(*) INTO dupes FROM (
    SELECT "eventId", LOWER("email")
      FROM "event_registrations"
     WHERE "status" <> 'CANCELED' AND "email" <> ''
     GROUP BY 1, 2
    HAVING COUNT(*) > 1
  ) d;

  IF dupes = 0 THEN
    CREATE UNIQUE INDEX "event_registrations_eventId_email_key"
      ON "event_registrations" ("eventId", LOWER("email"))
      WHERE "status" <> 'CANCELED' AND "email" <> '';
    RAISE NOTICE 'Phase 5: created event_registrations_eventId_email_key (no duplicates found).';
  ELSE
    RAISE NOTICE 'Phase 5: SKIPPED event_registrations_eventId_email_key — % (eventId, email) group(s) already contain duplicates. Resolve them, then create the index by hand. See the migration comment for the query.', dupes;
  END IF;
END $$;
