// Reports Phase 2.5.1a — Action Items feed on the owner-first Snapshot.
//
// The question "What requires my attention today?" gets a concrete list of
// tasks, not just KPIs. Each item is permission-gated and drills through to
// the exact fix.

import { prisma } from "@/lib/prisma";

export const ACTION_ITEM_KINDS = [
  "FAILED_PAYMENT",
  "EXPIRING_MEMBERSHIP",
  "UPCOMING_RENEWAL_LARGE",
  "UNRECONCILED_DEPOSIT",
  "OFFLINE_PAYMENT_PENDING",
  "UNCATEGORIZED_LARGE_BANK",
  "HISTORICAL_IMPORT_REVIEW",
  "PAYMENT_METHOD_EXPIRING",
] as const;
export type ActionKind = (typeof ACTION_ITEM_KINDS)[number];

export type ActionItem = {
  id: string;
  kind: ActionKind;
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  count: number | null;
  amount: number | null;
  href: string;
  action: { label: string; kind: string; permission: string } | null;
};

export type ActionItemsPayload = {
  items: ActionItem[];
  counts: { high: number; medium: number; low: number };
  generatedAt: string;
};

// Default thresholds. `ReportAlertSetting` (Phase 2.5.8) will let the owner
// customize these — for now these are the seeded defaults.
const DEFAULT_UPCOMING_RENEWAL_LARGE = 200;
const DEFAULT_UNCATEGORIZED_LARGE_BANK = 500;

// A key that uniquely identifies a row for snoozing. targetId is the domain
// row (member, subscription, transaction, etc.) or null for kind-wide snooze.
function itemId(kind: ActionKind, targetId?: string | null): string {
  return targetId ? `${kind}:${targetId}` : `${kind}:_`;
}

