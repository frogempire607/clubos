// Membership transfer — move WHO USES a membership without moving WHO PAYS.
//
// ── The case this exists for ─────────────────────────────────────────────────
// A parent buys a membership while looking at their own profile and it lands on
// their own member row. They meant it for their kid. Today there are two
// half-answers and neither works:
//
//   billing-admin `reassign_subscription` — 409s on any live Stripe sub and
//     tells staff to cancel and re-create, which would end the billing
//     relationship and destroy the receipt.
//   member family `purchases` POST — repoints memberId with no preview, no
//     eligibility check, no audit row, and no idea Stripe exists, so it
//     silently leaves Stripe billing the original customer.
//
// The right answer is the second outcome reached deliberately: the beneficiary
// changes, the payer does not, Stripe is untouched, and the actor confirms in
// writing that they understood that.
//
// ── Eligibility (owner-decided 2026-08-02) ───────────────────────────────────
// Usage does NOT disqualify a transfer. The primary case is correcting an
// accidental self-purchase, which is by definition already billed — a
// "billed at least once" bar would block the exact thing this is for. Instead
// we SURFACE usage and require an explicit acknowledgement when any exists.
//
// What genuinely blocks: a canceled/expired subscription (nothing to transfer),
// a target who already holds an active membership (would double-bill the
// family), and a target outside the payer's own family.

import { prisma } from "@/lib/prisma";
import { ACTIVE_GUARDIAN_LINK, billingUnchangedNote, resolvePayerUserId } from "@/lib/familyAccess";
import {
  TRANSFERABLE_SUBSCRIPTION_STATUSES,
  transferBlockersFor,
  type TransferBlocker as PureTransferBlocker,
} from "@/lib/familyRules";

/** Subscription states that still represent a live membership worth moving. */
export const TRANSFERABLE_STATUSES = TRANSFERABLE_SUBSCRIPTION_STATUSES;

export type UsageSnapshot = {
  attendanceCount: number;
  bookingCount: number;
  /** Payments under this membership. Recorded, but NEVER counted as usage. */
  transactionCount: number;
  firstUsedAt: string | null;
  lastUsedAt: string | null;
  /**
   * True when the membership has actually been CONSUMED — attendance or
   * bookings. Deliberately excludes payments.
   *
   * It used to include transactions, which made the warning fire on every
   * accidental self-purchase (they always have a payment — that's what created
   * the membership) while displaying "0 attendance, 0 bookings". A warning that
   * always fires with zeros is one staff learn to click through, which makes
   * every REAL usage warning worthless.
   */
  hasUsage: boolean;
};

export type TransferBlocker = PureTransferBlocker;

export type TransferPreview = {
  subscriptionId: string;
  planName: string;
  optionLabel: string | null;
  price: string;
  billingPeriod: string | null;
  status: string;
  from: { memberId: string; name: string };
  to: { memberId: string; name: string } | null;
  payer: { userId: string | null; name: string };
  isLiveStripe: boolean;
  stripeSubscriptionId: string | null;
  usage: UsageSnapshot;
  /** The exact sentence the actor must confirm. Stored on the transfer row. */
  billingNote: string;
  /** Family members this subscription may be moved to. */
  eligibleTargets: { memberId: string; name: string; isMinor: boolean; hasActiveMembership: boolean }[];
  blockers: TransferBlocker[];
};

/**
 * Everything that has happened under this membership, for the "you're moving a
 * membership that's been used" warning.
 *
 * Attendance and bookings are keyed to the member, not the subscription, so we
 * scope by the subscription's own date window. That is an approximation and is
 * labelled as one in the UI — it exists to inform a human decision, never to
 * gate one automatically.
 */
