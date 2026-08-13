// Action Center — the dashboard "command center" backbone.
//
// A read-only, permission-filtered, SELF-CLEARING aggregation of everything
// that needs an owner's / staff member's attention right now. It deliberately
// does NOT persist a notification feed: each item is a live COUNT of unresolved
// records, so an item disappears the moment the underlying work is done (a coach
// is assigned, a message is read, an approval is actioned). This mirrors the
// existing /api/approvals synth pattern and adds zero write-path risk.
//
// Every probe is gated by the requester's permission (owners bypass) and runs
// as a cheap indexed COUNT in parallel. Results are cached briefly per
// (club, user) so a dashboard + bell on the same screen don't double-query.
//
// Phase 1 will add TOURNAMENT_INVOICE_DUE / TOURNAMENT_PRICE_MISSING and
// Phase 2 the payout kinds — each as one more `probe(...)` line here.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { queueClauses } from "@/lib/membersQuery";
import { hasPermission, type PermissionKey, type PermissionLevel } from "@/lib/permissions";
import { GUARDIAN_LINK_KIND } from "@/lib/guardianLink";
import { MEMBERSHIP_CANCEL_KIND } from "@/lib/approvals";
import { MIGRATION_STATUS } from "@/lib/migration";
import { UNPAID_REGISTRATION_STATUSES } from "@/lib/eventPayments";

export type ActionSeverity = "high" | "medium" | "low";

export type ActionItem = {
  kind: string;
  label: string;
  count: number;
  severity: ActionSeverity;
  href: string;
};

export type ActionCenterResult = { items: ActionItem[]; total: number; badge: number };

// Loosely typed to match the codebase's augmented next-auth Session.
type Sess =
  | { user?: { id?: string; role?: string; clubId?: string; permissions?: Record<string, unknown> | null } }
  | null;

type CacheEntry = { at: number; data: ActionCenterResult };
const CACHE = new Map<string, CacheEntry>();
const TTL_MS = 20_000;

const SEVERITY_RANK: Record<ActionSeverity, number> = { high: 0, medium: 1, low: 2 };

