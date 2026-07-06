-- ============================================================================
-- AthletixOS — Member/client data cleanup for tenant `frogempire607`
-- Frog Empire Wrestling Academy  (club id: cmq9xyrjx00008tc4xck1k9qo)
-- Date: 2026-07-04
-- Purpose: Remove ALL member/client data + anything connected to members,
--          while preserving owner/staff logins and all business setup, so the
--          club can start a clean member migration with zero member history.
--
-- SAFE: data-only. No schema changes. Scoped to ONE club id. Owner/staff Users
-- (role OWNER/STAFF) and all setup tables are untouched.
--
-- Deletion order is child -> parent. Five FKs are ON DELETE SET NULL (they do
-- NOT cascade), so those tables are deleted EXPLICITLY before their parents:
--   transactions.memberId, product_sales.memberId, event_registrations.memberId,
--   campaign_attributions.memberId, private_booking_partners.memberId
-- Everything else toward members/users is ON DELETE CASCADE (verified against
-- pg_constraint on 2026-07-04). No RESTRICT/NO ACTION FKs exist, so nothing can
-- block the deletes.
--
-- How to run: execute Section 2 (the BEGIN..COMMIT block). Section 1 (dry-run)
-- and Section 3 (verify) are read-only and safe to run any time. Re-running the
-- whole script after a successful cleanup simply deletes 0 rows (idempotent).
-- ============================================================================


-- ============================================================================
-- SECTION 1 — DRY RUN (read-only): what WOULD be deleted
-- ============================================================================
WITH club AS (SELECT 'cmq9xyrjx00008tc4xck1k9qo'::text AS id),
     mids  AS (SELECT id FROM members WHERE "clubId" = (SELECT id FROM club)),
     muids AS (SELECT id FROM users   WHERE "clubId" = (SELECT id FROM club) AND role = 'MEMBER')
SELECT
 (SELECT count(*) FROM members                 WHERE "clubId" = (SELECT id FROM club))                        AS members,
 (SELECT count(*) FROM guardians               WHERE "clubId" = (SELECT id FROM club))                        AS guardians,
 (SELECT count(*) FROM users                   WHERE "clubId" = (SELECT id FROM club) AND role='MEMBER')      AS member_logins,
 (SELECT count(*) FROM member_subscriptions    WHERE "memberId" IN (SELECT id FROM mids))                     AS member_subscriptions,
 (SELECT count(*) FROM member_guardian_users   WHERE "memberId" IN (SELECT id FROM mids))                     AS member_guardian_links,
 (SELECT count(*) FROM member_migration_events WHERE "clubId" = (SELECT id FROM club))                        AS migration_events,
 (SELECT count(*) FROM member_relationships    WHERE "clubId" = (SELECT id FROM club))                        AS member_relationships,
 (SELECT count(*) FROM pending_approvals       WHERE "clubId" = (SELECT id FROM club))                        AS pending_approvals,
 (SELECT count(*) FROM bookings                WHERE "memberId" IN (SELECT id FROM mids))                     AS bookings,
 (SELECT count(*) FROM event_registrations     WHERE "clubId" = (SELECT id FROM club))                        AS event_registrations,
 (SELECT count(*) FROM attendance_records      WHERE "clubId" = (SELECT id FROM club))                        AS attendance_records,
 (SELECT count(*) FROM private_bookings        WHERE "clubId" = (SELECT id FROM club))                        AS private_bookings,
 (SELECT count(*) FROM private_booking_partners WHERE "clubId" = (SELECT id FROM club))                       AS private_booking_partners,
 (SELECT count(*) FROM private_credit_ledger   WHERE "clubId" = (SELECT id FROM club))                        AS private_credits,
 (SELECT count(*) FROM document_signatures     WHERE "memberId" IN (SELECT id FROM mids))                     AS document_signatures,
 (SELECT count(*) FROM product_sales           WHERE "clubId" = (SELECT id FROM club))                        AS product_sales,
 (SELECT count(*) FROM transactions            WHERE "clubId" = (SELECT id FROM club))                        AS transactions_all,
 (SELECT count(*) FROM campaign_attributions   WHERE "clubId" = (SELECT id FROM club))                        AS campaign_attributions,
 (SELECT count(*) FROM messages                WHERE "clubId" = (SELECT id FROM club)
        AND ("senderId" IN (SELECT id FROM muids) OR "recipientId" IN (SELECT id FROM muids)
             OR "subjectMemberId" IN (SELECT id FROM mids)))                                                  AS messages_member,
 (SELECT count(*) FROM announcement_engagements WHERE "clubId" = (SELECT id FROM club) AND "userId" IN (SELECT id FROM muids)) AS ann_engagements,
 (SELECT count(*) FROM message_group_members   WHERE "userId" IN (SELECT id FROM muids))                      AS group_memberships,
 (SELECT count(*) FROM group_messages          WHERE "senderId" IN (SELECT id FROM muids))                    AS group_messages,
 (SELECT count(*) FROM group_message_receipts  WHERE "userId" IN (SELECT id FROM muids))                      AS group_receipts,
 (SELECT count(*) FROM legal_acceptances       WHERE "userId" IN (SELECT id FROM muids))                      AS legal_acceptances;