export async function usageSnapshotFor(subscriptionId: string): Promise<UsageSnapshot> {
  const sub = await prisma.memberSubscription.findUnique({
    where: { id: subscriptionId },
    select: { memberId: true, startDate: true, createdAt: true, endDate: true },
  });
  if (!sub) {
    return { attendanceCount: 0, bookingCount: 0, transactionCount: 0, firstUsedAt: null, lastUsedAt: null, hasUsage: false };
  }

  const from = sub.startDate ?? sub.createdAt;
  const to = sub.endDate ?? new Date();
  const window = { gte: from, lte: to };

  const [attendance, bookings, transactions, first, last] = await Promise.all([
    prisma.attendanceRecord.count({ where: { memberId: sub.memberId, createdAt: window } }),
    prisma.booking.count({ where: { memberId: sub.memberId, createdAt: window } }),
    prisma.transaction.count({
      where: { memberId: sub.memberId, createdAt: window, status: "SUCCEEDED" },
    }),
    prisma.attendanceRecord.findFirst({
      where: { memberId: sub.memberId, createdAt: window },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    prisma.attendanceRecord.findFirst({
      where: { memberId: sub.memberId, createdAt: window },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);

  return {
    attendanceCount: attendance,
    bookingCount: bookings,
    transactionCount: transactions,
    firstUsedAt: first?.createdAt.toISOString() ?? null,
    lastUsedAt: last?.createdAt.toISOString() ?? null,
    // Payments are NOT usage — see the type doc above.
    hasUsage: attendance > 0 || bookings > 0,
  };
}

const fullName = (m: { firstName: string; lastName: string }) =>
  `${m.firstName} ${m.lastName}`.trim();

/**
 * Who this membership may move to: the payer's own family.
 *
 * "Family" is every member the payer's login has a CONFIRMED guardian link to,
 * plus the payer's own member row. MemberRelationship is deliberately NOT
 * consulted — it grants nothing, and treating it as family here would let a
 * descriptive label move money-backed membership between unrelated people.
 */
export async function eligibleTargetsFor(args: {
  clubId: string;
  payerUserId: string | null;
  currentMemberId: string;
}) {
  if (!args.payerUserId) return [];

  const [links, own] = await Promise.all([
    prisma.memberGuardianUser.findMany({
      where: { ...ACTIVE_GUARDIAN_LINK, userId: args.payerUserId, member: { clubId: args.clubId, deletedAt: null } },
      select: { member: { select: { id: true, firstName: true, lastName: true, isMinor: true } } },
    }),
    prisma.member.findFirst({
      where: { userId: args.payerUserId, clubId: args.clubId, deletedAt: null },
      select: { id: true, firstName: true, lastName: true, isMinor: true },
    }),
  ]);

  const byId = new Map<string, { id: string; firstName: string; lastName: string; isMinor: boolean }>();
  for (const l of links) byId.set(l.member.id, l.member);
  if (own) byId.set(own.id, own);
  byId.delete(args.currentMemberId);

  const ids = [...byId.keys()];
  const active = ids.length
    ? await prisma.memberSubscription.findMany({
        where: { memberId: { in: ids }, status: { in: ["active", "past_due"] } },
        select: { memberId: true },
      })
    : [];
  const hasActive = new Set(active.map((a) => a.memberId));

  return [...byId.values()].map((m) => ({
    memberId: m.id,
    name: fullName(m),
    isMinor: m.isMinor,
    hasActiveMembership: hasActive.has(m.id),
  }));
}

export async function buildTransferPreview(args: {
  clubId: string;
  subscriptionId: string;
  targetMemberId?: string | null;
}): Promise<TransferPreview | null> {
  const sub = await prisma.memberSubscription.findFirst({
    where: { id: args.subscriptionId, membership: { clubId: args.clubId } },
    select: {
      id: true, status: true, optionLabel: true, price: true, billingPeriod: true,
      stripeSubscriptionId: true, payerUserId: true,
      membership: { select: { name: true, clubId: true } },
      member: {
        select: {
          id: true, firstName: true, lastName: true, userId: true,
          responsiblePayerUserId: true,
        },
      },
    },
  });
  if (!sub) return null;

  const payerUserId = resolvePayerUserId({
    subscriptionPayerUserId: sub.payerUserId,
    memberResponsiblePayerUserId: sub.member.responsiblePayerUserId,
    memberUserId: sub.member.userId,
  });

  const payerUser = payerUserId
    ? await prisma.user.findUnique({
        where: { id: payerUserId },
        select: { firstName: true, lastName: true, email: true },
      })
    : null;
  const payerName =
    `${payerUser?.firstName ?? ""} ${payerUser?.lastName ?? ""}`.trim() ||
    payerUser?.email ||
    fullName(sub.member);

  const [usage, eligibleTargets] = await Promise.all([
    usageSnapshotFor(sub.id),
    eligibleTargetsFor({ clubId: args.clubId, payerUserId, currentMemberId: sub.member.id }),
  ]);

  // Eligibility is a PURE rule (lib/familyRules) so it can be tested
  // exhaustively against fixtures without a database — see §4D.
  const blockers = transferBlockersFor({
    subscriptionStatus: sub.status,
    fromMemberId: sub.member.id,
    targetMemberId: args.targetMemberId ?? null,
    eligibleTargets,
  });

  const matched = args.targetMemberId
    ? eligibleTargets.find((t) => t.memberId === args.targetMemberId)
    : undefined;
  const to = matched ? { memberId: matched.memberId, name: matched.name } : null;

  return {
    subscriptionId: sub.id,
    planName: sub.membership.name,
    optionLabel: sub.optionLabel,
    price: sub.price.toString(),
    billingPeriod: sub.billingPeriod,
    status: sub.status,
    from: { memberId: sub.member.id, name: fullName(sub.member) },
    to,
    payer: { userId: payerUserId, name: payerName },
    isLiveStripe: !!sub.stripeSubscriptionId,
    stripeSubscriptionId: sub.stripeSubscriptionId,
    usage,
    billingNote: billingUnchangedNote({
      payerName,
      toAthleteName: to?.name ?? "the new athlete",
      isLiveStripe: !!sub.stripeSubscriptionId,
    }),
    eligibleTargets,
    blockers,
  };
}

/**
 * Execute a transfer. Caller has already authorized the actor and confirmed the
 * acknowledgement — this function re-validates rather than trusting that, then
 * writes the beneficiary change and its audit row in ONE transaction.
 *
 * What it deliberately does NOT do: touch Stripe. Not the subscription, not the
 * customer, not the card. The money keeps flowing from the same place; only the
 * athlete on the membership changes.
 */
export async function executeTransfer(args: {
  clubId: string;
  subscriptionId: string;
  targetMemberId: string;
  actorUserId: string | null;
  actorRole: "OWNER" | "STAFF" | "GUARDIAN";
  reason?: string | null;
  requestedByUserId?: string | null;
  requestedViaApprovalId?: string | null;
}): Promise<{ ok: true } | { ok: false; status: number; error: string; code?: string }> {
  const preview = await buildTransferPreview({
    clubId: args.clubId,
    subscriptionId: args.subscriptionId,
    targetMemberId: args.targetMemberId,
  });
  if (!preview) return { ok: false, status: 404, error: "Membership not found." };
  if (preview.blockers.length) {
    const b = preview.blockers[0];
    return { ok: false, status: 409, error: b.message, code: b.code };
  }
  if (!preview.to) return { ok: false, status: 400, error: "Pick who this membership is for." };

  // Re-read status inside the transaction and claim conditionally, so two
  // simultaneous transfers (staff approving while the parent retries) can't
  // both land.
  const claimed = await prisma.memberSubscription.updateMany({
    where: {
      id: args.subscriptionId,
      memberId: preview.from.memberId,
      status: { in: [...TRANSFERABLE_STATUSES] },
    },
    data: {
      memberId: args.targetMemberId,
      // Freeze the payer so it survives the beneficiary move. Without this the
      // payer would be re-derived from the NEW member and silently become the
      // child — the exact "do not rewrite payment ownership" failure.
      payerUserId: preview.payer.userId,
    },
  });
  if (claimed.count === 0) {
    return {
      ok: false,
      status: 409,
      error: "This membership was changed by someone else. Reload and try again.",
      code: "CONCURRENT_CHANGE",
    };
  }

  await prisma.membershipTransfer.create({
    data: {
      clubId: args.clubId,
      subscriptionId: args.subscriptionId,
      fromMemberId: preview.from.memberId,
      toMemberId: args.targetMemberId,
      performedByUserId: args.actorUserId,
      performedByRole: args.actorRole,
      requestedByUserId: args.requestedByUserId ?? null,
      requestedViaApprovalId: args.requestedViaApprovalId ?? null,
      reason: args.reason ?? null,
      payerUserIdAtTransfer: preview.payer.userId,
      stripeSubscriptionId: preview.stripeSubscriptionId,
      stripeBillingUnchanged: true,
      acknowledgedBillingNote: preview.billingNote,
      usageSnapshot: preview.usage as unknown as object,
    },
  });

  // Both member rows change meaning, so both histories should say so.
  const line =
    `Membership "${preview.planName}${preview.optionLabel ? ` — ${preview.optionLabel}` : ""}" ` +
    `moved from ${preview.from.name} to ${preview.to.name}. ` +
    `Payer unchanged (${preview.payer.name}).` +
    (preview.isLiveStripe
      ? ` Stripe subscription ${preview.stripeSubscriptionId} left untouched — billing continues from the same card.`
      : "") +
    (preview.usage.hasUsage
      ? ` Membership had prior usage: ${preview.usage.attendanceCount} attendance, ${preview.usage.bookingCount} bookings.`
      : "") +
    (args.reason ? ` Reason: ${args.reason}` : "");

  await prisma.memberMigrationEvent.createMany({
    data: [preview.from.memberId, args.targetMemberId].map((memberId) => ({
      clubId: args.clubId,
      memberId,
      type: "NOTE",
      actorUserId: args.actorUserId,
      message: line,
    })),
  });

  // Both athletes' ACTIVE/PROSPECT state depends on holding a live membership,
  // so recompute or the roster lies in both directions.
  const { recomputeMemberStatus } = await import("@/lib/memberStatus");
  await recomputeMemberStatus(preview.from.memberId, args.clubId);
  await recomputeMemberStatus(args.targetMemberId, args.clubId);

  return { ok: true };
}
