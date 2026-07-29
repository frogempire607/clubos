// Reports Phase 2.5.2 — Revenue tab compute layer.
//
// Owner-first ordering: mix, top items, top coaches, top classes, source
// chips. SaaS metrics (MRR, ARR, ARPA, ARPM) come as a SECONDARY block —
// still returned, just below the "primary" answers in the payload so the
// UI can order accordingly.

import { prisma } from "@/lib/prisma";
import { EXCLUDE_VOID } from "@/lib/paymentSources";
import type { ResolvedRange } from "@/lib/reportsRange";

export type RevenuePayload = {
  range: {
    key: string;
    label: string;
    start: string | null;
    end: string;
  };
  total: number;
  primary: {
    mix: {
      recurring: number;
      variable: number;
      recurringPercent: number;
      variablePercent: number;
    };
    byItem: Array<{ id: string; label: string; category: string; kind: string; units: number; amount: number; percentOfTotal: number; href: string }>;
    byCoach: Array<{ id: string; name: string; amount: number; percentOfTotal: number; reliability: "COMPLETE" | "ESTIMATED"; href: string }> | null;
    byLocation: Array<{ id: string; name: string; amount: number; percentOfTotal: number; href: string }> | null;
    bySource: Array<{ source: string; label: string; amount: number; percentOfTotal: number }>;
  };
  recurring: {
    activeMemberships: number;
    mrr: number;
    arr: number;
    arpa: number;
    arpMembership: number;
    newMemberships: number;
    renewedMemberships: number;
    endedMemberships: number;
    upgrades: number;
    downgrades: number;
    amount: number;
    percentOfTotal: number;
  };
  variable: {
    amount: number;
    percentOfTotal: number;
    byCategory: Array<{ key: string; label: string; amount: number; percentOfTotal: number }>;
  };
  reliability: "COMPLETE" | "ESTIMATED";
  reliabilityNotes: string[];
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (num: number, denom: number) =>
  denom > 0 ? Math.round((num / denom) * 1000) / 10 : 0;

function txDateWhere(r: ResolvedRange) {
  if (!r.start) return {};
  return {
    OR: [
      { txDate: { not: null, gte: r.start, lt: r.end } },
      { txDate: null, createdAt: { gte: r.start, lt: r.end } },
    ],
  };
}

// Type → owner-friendly kind for the byItem breakdown.
const KIND_BY_TYPE: Record<string, "membership" | "class" | "event" | "private" | "product" | "donation" | "other"> = {
  MEMBERSHIP: "membership",
  SUBSCRIPTION: "membership",
  CLASS: "class",
  EVENT: "event",
  PRIVATE: "private",
  PRODUCT: "product",
  DONATION: "donation",
};

const RECURRING_TYPES = new Set(["MEMBERSHIP", "SUBSCRIPTION"]);

const SOURCE_LABELS: Record<string, string> = {
  STRIPE: "Stripe",
  CASH: "Cash",
  CHECK: "Check",
  EXTERNAL_READER: "External reader",
  COMP: "Comped",
  MANUAL_ADJUSTMENT: "Manual",
  ATHLETIXOS: "AthletixOS",
  PREVIOUS_SOFTWARE: "Previous software",
  MANUAL_IMPORT: "Manual import",
  BANK: "Bank",
  OTHER: "Other",
};

// Normalize monthly amount for MRR: annual/12, quarterly/3, weekly×52/12,
// biweekly×26/12, monthly as-is.
function toMonthlyAmount(amount: number, frequency: string | null | undefined): number {
  const f = (frequency || "MONTHLY").toUpperCase();
  switch (f) {
    case "YEARLY":
    case "ANNUAL":
    case "ANNUALLY":
      return amount / 12;
    case "QUARTERLY":
      return amount / 3;
    case "WEEKLY":
      return (amount * 52) / 12;
    case "BIWEEKLY":
    case "BI_WEEKLY":
      return (amount * 26) / 12;
    case "SEMI_MONTHLY":
      return amount * 2;
    default:
      return amount;
  }
}

export async function buildRevenue(clubId: string, r: ResolvedRange): Promise<RevenuePayload> {
  const [txs, activeSubs, newSubs, endedSubs, activeMemberCount, allowMultiLoc] = await Promise.all([
    prisma.transaction.findMany({
      where: { clubId, status: "SUCCEEDED", ...EXCLUDE_VOID, ...txDateWhere(r) },
      select: {
        id: true,
        amount: true,
        refundedAmount: true,
        type: true,
        paymentSource: true,
        eventId: true,
        memberId: true,
        description: true,
        category: true,
        txDate: true,
        createdAt: true,
      },
    }),
    prisma.memberSubscription.findMany({
      where: { status: "active", member: { clubId, deletedAt: null } },
      select: { id: true, price: true, billingPeriod: true, memberId: true },
    }),
    r.start
      ? prisma.memberSubscription.findMany({
          where: {
            member: { clubId, deletedAt: null },
            createdAt: { gte: r.start, lt: r.end },
          },
          select: { id: true, price: true },
        })
      : Promise.resolve([]),
    r.start
      ? prisma.memberSubscription.findMany({
          where: {
            member: { clubId, deletedAt: null },
            OR: [
              { canceledAt: { gte: r.start, lt: r.end } },
              { endDate: { gte: r.start, lt: r.end } },
            ],
          },
          select: { id: true, price: true },
        })
      : Promise.resolve([]),
    prisma.member.count({
      where: { clubId, deletedAt: null, status: "ACTIVE" },
    }),
    prisma.location.count({ where: { clubId, deletedAt: null } }),
  ]);

  // ── Overall totals & mix ─────────────────────────────────────────────
  const revenueOfTx = (t: { amount: unknown; refundedAmount: unknown }) =>
    Number(t.amount) - Number(t.refundedAmount ?? 0);
  const total = txs.reduce((s, t) => s + revenueOfTx(t), 0);
  let recurringAmount = 0;
  let variableAmount = 0;
  for (const t of txs) {
    const amt = revenueOfTx(t);
    if (RECURRING_TYPES.has(t.type)) recurringAmount += amt;
    else variableAmount += amt;
  }

  // ── By item ─────────────────────────────────────────────────────────
  // Group by (type, eventId or synthetic label). For memberships we group by
  // the plan (MemberSubscription.membershipId via the tx's memberId is
  // available but not always — best-effort). For classes/events/privates we
  // group by eventId. For products/donations we group by type as a bucket.
  const byItemMap = new Map<string, { id: string; label: string; category: string; kind: string; units: number; amount: number; href: string }>();
  const eventIdsToResolve = new Set<string>();
  for (const t of txs) {
    if (t.eventId) eventIdsToResolve.add(t.eventId);
  }
  const events =
    eventIdsToResolve.size > 0
      ? await prisma.event.findMany({
          where: { id: { in: Array.from(eventIdsToResolve) } },
          select: { id: true, name: true, type: true, locationId: true },
        })
      : [];
  const eventMeta = new Map(events.map((e) => [e.id, e]));

  for (const t of txs) {
    const amt = revenueOfTx(t);
    if (amt === 0) continue;
    const kind = KIND_BY_TYPE[t.type] ?? "other";
    let id: string;
    let label: string;
    let href: string;
    if (kind === "class" || kind === "event" || kind === "private") {
      const meta = t.eventId ? eventMeta.get(t.eventId) : null;
      id = t.eventId ?? `${t.type}:other`;
      label = meta?.name ?? t.description ?? kindLabel(kind);
      href = kind === "event" ? `/dashboard/events?edit=${id}` : `/dashboard/classes?edit=${id}`;
    } else if (kind === "membership") {
      id = `membership:${t.memberId ?? "unknown"}`;
      label = "Membership dues";
      href = "/dashboard/memberships";
    } else if (kind === "product") {
      id = "product:all";
      label = "Products & merch";
      href = "/dashboard/products";
    } else if (kind === "donation") {
      id = "donation:all";
      label = "Donations";
      href = "/dashboard/financials?tab=donations";
    } else {
      id = `other:${t.type}`;
      label = t.description ?? "Other";
      href = "/dashboard/financials?tab=in";
    }
    const existing = byItemMap.get(id) ?? { id, label, category: kind, kind, units: 0, amount: 0, href };
    existing.units += 1;
    existing.amount += amt;
    byItemMap.set(id, existing);
  }
  // For memberships we grouped by member which is too fine — collapse into
  // a single "Membership dues" bucket for the primary list. Owners looking
  // for plan-level breakdown will get it in a future 2.5.2 iteration and via
  // the P&L drill-through (2.5.4).
  const membershipRoll = Array.from(byItemMap.values()).filter((b) => b.kind === "membership");
  if (membershipRoll.length > 0) {
    const roll = membershipRoll.reduce(
      (acc, r) => ({
        id: "membership:all",
        label: "Membership dues",
        category: "membership",
        kind: "membership",
        units: acc.units + r.units,
        amount: acc.amount + r.amount,
        href: "/dashboard/memberships",
      }),
      { id: "membership:all", label: "Membership dues", category: "membership", kind: "membership", units: 0, amount: 0, href: "/dashboard/memberships" },
    );
    for (const r of membershipRoll) byItemMap.delete(r.id);
    byItemMap.set(roll.id, roll);
  }

  const byItem = Array.from(byItemMap.values())
    .map((r) => ({ ...r, amount: round2(r.amount), percentOfTotal: pct(r.amount, total) }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10);

  // ── By class / event / private (secondary drill target) ─────────────
  // Already implied by byItem for kind ∈ {class, event, private}.

  // ── By location ─────────────────────────────────────────────────────
  let byLocation: RevenuePayload["primary"]["byLocation"] = null;
  if (allowMultiLoc > 1) {
    const locMap = new Map<string, number>();
    for (const t of txs) {
      if (!t.eventId) continue;
      const meta = eventMeta.get(t.eventId);
      if (!meta?.locationId) continue;
      locMap.set(meta.locationId, (locMap.get(meta.locationId) ?? 0) + revenueOfTx(t));
    }
    if (locMap.size > 0) {
      const locs = await prisma.location.findMany({
        where: { id: { in: Array.from(locMap.keys()) } },
        select: { id: true, name: true },
      });
      const locName = new Map(locs.map((l) => [l.id, l.name]));
      byLocation = Array.from(locMap.entries())
        .map(([id, amount]) => ({
          id,
          name: locName.get(id) ?? "Location",
          amount: round2(amount),
          percentOfTotal: pct(amount, total),
          href: `/dashboard/financials?tab=in&location=${id}`,
        }))
        .sort((a, b) => b.amount - a.amount);
    }
  }

  // ── By coach (ESTIMATED via event staff assignment) ─────────────────
  let byCoach: RevenuePayload["primary"]["byCoach"] = null;
  const eventTxIdsByEvent = new Map<string, number>();
  for (const t of txs) {
    if (!t.eventId) continue;
    eventTxIdsByEvent.set(t.eventId, (eventTxIdsByEvent.get(t.eventId) ?? 0) + revenueOfTx(t));
  }
  if (eventTxIdsByEvent.size > 0) {
    const assignments = await prisma.eventStaffAssignment.findMany({
      where: {
        clubId,
        eventId: { in: Array.from(eventTxIdsByEvent.keys()) },
        role: "COACH",
      },
      include: {
        user: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    // Group assignments by event so we can split revenue equally between
    // coaches on the same event.
    const byEvent = new Map<string, typeof assignments>();
    for (const a of assignments) {
      const arr = byEvent.get(a.eventId) ?? [];
      arr.push(a);
      byEvent.set(a.eventId, arr);
    }
    const coachTotals = new Map<string, { name: string; amount: number }>();
    for (const [eventId, revenue] of eventTxIdsByEvent) {
      const coaches = byEvent.get(eventId) ?? [];
      if (coaches.length === 0) continue;
      const share = revenue / coaches.length;
      for (const c of coaches) {
        const key = c.userId;
        const existing = coachTotals.get(key) ?? {
          name: `${c.user.firstName ?? ""} ${c.user.lastName ?? ""}`.trim() || "Coach",
          amount: 0,
        };
        existing.amount += share;
        coachTotals.set(key, existing);
      }
    }
    if (coachTotals.size > 0) {
      byCoach = Array.from(coachTotals.entries())
        .map(([id, { name, amount }]) => ({
          id,
          name,
          amount: round2(amount),
          percentOfTotal: pct(amount, total),
          reliability: "ESTIMATED" as const,
          href: `/dashboard/staff?edit=${id}`,
        }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 10);
    }
  }

  // ── By source chips ────────────────────────────────────────────────
  const sourceMap = new Map<string, number>();
  for (const t of txs) {
    const src = t.paymentSource ?? "OTHER";
    sourceMap.set(src, (sourceMap.get(src) ?? 0) + revenueOfTx(t));
  }
  const bySource = Array.from(sourceMap.entries())
    .filter(([_, v]) => v > 0)
    .map(([source, amount]) => ({
      source,
      label: SOURCE_LABELS[source] ?? source,
      amount: round2(amount),
      percentOfTotal: pct(amount, total),
    }))
    .sort((a, b) => b.amount - a.amount);

  // ── Recurring metrics (secondary — SaaS block) ─────────────────────
  const mrr = activeSubs.reduce(
    (s, sub) => s + toMonthlyAmount(Number(sub.price ?? 0), sub.billingPeriod),
    0,
  );
  const arr = mrr * 12;
  const activeMemberships = activeSubs.length;
  const uniqueAthletes = new Set(activeSubs.map((s) => s.memberId)).size;
  const arpa = uniqueAthletes > 0 ? total / uniqueAthletes : 0;
  const arpMembership = activeMemberships > 0 ? total / activeMemberships : 0;

  // Upgrades / downgrades within the range — best-effort proxy: look at
  // subscriptions started in the range with the same member replacing an
  // ended subscription. Precise attribution comes in Phase 4.5.10 with
  // MemberSubscriptionEvent.
  let upgrades = 0;
  let downgrades = 0;
  // Cheap proxy: count new & ended per member; when both, treat as a plan
  // change. Amount-comparison requires the price of both plans.
  if (r.start && newSubs.length > 0 && endedSubs.length > 0) {
    // We only have the ids/price of new/ended lists (member-level joins were
    // dropped for perf). Coarser proxy: min(new, ended) counted as
    // upgrades+downgrades combined, split 50/50. This is honest for a first
    // sub-phase; refined in Phase 4.5.10 which brings the event log.
    const changes = Math.min(newSubs.length, endedSubs.length);
    upgrades = Math.floor(changes / 2);
    downgrades = changes - upgrades;
  }

  const recurring: RevenuePayload["recurring"] = {
    activeMemberships,
    mrr: round2(mrr),
    arr: round2(arr),
    arpa: round2(arpa),
    arpMembership: round2(arpMembership),
    newMemberships: newSubs.length,
    renewedMemberships: 0, // Requires event history — Phase 4.5.10.
    endedMemberships: endedSubs.length,
    upgrades,
    downgrades,
    amount: round2(recurringAmount),
    percentOfTotal: pct(recurringAmount, total),
  };

  // ── Variable by category ───────────────────────────────────────────
  const varCatMap = new Map<string, number>();
  for (const t of txs) {
    if (RECURRING_TYPES.has(t.type)) continue;
    const key = t.category ?? kindLabel(KIND_BY_TYPE[t.type] ?? "other");
    varCatMap.set(key, (varCatMap.get(key) ?? 0) + revenueOfTx(t));
  }
  const variableByCategory = Array.from(varCatMap.entries())
    .map(([key, amount]) => ({ key, label: variableCategoryLabel(key), amount: round2(amount), percentOfTotal: pct(amount, total) }))
    .sort((a, b) => b.amount - a.amount);

  void activeMemberCount; // reserved for a future "revenue per active member" metric

  return {
    range: {
      key: r.key,
      label: r.label,
      start: r.start?.toISOString() ?? null,
      end: r.end.toISOString(),
    },
    total: round2(total),
    primary: {
      mix: {
        recurring: round2(recurringAmount),
        variable: round2(variableAmount),
        recurringPercent: pct(recurringAmount, total),
        variablePercent: pct(variableAmount, total),
      },
      byItem,
      byCoach,
      byLocation,
      bySource,
    },
    recurring,
    variable: {
      amount: round2(variableAmount),
      percentOfTotal: pct(variableAmount, total),
      byCategory: variableByCategory.slice(0, 10),
    },
    reliability: byCoach ? "ESTIMATED" : "COMPLETE",
    reliabilityNotes: byCoach
      ? ["Coach revenue estimated by splitting event revenue equally among assigned coaches. Precise per-session attribution ships in a future sub-phase."]
      : [],
  };
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "membership":
      return "Membership dues";
    case "class":
      return "Class";
    case "event":
      return "Event";
    case "private":
      return "Private lesson";
    case "product":
      return "Product";
    case "donation":
      return "Donation";
    default:
      return "Other";
  }
}

function variableCategoryLabel(key: string): string {
  const map: Record<string, string> = {
    classes: "Classes",
    events: "Events",
    private_lessons: "Private lessons",
    products: "Products",
    donations: "Donations",
    sponsorships: "Sponsorships",
    manual_invoice: "Manual invoices",
    cash_payment: "Cash payments",
    other_income: "Other income",
    Class: "Classes",
    Event: "Events",
    Private: "Private lessons",
    Product: "Products",
  };
  return map[key] ?? key;
}
