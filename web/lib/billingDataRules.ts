/**
 * Pure rules behind four billing-data questions that kept getting answered two
 * different ways (2026-09-28). Nothing here imports Prisma or Stripe — every
 * function takes a plain shape, so scripts/billing-data-tests.ts can pin the
 * rules without a database and the scripts under scripts/ can reuse them.
 *
 *   1. Who is an "active member"?            → summarizeActiveMembers
 *   2. What does activation do to status?    → nextStatusOnActivation / nextMemberStatus
 *   3. Is this cash purchase a duplicate?    → findPlanConflict / findDuplicateCashSubscriptions
 *   4. How does this person pay?             → paymentMethodLabel / isOffSessionChargeable
 */

// ═══════════════════════════════════════════════════════════════════════════
// 1. Active members — counted from subscriptions, never from Member.status
// ═══════════════════════════════════════════════════════════════════════════
//
// Measured 2026-09-28: the dashboard said 42 "Active members" (Member.status =
// ACTIVE) while 49 members held 53 live subscriptions. Seven online signups
// from Sep 21–27 held a live Stripe subscription and still read PROSPECT.
// Member.status is a LIFECYCLE label (prospect → member → lapsed) with its own
// money-proof rule (lib/memberStatus.ts); "how many members does the club
// have" is a question about subscriptions, answered here.
//
// `pending` is deliberately NOT live: a pending row is an unfinished checkout
// that nothing deletes when the family abandons the page (Maximus Alexander,
// two pending rows 43 s apart). `trialing` is listed defensively — the local
// vocabulary maps Stripe trialing → "active" (lib/stripeSync.localStatusFor),
// so no row should carry it, but one that does is still live.
export const LIVE_SUBSCRIPTION_STATUSES = ["active", "past_due", "trialing"] as const;

const LIVE_SET = new Set<string>(LIVE_SUBSCRIPTION_STATUSES);

export function isLiveSubscriptionStatus(status: string | null | undefined): boolean {
  return !!status && LIVE_SET.has(status);
}

export type ActiveMemberSummary = {
  /** Distinct members holding at least one live subscription. */
  activeMembers: number;
  /** Live subscriptions (one member can hold two — a sibling plan, a second program). */
  memberships: number;
};

export function summarizeActiveMembers(
  rows: { memberId: string; status: string }[],
): ActiveMemberSummary {
  const live = rows.filter((r) => isLiveSubscriptionStatus(r.status));
  return { activeMembers: new Set(live.map((r) => r.memberId)).size, memberships: live.length };
}