-- ============================================================================
-- SECTION 2 — DELETION (transactional). Run this block to perform the cleanup.
-- ============================================================================
BEGIN;

-- Safety guard: abort unless the id AND slug both match this exact club.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM clubs WHERE id = 'cmq9xyrjx00008tc4xck1k9qo' AND slug = 'frogempire607') THEN
    RAISE EXCEPTION 'GUARD: frogempire607 club id/slug mismatch — aborting cleanup';
  END IF;
END $$;

-- 1) Private lessons (partners -> bookings -> credits)
DELETE FROM private_booking_partners WHERE "clubId" = 'cmq9xyrjx00008tc4xck1k9qo';
DELETE FROM private_bookings          WHERE "clubId" = 'cmq9xyrjx00008tc4xck1k9qo';
DELETE FROM private_credit_ledger     WHERE "clubId" = 'cmq9xyrjx00008tc4xck1k9qo';

-- 2) Attendance + class/event bookings + registrations
DELETE FROM attendance_records        WHERE "clubId" = 'cmq9xyrjx00008tc4xck1k9qo';
DELETE FROM bookings                  WHERE "memberId" IN (SELECT id FROM members WHERE "clubId" = 'cmq9xyrjx00008tc4xck1k9qo');
DELETE FROM event_registrations       WHERE "clubId" = 'cmq9xyrjx00008tc4xck1k9qo';

-- 3) Money tied to members (SET NULL FKs -> must delete explicitly, before members)
--    NOTE: deletes ALL club transactions (7 member-tied + 1 confirmed orphan
--    manual cash "Wyatt — Member price"). No Stripe/live-processor rows exist here.
DELETE FROM product_sales             WHERE "clubId" = 'cmq9xyrjx00008tc4xck1k9qo';
DELETE FROM campaign_attributions     WHERE "clubId" = 'cmq9xyrjx00008tc4xck1k9qo';
DELETE FROM transactions              WHERE "clubId" = 'cmq9xyrjx00008tc4xck1k9qo';

-- 4) Documents, subscriptions, migration history, relationships, approvals
DELETE FROM document_signatures       WHERE "memberId" IN (SELECT id FROM members WHERE "clubId" = 'cmq9xyrjx00008tc4xck1k9qo');
DELETE FROM member_subscriptions      WHERE "memberId" IN (SELECT id FROM members WHERE "clubId" = 'cmq9xyrjx00008tc4xck1k9qo');
DELETE FROM member_migration_events   WHERE "clubId" = 'cmq9xyrjx00008tc4xck1k9qo';
DELETE FROM member_relationships      WHERE "clubId" = 'cmq9xyrjx00008tc4xck1k9qo';
DELETE FROM pending_approvals         WHERE "clubId" = 'cmq9xyrjx00008tc4xck1k9qo';