export async function getActionCenter(session: Sess): Promise<ActionCenterResult> {
  const role = session?.user?.role;
  const clubId = session?.user?.clubId;
  const userId = session?.user?.id;
  if (!clubId || (role !== "OWNER" && role !== "STAFF")) {
    return { items: [], total: 0, badge: 0 };
  }

  const perms = (session?.user?.permissions as Record<string, unknown> | null) ?? null;
  const isOwner = role === "OWNER";
  const can = (key: PermissionKey, level: PermissionLevel) =>
    isOwner || hasPermission(perms, key, level);

  const cacheKey = `${clubId}:${userId ?? "?"}:${isOwner ? "o" : "s"}`;
  const hit = CACHE.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  const now = new Date();
  const probes: Promise<ActionItem | null>[] = [];
  const probe = (
    enabled: boolean,
    run: () => Promise<number>,
    meta: Omit<ActionItem, "count">,
  ) => {
    if (!enabled) return;
    probes.push(
      run()
        .then((count) => (count > 0 ? { ...meta, count } : null))
        // A single probe failing must never break the whole command center.
        .catch(() => null),
    );
  };

  // ── Privates ──────────────────────────────────────────────────────────
  probe(
    can("events", "view"),
    () => prisma.privateBooking.count({ where: { clubId, status: "REQUESTED", coachId: null } }),
    {
      kind: "UNASSIGNED_PRIVATES",
      label: "Private requests need a coach",
      severity: "high",
      href: "/dashboard/privates",
    },
  );
  probe(
    can("events", "view"),
    () => prisma.privateBooking.count({ where: { clubId, status: "PENDING_COACH" } }),
    {
      kind: "PENDING_PRIVATES",
      label: "Privates awaiting coach response",
      severity: "medium",
      href: "/dashboard/privates",
    },
  );

  // ── Unbilled training ─────────────────────────────────────────────────
  //
  // Both probes read the SAME predicates the roster filter uses
  // (lib/membersQuery.queueClauses), so the number here and the list it opens
  // can never disagree. Hand-rolling the counts is exactly what produced the
  // D-3 gap where a card said one thing and its list said another.
  //
  //   STALLED_CHECKOUT — a pending, never-paid subscription. The row is created
  //     before Stripe Checkout opens and nothing expires it, so an abandoned
  //     checkout sits there indefinitely with the member training for free.
  //     (Maximus Alexander sat like this from 2026-07-26 to 2026-08-13.)
  //
  //   TRAINING_UNBILLED — attended recently with no active membership at all,
  //     whatever the reason. Verified 2026-08-13: 13 members across the club.
  probe(
    can("billing", "view"),
    () => prisma.member.count({
      where: { clubId, deletedAt: null, ...queueClauses(now).stalledCheckout },
    }),
    {
      kind: "STALLED_CHECKOUT",
      label: "Memberships stuck at checkout, never paid",
      severity: "high",
      href: "/dashboard/members?queue=stalledCheckout",
    },
  );
  probe(
    can("members", "view"),
    () => prisma.member.count({
      where: { clubId, deletedAt: null, ...queueClauses(now).trainingUnbilled },
    }),
    {
      kind: "TRAINING_UNBILLED",
      label: "Attending with no active membership",
      severity: "high",
      href: "/dashboard/members?queue=trainingUnbilled",
    },
  );

  // ── Messaging (per-user inbox) ────────────────────────────────────────
  probe(
    can("messages", "view") && !!userId,
    () => prisma.message.count({ where: { clubId, recipientId: userId, readAt: null } }),
    {
      kind: "UNREAD_MESSAGES",
      label: "Unread messages",
      severity: "medium",
      href: "/dashboard/messages",
    },
  );

  // ── Approvals (reuse the kinds the Approvals queue already surfaces) ───
  probe(
    can("members", "view"),
    () =>
      prisma.pendingApproval.count({
        where: { clubId, status: "PENDING", kind: GUARDIAN_LINK_KIND },
      }),
    {
      kind: "GUARDIAN_LINK",
      label: "Guardian links to approve",
      severity: "high",
      href: "/dashboard/members/approvals",
    },
  );
  probe(
    can("finances", "view"),
    () =>
      prisma.pendingApproval.count({
        where: { clubId, status: "PENDING", kind: MEMBERSHIP_CANCEL_KIND },
      }),
    {
      kind: "MEMBERSHIP_CANCEL",
      label: "Cancellation requests",
      severity: "high",
      href: "/dashboard/members/approvals",
    },
  );
  probe(
    can("members", "edit"),
    () =>
      prisma.member.count({
        where: {
          clubId,
          deletedAt: null,
          migrationStatus: MIGRATION_STATUS.ACTIVATED,
          approvalStatus: "PENDING_APPROVAL",
        },
      }),
    {
      kind: "MIGRATION_BILLING",
      label: "Members awaiting billing approval",
      severity: "high",
      href: "/dashboard/members/approvals",
    },
  );

  // A proposal on the table moves the ball to the PARENT even though
  // approvalStatus is still PENDING — the same precedence the waitingOn
  // resolver and the roster queue apply. Without this the owner would see a
  // "waiting on a coach" count that the roster itself says is zero.
  const notAwaitingParent = {
    OR: [
      { proposedChange: { equals: Prisma.DbNull } },
      { proposedChangeRespondedAt: { not: null } },
    ],
  };

  // ── Coach approval (Phase 5 §5.7) ────────────────────────────────────
  // The live count IS the notification: a registration leaves this probe the
  // moment a coach decides it, so there is no feed to mark read and nothing to
  // go stale. Gated on events:view because deciding is an events job, not a
  // finance one — the money side of the same registrations is already covered
  // by PENDING_EVENT_PAYMENTS below.
  //
  // Scoped to registrations whose EVENT still requires approval, so turning
  // the workflow off for an event clears its queue instead of stranding rows
  // nobody can act on any more.
  probe(
    can("events", "view"),
    () =>
      prisma.eventRegistration.count({
        where: { clubId, approvalStatus: "PENDING", status: { not: "CANCELED" }, ...notAwaitingParent },
      }),
    {
      kind: "COACH_APPROVAL_REQUESTED",
      label: "Registrations waiting on a coach",
      severity: "high",
      href: "/dashboard/events",
    },
  );
  // Aged past two days. Separate from the count above rather than a severity
  // bump on it, because "someone should look at the queue" and "this family
  // has been waiting since Tuesday" are different asks.
  probe(
    can("events", "view"),
    () =>
      prisma.eventRegistration.count({
        where: {
          clubId,
          approvalStatus: "PENDING",
          status: { not: "CANCELED" },
          approvalRequestedAt: { lt: new Date(now.getTime() - 48 * 3_600_000) },
          ...notAwaitingParent,
        },
      }),
    {
      kind: "EVENT_APPROVAL_STALLED_48H",
      label: "Registrations waiting on a coach for 2+ days",
      severity: "high",
      href: "/dashboard/events",
    },
  );
  // Past the registration deadline and still undecided — at this point the
  // family cannot be entered even if the coach says yes, so it needs an owner.
  probe(
    can("events", "view"),
    () =>
      prisma.eventRegistration.count({
        where: {
          clubId,
          approvalStatus: "PENDING",
          status: { not: "CANCELED" },
          event: { registrationDeadline: { lt: now }, deletedAt: null },
          ...notAwaitingParent,
        },
      }),
    {
      kind: "EVENT_APPROVAL_STALLED_PAST_DEADLINE",
      label: "Undecided registrations past the deadline",
      severity: "high",
      href: "/dashboard/events",
    },
  );
  // A coach proposed a change and the family has not answered. Nobody is
  // blocked on the club here, so it is low severity — but an owner reading the
  // roster should still be able to see why a spot is neither in nor out.
  probe(
    can("events", "view"),
    () =>
      prisma.eventRegistration.count({
        where: {
          clubId,
          status: { not: "CANCELED" },
          proposedChange: { not: Prisma.DbNull },
          proposedChangeRespondedAt: null,
        },
      }),
    {
      kind: "EVENT_PROPOSAL_AWAITING_PARENT",
      label: "Proposed changes waiting on a parent",
      severity: "low",
      href: "/dashboard/events",
    },
  );

  // A reminder that has failed to send three times running. The family thinks
  // nothing is owed and the club thinks they've been chased — nobody finds out
  // without this (§5.6.6).
  probe(
    can("finances", "view"),
    () => prisma.eventRegistration.count({ where: { clubId, reminderStage: -1 } }),
    {
      kind: "EVENT_REMINDER_SEND_FAILED",
      label: "Payment reminders that couldn't send",
      severity: "high",
      href: "/dashboard/events",
    },
  );
  // ── Money owed (existing dashboard signal, surfaced as an action) ─────
  // UNPAID_REGISTRATION_STATUSES keeps legacy REGISTERED rows carrying an
  // amountDue (the "registered but never paid" case this signal exists for)
  // while excluding PENDING_PAYMENT (owes nothing until checkout completes)
  // and SCHEDULED (charge already authorized for the event date).
  probe(
    can("finances", "view"),
    () =>
      prisma.eventRegistration.count({
        where: {
          clubId,
          status: { in: UNPAID_REGISTRATION_STATUSES },
          amountDue: { not: null },
        },
      }),
    {
      kind: "PENDING_EVENT_PAYMENTS",
      label: "Event payments owed",
      severity: "medium",
      href: "/dashboard/events",
    },
  );
  // A consented event-day charge that Stripe declined — the client thinks
  // they've paid, so this needs a human today.
  probe(
    can("finances", "view"),
    () => prisma.eventRegistration.count({ where: { clubId, status: "PAYMENT_FAILED" } }),
    {
      kind: "EVENT_PAYMENT_FAILED",
      label: "Event card charges that failed",
      severity: "high",
      href: "/dashboard/events",
    },
  );
  // A consented charge whose date has well passed and still hasn't settled.
  // Catches every "stuck" case at once — no scheduler configured, Stripe
  // unverifiable, repeated transient failures — so money can never quietly go
  // uncollected while the client believes they've paid.
  probe(
    can("finances", "view"),
    () =>
      prisma.eventRegistration.count({
        where: {
          clubId,
          status: "SCHEDULED",
          scheduledChargeAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
        },
      }),
    {
      kind: "EVENT_CHARGE_OVERDUE",
      label: "Scheduled event charges that haven't gone through",
      severity: "high",
      href: "/dashboard/events",
    },
  );
  // Someone paid twice (e.g. cash at the door, then clicked an old payment
  // link). Real money the club is likely holding by mistake — a log line isn't
  // enough, a person has to refund it.
  probe(
    can("finances", "view"),
    () =>
      prisma.transaction.count({
        where: { clubId, status: "SUCCEEDED", reconciliationStatus: "REVIEW", type: "EVENT" },
      }),
    {
      kind: "EVENT_DUPLICATE_PAYMENT",
      label: "Duplicate event payments to refund",
      severity: "high",
      href: "/dashboard/financials",
    },
  );

  // ── Tournament invoicing (P1) ─────────────────────────────────────────
  // A scheduled invoice date has arrived and invoices haven't gone out yet.
  probe(
    can("events", "view"),
    () =>
      prisma.event.count({
        where: {
          clubId,
          deletedAt: null,
          variableCostEnabled: true,
          variableCostBilledAt: null,
          invoiceScheduledAt: { not: null, lte: now },
        },
      }),
    {
      kind: "TOURNAMENT_INVOICE_DUE",
      label: "Tournament invoices ready to send",
      severity: "high",
      href: "/dashboard/events",
    },
  );
  // OFFICIAL-priced tournament whose registration has closed but the final
  // price was never set (no total, no expense items) — the "don't let it fall
  // through the cracks" reminder.
  probe(
    can("events", "view"),
    () =>
      prisma.event.count({
        where: {
          clubId,
          deletedAt: null,
          variableCostEnabled: true,
          variableCostMode: "OFFICIAL",
          variableCostBilledAt: null,
          variableCostTotal: null,
          registrationDeadline: { lt: now },
          expenseItems: { none: {} },
        },
      }),
    {
      kind: "TOURNAMENT_PRICE_MISSING",
      label: "Tournament price needs finalizing",
      severity: "high",
      href: "/dashboard/events",
    },
  );

  // ── Payouts (P2) — money owed to staff / guests / contractors / workers ──
  probe(
    can("finances", "view"),
    () => prisma.payout.count({ where: { clubId, status: "PENDING" } }),
    {
      kind: "PENDING_PAYOUTS",
      label: "Pending payouts to send",
      severity: "medium",
      href: "/dashboard/staff/payouts",
    },
  );

  // ── Onboarding in progress (informational, low severity) ─────────────
  probe(
    can("members", "view"),
    () =>
      prisma.member.count({
        where: { clubId, deletedAt: null, migrationStatus: MIGRATION_STATUS.INVITED },
      }),
    {
      kind: "ONBOARDING_IN_PROGRESS",
      label: "Onboarding invites not yet completed",
      severity: "low",
      href: "/dashboard/members",
    },
  );

  const items = (await Promise.all(probes)).filter((x): x is ActionItem => x !== null);
  items.sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.count - a.count,
  );

  const total = items.reduce((s, i) => s + i.count, 0);
  // Badge counts only actionable (non-low) items so the bell doesn't nag about
  // purely informational signals.
  const badge = items
    .filter((i) => i.severity !== "low")
    .reduce((s, i) => s + i.count, 0);

  const data: ActionCenterResult = { items, total, badge };
  CACHE.set(cacheKey, { at: Date.now(), data });
  return data;
}