/** "49 active members · 53 memberships" — the second half only when it adds information. */
export function activeMembersLine(s: ActiveMemberSummary): string {
  const m = `${s.activeMembers} active member${s.activeMembers === 1 ? "" : "s"}`;
  if (s.memberships === s.activeMembers) return m;
  return `${m} · ${s.memberships} membership${s.memberships === 1 ? "" : "s"}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Member.status transitions
// ═══════════════════════════════════════════════════════════════════════════

export type MemberLifecycleStatus = "ACTIVE" | "PROSPECT" | "INACTIVE" | "PAUSED";

/**
 * The one activation transition. A membership was just granted: a prospect or
 * a lapsed member becomes ACTIVE. ACTIVE stays ACTIVE (null = no write), and
 * PAUSED is owner-controlled and is never overridden — the direct
 * `status: "ACTIVE"` writes this replaces would un-pause a paused member.
 */
export function nextStatusOnActivation(current: string): "ACTIVE" | null {
  return current === "PROSPECT" || current === "INACTIVE" ? "ACTIVE" : null;
}

/**
 * The recompute rule (owner-confirmed 2026-07-13), extracted from
 * recomputeMemberStatus so it can be tested:
 *   - holds a membership (countsAsMembership)  → ACTIVE
 *   - held one, it ended (was ACTIVE)          → INACTIVE
 *   - PROSPECT with nothing                    → stays PROSPECT
 *   - PAUSED                                   → untouched
 * Returns null when nothing should be written.
 */
export function nextMemberStatus(current: string, holdsMembership: boolean): "ACTIVE" | "INACTIVE" | null {
  if (current === "PAUSED") return null;
  if (holdsMembership) return current === "ACTIVE" ? null : "ACTIVE";
  return current === "ACTIVE" ? "INACTIVE" : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Duplicate memberships on the same plan
// ═══════════════════════════════════════════════════════════════════════════
//
// 2026-09-23: staff approved three pending in-portal CASH purchase requests
// (within 4 s) for kids whose families had meanwhile paid for the same plan by
// card. Each ended up with an active Stripe subscription AND an active MANUAL
// subscription on the same membership — two memberships, one of them billed
// as an unpaid cash invoice.

export type PlanSub = {
  id: string;
  memberId: string;
  membershipId: string;
  status: string;
  billingType: string;
  stripeSubscriptionId: string | null;
  startedAt?: Date | string | null;
  startDate?: Date | string | null;
  createdAt?: Date | string | null;
};

export type PlanConflict = {
  subscriptionId: string;
  paidBy: "card" | "cash" | "other";
  since: Date | null;
};

function toDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The member's live subscription on this plan, if they already hold one. Card-billed wins when there are two. */
export function findPlanConflict(subs: PlanSub[], membershipId: string): PlanConflict | null {
  const onPlan = subs.filter((s) => s.membershipId === membershipId && isLiveSubscriptionStatus(s.status));
  if (onPlan.length === 0) return null;
  const pick = onPlan.find((s) => !!s.stripeSubscriptionId) ?? onPlan[0];
  return {
    subscriptionId: pick.id,
    paidBy: pick.stripeSubscriptionId ? "card" : pick.billingType === "MANUAL" ? "cash" : "other",
    since: toDate(pick.startedAt) ?? toDate(pick.startDate) ?? toDate(pick.createdAt),
  };
}

export function shortDate(d: Date | null, timeZone?: string | null): string | null {
  if (!d) return null;
  try {
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: timeZone || "UTC" });
  } catch {
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  }
}

/** "paid by card Sep 21" / "paid in cash Sep 3" / "active since Sep 3" */
export function conflictPhrase(c: PlanConflict, timeZone?: string | null): string {
  const when = shortDate(c.since, timeZone);
  const how = c.paidBy === "card" ? "paid by card" : c.paidBy === "cash" ? "paid in cash" : "active";
  return when ? `${how}${c.paidBy === "other" ? " since" : ""} ${when}` : how;
}

/** Queue label: "Already has this membership (paid by card Sep 21) — decline or keep" */
export function conflictQueueLabel(c: PlanConflict, timeZone?: string | null): string {
  return `Already has this membership (${conflictPhrase(c, timeZone)}) — decline or keep`;
}

/** The refusal an approve route returns. */
export function conflictRefusal(memberName: string, planName: string, c: PlanConflict, timeZone?: string | null): string {
  return (
    `${memberName} already has ${planName} (${conflictPhrase(c, timeZone)}). Approving would start a second ` +
    `membership on the same plan and record a cash invoice they don't owe. Decline this request — or, if the ` +
    `family really means to switch to cash, cancel the existing membership first and then approve.`
  );
}

export type DuplicatePair = { manual: PlanSub; card: PlanSub };

/**
 * Active MANUAL rows with no Stripe id where the SAME member holds another live
 * subscription WITH a Stripe id on the SAME membership. The MANUAL row is the
 * duplicate. A row carrying a stripeSubscriptionId is never returned as the
 * duplicate — the card membership is the one Stripe is billing.
 */