export async function buildActionItems(
  clubId: string,
  userId: string,
): Promise<ActionItemsPayload> {
  const now = new Date();

  // Load the caller's active snoozes.
  const snoozes = await prisma.actionItemSnooze.findMany({
    where: {
      userId,
      snoozedUntil: { gt: now },
      OR: [{ clubId }, { clubId: "" }], // future-proof
    },
    select: { kind: true, targetId: true },
  });
  const snoozed = new Set(snoozes.map((s) => itemId(s.kind as ActionKind, s.targetId)));
  const isSnoozed = (kind: ActionKind, targetId?: string | null) =>
    snoozed.has(itemId(kind, targetId)) || snoozed.has(itemId(kind, null));

  const items: ActionItem[] = [];

  // 1. FAILED_PAYMENT — subscriptions currently past_due (Stripe
  //    invoice.payment_failed already flipped status). Aggregate: one card
  //    per past_due sub isn't scannable for a large roster, so we roll up.
  const pastDue = await prisma.memberSubscription.findMany({
    where: {
      status: "past_due",
      member: { clubId, deletedAt: null },
    },
    select: {
      id: true,
      price: true,
      member: { select: { id: true, firstName: true, lastName: true } },
    },
    take: 100,
  });
  if (pastDue.length > 0 && !isSnoozed("FAILED_PAYMENT")) {
    const amount = pastDue.reduce((s, p) => s + Number(p.price ?? 0), 0);
    items.push({
      id: itemId("FAILED_PAYMENT"),
      kind: "FAILED_PAYMENT",
      severity: "high",
      title: `${pastDue.length} past-due subscription${pastDue.length === 1 ? "" : "s"}`,
      detail:
        pastDue.length <= 3
          ? pastDue
              .map((p) => `${p.member.firstName} ${p.member.lastName}`)
              .join(", ") + " — retry or contact the member."
          : `Total past due: $${amount.toFixed(2)}.`,
      count: pastDue.length,
      amount,
      href: "/dashboard/members/approvals",
      action: { label: "Review", kind: "OPEN", permission: "billing:view" },
    });
  }

  // 2. EXPIRING_MEMBERSHIP — active subs ending in the next 14 days.
  const in14d = new Date(now.getTime() + 14 * 86400000);
  const expiring = await prisma.memberSubscription.findMany({
    where: {
      status: "active",
      member: { clubId, deletedAt: null },
      OR: [
        { endDate: { gte: now, lte: in14d } },
      ],
    },
    select: {
      id: true,
      endDate: true,
      member: { select: { id: true, firstName: true, lastName: true } },
      membership: { select: { name: true } },
    },
    take: 50,
  });
  if (expiring.length > 0 && !isSnoozed("EXPIRING_MEMBERSHIP")) {
    items.push({
      id: itemId("EXPIRING_MEMBERSHIP"),
      kind: "EXPIRING_MEMBERSHIP",
      severity: "medium",
      title: `${expiring.length} membership${expiring.length === 1 ? "" : "s"} expiring in 14 days`,
      detail:
        expiring.length <= 3
          ? expiring
              .map((s) => `${s.member.firstName} ${s.member.lastName} (${s.membership?.name ?? "plan"})`)
              .join(", ")
          : "Reach out before they lapse.",
      count: expiring.length,
      amount: null,
      href: "/dashboard/members?filter=expiring",
      action: { label: "Message", kind: "OPEN", permission: "messages:send" },
    });
  }

  // 3. UNRECONCILED_DEPOSIT — this needs PayoutMatch which lands in Phase
  //    2.5.7. For now, surface a proxy: Stripe transactions with no
  //    stripeChargeId that are older than 10 days.
  const tenDaysAgo = new Date(now.getTime() - 10 * 86400000);
  const unreconciled = await prisma.transaction.count({
    where: {
      clubId,
      paymentSource: "STRIPE",
      status: "SUCCEEDED",
      stripeChargeId: null,
      createdAt: { lt: tenDaysAgo },
    },
  });
  if (unreconciled > 0 && !isSnoozed("UNRECONCILED_DEPOSIT")) {
    items.push({
      id: itemId("UNRECONCILED_DEPOSIT"),
      kind: "UNRECONCILED_DEPOSIT",
      severity: "medium",
      title: `${unreconciled} unreconciled Stripe row${unreconciled === 1 ? "" : "s"}`,
      detail: "Older than 10 days without a matching charge ID.",
      count: unreconciled,
      amount: null,
      href: "/dashboard/financials?tab=stripe",
      action: { label: "Reconcile", kind: "OPEN", permission: "finances:full" },
    });
  }

  // 4. OFFLINE_PAYMENT_PENDING — cash/check older than 3 days.
  const threeDaysAgo = new Date(now.getTime() - 3 * 86400000);
  const offlinePending = await prisma.transaction.findMany({
    where: {
      clubId,
      status: "PENDING",
      paymentSource: { in: ["CASH", "CHECK"] },
      createdAt: { lt: threeDaysAgo },
    },
    select: { id: true, amount: true },
    take: 100,
  });
  if (offlinePending.length > 0 && !isSnoozed("OFFLINE_PAYMENT_PENDING")) {
    const amount = offlinePending.reduce((s, t) => s + Number(t.amount), 0);
    items.push({
      id: itemId("OFFLINE_PAYMENT_PENDING"),
      kind: "OFFLINE_PAYMENT_PENDING",
      severity: offlinePending.length > 3 ? "medium" : "low",
      title: `${offlinePending.length} offline payment${offlinePending.length === 1 ? "" : "s"} awaiting receipt`,
      detail: `Total: $${amount.toFixed(2)}. Older than 3 days.`,
      count: offlinePending.length,
      amount,
      href: "/dashboard/financials?tab=offline&filter=pending",
      action: { label: "Record", kind: "OPEN", permission: "billing:full" },
    });
  }

  // 5. UNCATEGORIZED_LARGE_BANK — bank rows above threshold with no review.
  const largeUncategorized = await prisma.plaidTransaction.findMany({
    where: {
      clubId,
      reviewedAt: null,
      categorizedExpenseId: null,
      markedAsTransfer: false,
      excludedFromTax: false,
      OR: [
        { amount: { gte: DEFAULT_UNCATEGORIZED_LARGE_BANK } },
        { amount: { lte: -DEFAULT_UNCATEGORIZED_LARGE_BANK } },
      ],
    },
    select: { id: true, amount: true, name: true, date: true },
    take: 20,
  });
  if (largeUncategorized.length > 0 && !isSnoozed("UNCATEGORIZED_LARGE_BANK")) {
    const totalAbs = largeUncategorized.reduce((s, t) => s + Math.abs(Number(t.amount)), 0);
    items.push({
      id: itemId("UNCATEGORIZED_LARGE_BANK"),
      kind: "UNCATEGORIZED_LARGE_BANK",
      severity: "medium",
      title: `${largeUncategorized.length} bank transaction${largeUncategorized.length === 1 ? "" : "s"} over $${DEFAULT_UNCATEGORIZED_LARGE_BANK} need a category`,
      detail: `Total abs: $${totalAbs.toFixed(2)}. Categorize so tax + P&L stay accurate.`,
      count: largeUncategorized.length,
      amount: totalAbs,
      href: "/dashboard/financials?tab=bank&filter=needs_review",
      action: { label: "Categorize", kind: "OPEN", permission: "finances:full" },
    });
  }

  // 6. UPCOMING_RENEWAL_LARGE — MemberSubscription price >= threshold with
  //    a next-billing within 7 days. Best-effort with existing schema.
  const in7d = new Date(now.getTime() + 7 * 86400000);
  const upcomingRenewals = await prisma.memberSubscription.findMany({
    where: {
      status: "active",
      member: { clubId, deletedAt: null },
      price: { gte: DEFAULT_UPCOMING_RENEWAL_LARGE },
      OR: [
        { currentPeriodEnd: { gte: now, lte: in7d } },
        { endDate: { gte: now, lte: in7d } },
      ],
    },
    select: {
      id: true,
      price: true,
      currentPeriodEnd: true,
      endDate: true,
      member: { select: { firstName: true, lastName: true } },
      membership: { select: { name: true } },
    },
    take: 25,
  });
  if (upcomingRenewals.length > 0 && !isSnoozed("UPCOMING_RENEWAL_LARGE")) {
    const total = upcomingRenewals.reduce((s, r) => s + Number(r.price ?? 0), 0);
    items.push({
      id: itemId("UPCOMING_RENEWAL_LARGE"),
      kind: "UPCOMING_RENEWAL_LARGE",
      severity: "low",
      title: `${upcomingRenewals.length} large renewal${upcomingRenewals.length === 1 ? "" : "s"} in the next 7 days`,
      detail: `Total incoming: $${total.toFixed(2)}. Confirm payment methods are on file.`,
      count: upcomingRenewals.length,
      amount: total,
      href: "/dashboard/members?filter=upcoming_renewals",
      action: { label: "Review", kind: "OPEN", permission: "billing:view" },
    });
  }

  // 7. HISTORICAL_IMPORT_REVIEW — comes online in 2.5.9 when ImportBatch
  //    exists. Feature-detect and skip gracefully.
  try {
    const p = prisma as unknown as {
      importBatch?: {
        findMany: (args: unknown) => Promise<Array<{ id: string; reviewCount: number }>>;
      };
    };
    if (p.importBatch) {
      const pending = await p.importBatch.findMany({
        where: { clubId, status: "AWAITING_REVIEW", reviewCount: { gt: 0 } },
        select: { id: true, reviewCount: true },
        take: 10,
      });
      if (pending.length > 0 && !isSnoozed("HISTORICAL_IMPORT_REVIEW")) {
        const total = pending.reduce((s, b) => s + b.reviewCount, 0);
        items.push({
          id: itemId("HISTORICAL_IMPORT_REVIEW"),
          kind: "HISTORICAL_IMPORT_REVIEW",
          severity: "low",
          title: `${total} import row${total === 1 ? "" : "s"} waiting for your decision`,
          detail: "Historical import matches need review.",
          count: total,
          amount: null,
          href: "/dashboard/reports/imports",
          action: { label: "Review matches", kind: "OPEN", permission: "reports:view" },
        });
      }
    }
  } catch {
    // model doesn't exist yet — skip.
  }

  // 8. PAYMENT_METHOD_EXPIRING — needs live Stripe. Deferred to a follow-up
  //    when we already have a saved-cards service; skip in MVP.

  items.sort((a, b) => {
    const sevOrder = { high: 0, medium: 1, low: 2 };
    if (sevOrder[a.severity] !== sevOrder[b.severity]) return sevOrder[a.severity] - sevOrder[b.severity];
    return (b.amount ?? 0) - (a.amount ?? 0);
  });

  const counts = {
    high: items.filter((i) => i.severity === "high").length,
    medium: items.filter((i) => i.severity === "medium").length,
    low: items.filter((i) => i.severity === "low").length,
  };

  return { items, counts, generatedAt: now.toISOString() };
}
