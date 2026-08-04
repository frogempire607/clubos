-- Phase 4 — Client & Family Accounts (4A + 4B + 4C) in ONE migration.
--
-- Additive only. Nothing is dropped, nothing renamed, no row loses data.
-- Every default reproduces today's behavior, so this migration is a no-op
-- functionally until the Phase 4 code ships on top of it.
--
-- Folder sorts after 20260802000000_email_history_optout_audit (required —
-- `prisma migrate deploy` sorts lexicographically and warns on out-of-order).
--
-- This migration ABSORBS planned M27 (MemberGuardianUser per-permission
-- columns + status, previously scheduled for Phase 4.5.6) so member_guardian_users
-- is migrated exactly once.
--
-- Data corrections (the Lister family) are NOT here. They live in
-- scripts/fix-family-links.ts, dry-run by default, run after deploy.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. member_guardian_users — promote the authorization edge to first class
-- ─────────────────────────────────────────────────────────────────────────────
-- Today the mere existence of a row is the grant, there is no provenance, no
-- per-relationship permissions, and no way to revoke without destroying the
-- record. All three gaps showed up in the Lister incident.

ALTER TABLE "member_guardian_users"
  ADD COLUMN IF NOT EXISTS "clubId"           TEXT,
  ADD COLUMN IF NOT EXISTS "status"           TEXT         NOT NULL DEFAULT 'CONFIRMED',
  ADD COLUMN IF NOT EXISTS "isPrimary"        BOOLEAN      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "canBook"          BOOLEAN      NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "canPay"           BOOLEAN      NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "canSignWaivers"   BOOLEAN      NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "canReceiveEmails" BOOLEAN      NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "source"           TEXT,
  ADD COLUMN IF NOT EXISTS "createdByUserId"  TEXT,
  ADD COLUMN IF NOT EXISTS "confirmedAt"      TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "revokedAt"        TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- clubId is derivable from the member; backfill then enforce NOT NULL.
UPDATE "member_guardian_users" g
   SET "clubId" = m."clubId"
  FROM "members" m
 WHERE m."id" = g."memberId"
   AND g."clubId" IS NULL;

-- Any orphan row (member already hard-deleted) would block SET NOT NULL.
-- There should be none — member_guardian_users.memberId cascades from members —
-- but fail loudly rather than silently skipping if that assumption is wrong.
DO $$
DECLARE orphans INT;
BEGIN
  SELECT count(*) INTO orphans FROM "member_guardian_users" WHERE "clubId" IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION 'member_guardian_users has % row(s) with no resolvable member; resolve before migrating', orphans;
  END IF;
END $$;

ALTER TABLE "member_guardian_users" ALTER COLUMN "clubId" SET NOT NULL;

-- Provenance for pre-existing rows: we genuinely do not know how they were
-- created, so say BACKFILL rather than guess. confirmedAt = createdAt is
-- accurate: these rows were access grants the moment they existed.
UPDATE "member_guardian_users"
   SET "source"      = COALESCE("source", 'BACKFILL'),
       "confirmedAt" = COALESCE("confirmedAt", "createdAt");

-- isPrimary — freeze today's runtime derivation (lib/guardianLink.ts
-- isPrimaryGuardian) into the column, once, so it stops being recomputed from
-- Member.guardianEmail. Two passes, matching the function exactly:
--   (1) the guardian whose login email equals the member's guardianEmail
UPDATE "member_guardian_users" g
   SET "isPrimary" = true
  FROM "members" m, "users" u
 WHERE m."id" = g."memberId"
   AND u."id" = g."userId"
   AND m."guardianEmail" IS NOT NULL
   AND u."email" IS NOT NULL
   AND lower(btrim(m."guardianEmail")) = lower(btrim(u."email"));

--   (2) otherwise the earliest link for that member
UPDATE "member_guardian_users" g
   SET "isPrimary" = true
 WHERE NOT EXISTS (
         SELECT 1 FROM "member_guardian_users" x
          WHERE x."memberId" = g."memberId" AND x."isPrimary" = true
       )
   AND g."id" = (
         SELECT y."id" FROM "member_guardian_users" y
          WHERE y."memberId" = g."memberId"
          ORDER BY y."createdAt" ASC, y."id" ASC
          LIMIT 1
       );

-- The table only had @@unique([userId, memberId]). Postgres cannot use that
-- composite for a memberId-first probe, which is precisely the new read the
-- staff Family & access card performs on every profile load.
CREATE INDEX IF NOT EXISTS "member_guardian_users_memberId_idx"      ON "member_guardian_users"("memberId");
CREATE INDEX IF NOT EXISTS "member_guardian_users_clubId_idx"        ON "member_guardian_users"("clubId");
CREATE INDEX IF NOT EXISTS "member_guardian_users_userId_status_idx" ON "member_guardian_users"("userId", "status");

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. member_subscriptions.payerUserId — payer becomes a stored fact
-- ─────────────────────────────────────────────────────────────────────────────
-- Nullable, no FK (matches Member.responsiblePayerUserId), NO backfill.
-- Readers fall back to Member.responsiblePayerUserId, then member.userId, so
-- every existing subscription resolves to the same payer it does today.

ALTER TABLE "member_subscriptions"
  ADD COLUMN IF NOT EXISTS "payerUserId" TEXT;

CREATE INDEX IF NOT EXISTS "member_subscriptions_payerUserId_idx"
  ON "member_subscriptions"("payerUserId");

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. membership_transfers — the audit trail Phase 4A requires
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "membership_transfers" (
  "id"                      TEXT         NOT NULL,
  "clubId"                  TEXT         NOT NULL,
  "subscriptionId"          TEXT         NOT NULL,
  "fromMemberId"            TEXT         NOT NULL,
  "toMemberId"              TEXT         NOT NULL,
  "performedByUserId"       TEXT,
  "performedByRole"         TEXT         NOT NULL,
  "requestedByUserId"       TEXT,
  "requestedViaApprovalId"  TEXT,
  "reason"                  TEXT,
  "payerUserIdAtTransfer"   TEXT,
  "stripeSubscriptionId"    TEXT,
  "stripeBillingUnchanged"  BOOLEAN      NOT NULL DEFAULT true,
  "acknowledgedBillingNote" TEXT,
  "usageSnapshot"           JSONB,
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "membership_transfers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "membership_transfers_subscriptionId_idx" ON "membership_transfers"("subscriptionId");
CREATE INDEX IF NOT EXISTS "membership_transfers_clubId_idx"         ON "membership_transfers"("clubId");
CREATE INDEX IF NOT EXISTS "membership_transfers_toMemberId_idx"     ON "membership_transfers"("toMemberId");

-- fromMemberId / toMemberId deliberately carry NO foreign key: members are
-- cascade-deleted, and a transfer record must outlive the athletes it names.
ALTER TABLE "membership_transfers"
  ADD CONSTRAINT "membership_transfers_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "membership_transfers"
  ADD CONSTRAINT "membership_transfers_subscriptionId_fkey"
  FOREIGN KEY ("subscriptionId") REFERENCES "member_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