export function findDuplicateCashSubscriptions(subs: PlanSub[]): DuplicatePair[] {
  const out: DuplicatePair[] = [];
  for (const m of subs) {
    if (m.billingType !== "MANUAL" || m.stripeSubscriptionId || m.status !== "active") continue;
    const card = subs.find(
      (s) =>
        s.id !== m.id &&
        s.memberId === m.memberId &&
        s.membershipId === m.membershipId &&
        !!s.stripeSubscriptionId &&
        isLiveSubscriptionStatus(s.status),
    );
    if (card) out.push({ manual: m, card });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Payment methods — every type, with a human label
// ═══════════════════════════════════════════════════════════════════════════
//
// Every paymentMethods.list call asked for type "card" (sometimes "link"), so a
// family paying with Cash App Pay (Blake D.) read "No saved payment method"
// while Stripe billed them every month.

/** Minimal shape of a Stripe PaymentMethod OR a Charge's payment_method_details. */
export type PaymentMethodLike = {
  type: string;
  card?: { brand?: string | null; last4?: string | null; exp_month?: number | null; exp_year?: number | null; wallet?: { type?: string | null } | null } | null;
  cashapp?: { cashtag?: string | null } | null;
  link?: { email?: string | null } | null;
  us_bank_account?: { bank_name?: string | null; last4?: string | null } | null;
  paypal?: { payer_email?: string | null } | null;
  billing_details?: { email?: string | null } | null;
};

function titleCase(s: string): string {
  return s
    .split(/[_\s]+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

const BRAND_NAMES: Record<string, string> = {
  amex: "American Express",
  american_express: "American Express",
  diners: "Diners Club",
  mastercard: "Mastercard",
  unionpay: "UnionPay",
  jcb: "JCB",
};

export function cardBrandName(brand: string | null | undefined): string {
  if (!brand) return "Card";
  return BRAND_NAMES[brand.toLowerCase()] ?? titleCase(brand);
}

const TYPE_NAMES: Record<string, string> = {
  card: "Card",
  cashapp: "Cash App Pay",
  link: "Link",
  us_bank_account: "Bank account",
  paypal: "PayPal",
  amazon_pay: "Amazon Pay",
  apple_pay: "Apple Pay",
  google_pay: "Google Pay",
};

export function paymentTypeName(type: string): string {
  return TYPE_NAMES[type] ?? titleCase(type);
}

/**
 *   card            "Visa •••• 4242 · exp 08/27"
 *   cashapp         "Cash App Pay ($jenny)"      / "Cash App Pay"
 *   link            "Link (pat@example.com)"     / "Link"
 *   us_bank_account "Bank account •••• 6789"
 *   paypal          "PayPal (pat@example.com)"
 *   anything else   its Stripe type, title-cased ("Amazon Pay", "Klarna")
 */
export function paymentMethodLabel(pm: PaymentMethodLike): string {
  switch (pm.type) {
    case "card": {
      const c = pm.card ?? {};
      const brand = cardBrandName(c.brand);
      const last4 = c.last4 ? ` •••• ${c.last4}` : "";
      const exp =
        c.exp_month && c.exp_year
          ? ` · exp ${String(c.exp_month).padStart(2, "0")}/${String(c.exp_year).slice(-2)}`
          : "";
      const wallet = c.wallet?.type ? ` (${paymentTypeName(c.wallet.type)})` : "";
      return `${brand}${last4}${exp}${wallet}`;
    }
    case "cashapp": {
      const tag = pm.cashapp?.cashtag?.trim();
      return tag ? `Cash App Pay (${tag.startsWith("$") ? tag : `$${tag}`})` : "Cash App Pay";
    }
    case "link": {
      const email = pm.link?.email ?? pm.billing_details?.email ?? null;
      return email ? `Link (${email})` : "Link";
    }
    case "us_bank_account": {
      const last4 = pm.us_bank_account?.last4;
      return last4 ? `Bank account •••• ${last4}` : "Bank account";
    }
    case "paypal": {
      const email = pm.paypal?.payer_email ?? null;
      return email ? `PayPal (${email})` : "PayPal";
    }
    default:
      return paymentTypeName(pm.type);
  }
}

/**
 * Types this app will pick BY ITSELF for an off-session charge (activate_card,
 * autopay, "charge saved card"). Cash App Pay is excluded: Stripe can bill a
 * Cash App Pay mandate that a subscription Checkout set up, but the pinned SDK
 * exposes no reusability flag on the PaymentMethod, so the app never chooses
 * one on its own — it is shown, not auto-charged. A stored pointer the owner
 * captured explicitly (stripeSetupPaymentMethodId) is still honoured as before.
 */
export const OFF_SESSION_TYPES = new Set(["card", "link", "us_bank_account"]);

export function isOffSessionChargeable(pm: { type: string }): boolean {
  return OFF_SESSION_TYPES.has(pm.type);
}

export type LastPaidWith = {
  type: string;
  label: string;
  /** When that charge succeeded (ISO). Named `at` — components/members/PaymentMethodsCard reads it. */
  at: string | null;
  amount: number | null;
};

/** From a list of Stripe charges (newest first), the latest succeeded one → how they paid. */
export function lastPaidWithFromCharges(
  charges: {
    status?: string | null;
    paid?: boolean | null;
    refunded?: boolean | null;
    created?: number | null;
    amount?: number | null;
    payment_method_details?: PaymentMethodLike | null;
  }[],
): LastPaidWith | null {
  const sorted = [...charges].sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  const ok = sorted.find((c) => c.status === "succeeded" && c.payment_method_details?.type);
  if (!ok || !ok.payment_method_details) return null;
  return {
    type: ok.payment_method_details.type,
    label: paymentMethodLabel(ok.payment_method_details),
    at: ok.created ? new Date(ok.created * 1000).toISOString() : null,
    amount: ok.amount != null ? ok.amount / 100 : null,
  };
}
