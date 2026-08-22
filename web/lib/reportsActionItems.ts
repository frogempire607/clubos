// Reports Phase 2.5.1a — Action Items feed on the owner-first Snapshot.
//
// The question "What requires my attention today?" gets a concrete list of
// tasks, not just KPIs. Each item is permission-gated and drills through to
// the exact fix.

import { prisma } from "@/lib/prisma";
import { ENDING_SOON_WINDOW_DAYS } from "@/lib/membersQuery";

/**
 * How urgent an ending membership is, purely as a function of how far away it
 * is. Exported so it can be tested at its boundaries without a database —
 * the thresholds are the product decision here, not the query.
 */
export function renewalSeverity(daysAway: number): ActionItem["severity"] {
  if (daysAway <= 14) return "high";
  if (daysAway <= 45) return "medium";
  return "low";
}

export const ACTION_ITEM_KINDS = [
  "FAILED_PAYMENT",
  "EXPIRING_MEMBERSHIP",
  "UPCOMING_RENEWAL_LARGE",
  "UNRECONCILED_DEPOSIT",
  "OFFLINE_PAYMENT_PENDING",
  "UNCATEGORIZED_LARGE_BANK",
  "HISTORICAL_IMPORT_REVIEW",
  "PAYMENT_METHOD_EXPIRING",
  "CLASS_MISSING_DROPIN_PRICE",
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

/**
 * Can this class charge a member whose plan does not cover the weekday?
 *
 * True (i.e. misconfigured) when the class ACCEPTS a membership but offers no
 * positive drop-in or non-member price. Exported so the rule can be tested
 * without a database — it fires on nothing today, so the logic is the only
 * thing there is to verify.
 *
 * A price of 0 is not a fallback: free is what the member already gets, so a
 * zero-priced drop-in leaves the club exactly as unable to charge.
 */
export function cannotChargeOutsidePlanDays(pricingOptions: unknown): boolean {
  const opts = (pricingOptions as Array<{ type?: string; price?: number }> | null) ?? [];
  if (!Array.isArray(opts)) return false;
  const acceptsMembership = opts.some((o) => o?.type === "membership");
  if (!acceptsMembership) return false;
  const hasFallback = opts.some(
    (o) => (o?.type === "dropin" || o?.type === "nonmember") && typeof o.price === "number" && o.price > 0,
  );
  return !hasFallback;
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

  // 2. EXPIRING_MEMBERSHIP — live memberships with a date on which they STOP.
  //
  // ── Why ENDING_SOON_WINDOW_DAYS and one card per member ──────────────────
  //
  // This probe used to look 14 days ahead and roll everyone into a single card
  // naming at most three of them. On 2026-08-16 Frog Empire had eight
  // memberships ending between 2026-09-11 and 2026-11-23 as stored — genuine
  // commitment end dates, every one needing a re-sign conversation — and the
  // card showed NONE of them: the nearest was 26 days out.
  //
  // Fourteen days is not a lead time for a conversation about money; it is a
  // notice period. The window is 120 days (lib/membersQuery.ts), tiered by
  // proximity. 90 was the first attempt and it still missed the furthest of the
  // eight by nine days — the test in scripts/renewal-surfacing-tests.ts pins
  // every one of those real dates so a future narrowing fails loudly.
  //
  // One item per member, not a rollup: each one is a different phone call, and
  // the snooze table is already keyed by (kind, targetId) so an owner can
  // clear the ones they have already handled without silencing the rest.
  const windowEnd = new Date(now.getTime() + ENDING_SOON_WINDOW_DAYS * 86400000);
  const ending = await prisma.memberSubscription.findMany({
    where: {
      status: "active",
      endDate: { gte: now, lte: windowEnd },
      member: { clubId, deletedAt: null },
    },
    select: {
      id: true,
      endDate: true,
      price: true,
      optionLabel: true,
      member: { select: { id: true, firstName: true, lastName: true } },
      membership: { select: { name: true } },
    },
    orderBy: { endDate: "asc" },
    take: 100,
  });

  // Per-member cards for the nearest ones; anything past PER_MEMBER_LIMIT is
  // rolled into a single trailing card so a large roster cannot bury every
  // other action item under sixty renewal reminders. The rollup states how
  // many it stands for — a truncated list that does not say it was truncated
  // reads as "that is all of them".
  const PER_MEMBER_LIMIT = 20;
  const visible = ending.slice(0, PER_MEMBER_LIMIT);
  const overflow = ending.length - visible.length;

  const dayFmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  for (const sub of visible) {
    if (isSnoozed("EXPIRING_MEMBERSHIP", sub.member.id)) continue;
    const days = Math.max(0, Math.round((sub.endDate!.getTime() - now.getTime()) / 86400000));
    items.push({
      id: itemId("EXPIRING_MEMBERSHIP", sub.member.id),
      kind: "EXPIRING_MEMBERSHIP",
      // Proximity IS the severity here. A membership ending next week and one
      // ending in three months are the same fact and completely different
      // tasks.
      severity: renewalSeverity(days),
      title: `${sub.member.firstName} ${sub.member.lastName} — membership ends ${dayFmt(sub.endDate!)}`,
      detail:
        `${sub.membership?.name ?? "Membership"}` +
        `${sub.optionLabel ? ` · ${sub.optionLabel}` : ""} · $${Number(sub.price ?? 0).toFixed(2)} · ` +
        `${days === 0 ? "ends today" : `${days} day${days === 1 ? "" : "s"} away`}. ` +
        `Re-sign them before it lapses.`,
      count: null,
      amount: Number(sub.price ?? 0) || null,
      href: `/dashboard/members/${sub.member.id}/billing`,
      action: { label: "Open billing", kind: "OPEN", permission: "billing:view" },
    });
  }

  if (overflow > 0 && !isSnoozed("EXPIRING_MEMBERSHIP")) {
    items.push({
      id: itemId("EXPIRING_MEMBERSHIP", "_overflow"),
      kind: "EXPIRING_MEMBERSHIP",
      severity: "low",
      title: `${overflow} more membership${overflow === 1 ? "" : "s"} ending within ${ENDING_SOON_WINDOW_DAYS} days`,
      detail: "Not listed individually here — open the roster queue to work through them.",
      count: overflow,
      amount: null,
      // The real queue, added alongside this in lib/membersQuery.ts. The old
      // href pointed at `?filter=expiring`, which was never a filter this app
      // parsed — the card's only call to action opened an unfiltered roster.
      href: "/dashboard/members?queue=endingSoon",
      action: { label: "Open queue", kind: "OPEN", permission: "members:view" },
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
      // Bare link — see the note on OFFLINE_PAYMENT_PENDING below. `?tab=stripe`
      // never selected the Stripe tab; that tab is useState.
      href: "/dashboard/financials",
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
      // Bare link: /dashboard/financials parses NO query parameters at all —
      // its `tab` is useState, not a URL param — so `?tab=offline&filter=pending`
      // selected nothing and filtered nothing. Fourth of five dead Action Item
      // links found on 2026-08-16. Deep-linking Financials means teaching that
      // page to read its tab from the URL, which is a feature, not a bug fix.
      href: "/dashboard/financials",
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
      // Same as above — no query parameter here was ever read.
      href: "/dashboard/financials",
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
      // No query string: there is no roster queue for "large renewals billing
      // within 7 days", and this used to link to `?filter=upcoming_renewals`,
      // which the roster has never parsed — the same dead-link bug as
      // EXPIRING_MEMBERSHIP's `?filter=expiring`. A bare link that opens the
      // real roster is honest; a parameter that silently does nothing is not.
      // Giving this card its own queue is a product decision, not a bug fix.
      href: "/dashboard/members",
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

  // 9. CLASS_MISSING_DROPIN_PRICE — a class that accepts memberships but sets
  //    NO drop-in and NO non-member price.
  //
  //    This is the configuration gap the whole day-entitlement path fails open
  //    around. A member whose option does not grant a given weekday is supposed
  //    to fall to the drop-in tier; with neither price configured there is
  //    nothing to charge, so `/api/member/classes/book` books them free and
  //    flags the row rather than turning a paying family away at the door
  //    (§8.4.2). That is the right behaviour for the family and the wrong
  //    outcome for the club, and it is invisible unless somebody looks.
  //
  //    It is a ONE-TIME fix per class, not a per-booking alert — which is why
  //    it lives here rather than firing on every affected booking.
  //
  //    Today it fires on nothing: every active class is drop-in only. It exists
  //    so the mistake is visible the first time somebody makes it.
  const classesForPricing = await prisma.recurringClass.findMany({
    where: { clubId, deletedAt: null, active: true },
    select: { id: true, name: true, pricingOptions: true },
    take: 200,
  });
  const misconfigured = classesForPricing.filter((c) => cannotChargeOutsidePlanDays(c.pricingOptions));
  if (misconfigured.length > 0 && !isSnoozed("CLASS_MISSING_DROPIN_PRICE")) {
    items.push({
      id: itemId("CLASS_MISSING_DROPIN_PRICE"),
      kind: "CLASS_MISSING_DROPIN_PRICE",
      severity: "medium",
      title: `${misconfigured.length} class${misconfigured.length === 1 ? "" : "es"} can't charge a member outside their plan days`,
      detail:
        (misconfigured.length <= 3
          ? misconfigured.map((c) => c.name).join(", ")
          : `${misconfigured[0].name} and ${misconfigured.length - 1} others`) +
        " accept a membership but set no drop-in or non-member price, so a member whose plan doesn't cover that weekday is booked free.",
      count: misconfigured.length,
      amount: null,
      href: "/dashboard/classes",
      action: { label: "Set a price", kind: "OPEN", permission: "classes:edit" },
    });
  }

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