-- 5) Messaging involving member/guardian logins (staff<->staff threads preserved)
DELETE FROM messages                  WHERE "clubId" = 'cmq9xyrjx00008tc4xck1k9qo'
   AND ("senderId"       IN (SELECT id FROM users WHERE "clubId" = 'cmq9xyrjx00008tc4xck1k9qo' AND role='MEMBER')
     OR "recipientId"    IN (SELECT id FROM users WHERE "clubId" = 'cmq9xyrjx00008tc4xck1k9qo' AND role='MEMBER')
     OR "subjectMemberId" IN (SELECT id FROM members WHERE "clubId" = 'cmq9xyrjx00008tc4xck1k9qo'));
DELETE FROM announcement_engagements  WHERE "clubId" = 'cmq9xyrjx00008tc4xck1k9qo'
   AND "userId" IN (SELECT id FROM users WHERE "clubId" = 'cmq9xyrjx00008tc4xck1k9qo' AND role='MEMBER');
DELETE FROM group_message_receipts    WHERE "userId" IN (SELECT id FROM users WHERE "clubId" = 'cmq9xyrjx00008tc4xck1k9qo' AND role='MEMBER');
DELETE FROM group_messages            WHERE "senderId" IN (SELECT id FROM users WHERE "clubId" = 'cmq9xyrjx00008tc4xck1k9qo' AND role='MEMBER');
DELETE FROM message_group_members     WHERE "userId" IN (SELECT id FROM users WHERE "clubId" = 'cmq9xyrjx00008tc4xck1k9qo' AND role='MEMBER');

-- 6) Legal acceptances + guardian links for member logins
DELETE FROM legal_acceptances         WHERE "userId" IN (SELECT id FROM users WHERE "clubId" = 'cmq9xyrjx00008tc4xck1k9qo' AND role='MEMBER');
DELETE FROM member_guardian_users     WHERE "memberId" IN (SELECT id FROM members WHERE "clubId" = 'cmq9xyrjx00008tc4xck1k9qo')
                                          OR "userId"  IN (SELECT id FROM users   WHERE "clubId" = 'cmq9xyrjx00008tc4xck1k9qo' AND role='MEMBER');

-- 7) Parents last: members -> guardians -> member/guardian logins only
DELETE FROM members                   WHERE "clubId" = 'cmq9xyrjx00008tc4xck1k9qo';
DELETE FROM guardians                 WHERE "clubId" = 'cmq9xyrjx00008tc4xck1k9qo';
DELETE FROM users                     WHERE "clubId" = 'cmq9xyrjx00008tc4xck1k9qo' AND role = 'MEMBER';

COMMIT;


-- ============================================================================
-- SECTION 3 — VERIFY (read-only): member data should be 0; setup preserved.
-- ============================================================================
SELECT
 (SELECT count(*) FROM members    WHERE "clubId"='cmq9xyrjx00008tc4xck1k9qo')                    AS members_left,
 (SELECT count(*) FROM guardians  WHERE "clubId"='cmq9xyrjx00008tc4xck1k9qo')                    AS guardians_left,
 (SELECT count(*) FROM users      WHERE "clubId"='cmq9xyrjx00008tc4xck1k9qo' AND role='MEMBER')  AS member_logins_left,
 (SELECT count(*) FROM transactions WHERE "clubId"='cmq9xyrjx00008tc4xck1k9qo')                  AS transactions_left,
 (SELECT count(*) FROM users      WHERE "clubId"='cmq9xyrjx00008tc4xck1k9qo' AND role='OWNER')   AS owners_kept,
 (SELECT count(*) FROM users      WHERE "clubId"='cmq9xyrjx00008tc4xck1k9qo' AND role='STAFF')   AS staff_kept,
 (SELECT count(*) FROM memberships WHERE "clubId"='cmq9xyrjx00008tc4xck1k9qo')                   AS memberships_kept,
 (SELECT count(*) FROM recurring_classes WHERE "clubId"='cmq9xyrjx00008tc4xck1k9qo')             AS classes_kept,
 (SELECT count(*) FROM events     WHERE "clubId"='cmq9xyrjx00008tc4xck1k9qo')                    AS events_kept;
