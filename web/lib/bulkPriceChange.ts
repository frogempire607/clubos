// Bulk price change — the ONE model for "who is actually on this option, what
// do they pay today, and what would change".
//
// PURE. No prisma, no Stripe, no Date.now() beyond an injected `now`. The
// preview route, the modal, and (later) apply all resolve through here so the
// screen and the write can never disagree about who was in scope.
//
// ── Why matching by optionLabel is wrong ────────────────────────────────────
//
// The spec assumes `member_subscriptions.optionLabel` holds the option's label
// ("Monthly"). It does not, reliably. The migration/approve path writes
// `optionLabel: planName`, so production carries rows labeled "Jr Frogs",
// "MS/HS" and "Girls Jr Frogs" alongside rows labeled "Monthly" / "Upfront" /
// "1 Year" — on the same plan, at the same price, in the same billing period.
// Verified against production 2026-08-11: of 8 live MS/HS monthly-billed rows,
// 5 are labeled "Monthly" and 3 "MS/HS". Selecting on the label would silently
// skip whoever the label drifted on, and a bulk price tool that silently
// misses members is worse than no tool.
//
// So the selector is (membershipId, billingPeriod) — the two fields that
// actually describe which option a subscription is billed under. The stored
// label is reported per row as `optionLabel` + `labelMatchesOption` so the
// owner can SEE the drift rather than be protected from it.
//
// ── Why `onListPrice` matters ───────────────────────────────────────────────
//
// A member whose price already differs from the option's old price is carrying
// a deliberate override (a discount, a legacy rate, a negotiated figure). They
// are in scope — the owner may still want to move them — but they are NEVER
// pre-selected, because "everyone on the sticker price" and "everyone on this
// plan" are different questions and only the first is safe to default to.

export type MembershipOption = {
  label: string;
  price: number;
  billingPeriod: string;
};

/** `memberships.options` is stored as a JSON *string*, not a JSON object. */
export function parseMembershipOptions(raw: unknown): MembershipOption[] {
  let value: unknown = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value || "[]");
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const out: MembershipOption[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    const label = typeof o.label === "string" ? o.label : null;
    const billingPeriod = typeof o.billingPeriod === "string" ? o.billingPeriod : null;
    const price = Number(o.price);
    if (!label || !billingPeriod || !Number.isFinite(price)) continue;
    out.push({ label, price, billingPeriod });
  }
  return out;
}

// Periods that bill a lump sum covering a stretch of future time. A price
// change on one of these leaves money already collected against time that is
// now priced differently — that is the credit/additional-due question.
const UPFRONT_PERIODS = new Set(["QUARTERLY", "QUADRIMESTRAL", "SEMI_ANNUAL", "ANNUAL", "ONE_TIME"]);

export function isUpfrontPeriod(period: string | null | undefined): boolean {
  return !!period && UPFRONT_PERIODS.has(period);
}

const DAY_MS = 86_400_000;

/** Inverse of lib/billingAdmin.addBillingPeriod — the start of the period that ends at `end`. */
export function periodStartFor(end: Date, period: string): Date {
  const d = new Date(end);
  switch (period) {
    case "WEEKLY": d.setDate(d.getDate() - 7); break;
    case "MONTHLY": d.setMonth(d.getMonth() - 1); break;
    case "QUARTERLY": d.setMonth(d.getMonth() - 3); break;
    case "QUADRIMESTRAL": d.setMonth(d.getMonth() - 4); break;
    case "SEMI_ANNUAL": d.setMonth(d.getMonth() - 6); break;
    case "ANNUAL": d.setFullYear(d.getFullYear() - 1); break;
    default: d.setFullYear(d.getFullYear() - 1); break;
  }
  return d;
}

export type CreditBasis =
  | "currentPeriodEnd"
  | "endDate"
  | "billingAnchorDate"
  | "none";

export type CreditKind =
  | "CREDIT_OWED"
  | "ADDITIONAL_DUE"
  | "NOT_APPLICABLE"
  | "NO_CHANGE"
  | "UNKNOWN";

export type CreditResult = {
  kind: CreditKind;
  /** Always positive when present. `kind` carries the direction. Null = we don't know. */
  amount: number | null;
  basis: CreditBasis;
  periodEnd: string | null;
  daysRemaining: number | null;
  daysInPeriod: number | null;
  note: string;
};

export type PricedSubscription = {
  id: string;
  memberId: string;
  optionLabel: string;
  price: unknown; // Prisma Decimal | string | number
  billingPeriod: string | null;
  billingType: string;
  status: string;
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  stripeStatus: string | null;
  currentPeriodEnd: Date | null;
  endDate: Date | null;
  billingAnchorDate: Date | null;
  startDate: Date | null;
  effectiveStartDate: Date | null;
  autoRenew: boolean;
  discountCode: string | null;
  discountAmount: unknown;
};

const money = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * The unused-time credit (or additional amount due) on an already-paid upfront
 * period.
 *
 * Returns `UNKNOWN` rather than a number whenever the period end cannot be
 * established from stored data. This is the common case, not the edge case:
 * `currentPeriodEnd` is written ONLY by the Stripe reconciler
 * (lib/stripeSync.ts), so every offline subscription has it null, and
 * `endDate` is null on open-ended manual rows. A fabricated credit figure is a
 * number the owner would act on with real money — it has to be absent when we
 * cannot stand behind it.
 */
export function computeCredit(
  sub: PricedSubscription,
  oldPrice: number,
  newPrice: number,
  now: Date,
): CreditResult {
  const none = (kind: CreditKind, note: string): CreditResult => ({
    kind, amount: null, basis: "none", periodEnd: null, daysRemaining: null, daysInPeriod: null, note,
  });

  if (!isUpfrontPeriod(sub.billingPeriod)) {
    return none("NOT_APPLICABLE", "Billed per period — the next bill simply uses the new price.");
  }
  if (oldPrice === newPrice) return none("NO_CHANGE", "Price is unchanged.");

  // Basis precedence: Stripe-reconciled fact → explicit stored end → the
  // resolved billing anchor. Anything already in the past tells us nothing
  // about time remaining.
  let periodEnd: Date | null = null;
  let basis: CreditBasis = "none";
  for (const [candidate, name] of [
    [sub.currentPeriodEnd, "currentPeriodEnd"],
    [sub.endDate, "endDate"],
    [sub.billingAnchorDate, "billingAnchorDate"],
  ] as Array<[Date | null, CreditBasis]>) {
    if (candidate && candidate.getTime() > now.getTime()) {
      periodEnd = candidate;
      basis = name;
      break;
    }
  }

  if (!periodEnd) {
    return none(
      "UNKNOWN",
      "No future period end is stored on this subscription (currentPeriodEnd, endDate and billingAnchorDate are all empty or already past), so unused time cannot be computed. Settle this one by hand.",
    );
  }

  const periodStart = periodStartFor(periodEnd, sub.billingPeriod!);
  const daysInPeriod = Math.round((periodEnd.getTime() - periodStart.getTime()) / DAY_MS);
  const daysRemaining = Math.max(0, Math.round((periodEnd.getTime() - now.getTime()) / DAY_MS));
  if (daysInPeriod <= 0) {
    return none("UNKNOWN", "The stored period is zero-length — unused time cannot be computed.");
  }

  const fraction = Math.min(1, daysRemaining / daysInPeriod);
  const delta = oldPrice - newPrice;
  const amount = money(Math.abs(delta) * fraction);

  return {
    kind: delta > 0 ? "CREDIT_OWED" : "ADDITIONAL_DUE",
    amount,
    basis,
    periodEnd: periodEnd.toISOString(),
    daysRemaining,
    daysInPeriod,
    note:
      delta > 0
        ? `${daysRemaining} of ${daysInPeriod} days unused at the old price.`
        : `${daysRemaining} of ${daysInPeriod} days remaining, now priced higher.`,
  };
}

export type PriceChangeRow = {
  memberSubscriptionId: string;
  memberId: string;
  memberName: string;
  /** The label stored on the subscription — often the PLAN name, not the option label. */
  optionLabel: string;
  labelMatchesOption: boolean;
  billingPeriod: string | null;
  billingType: string;
  status: string;
  channel: "stripe" | "offline";
  currentPrice: number;
  newPrice: number;
  /** newPrice - currentPrice. Negative = this member pays less. */
  delta: number;
  /** True when this member is on the option's old sticker price. */
  onListPrice: boolean;
  upfront: boolean;
  /** Pre-ticked in the modal. Only on-list-price rows whose price actually moves. */
  defaultSelected: boolean;
  credit: CreditResult;
  stripe: {
    subscriptionId: string;
    priceId: string | null;
    stripeStatus: string | null;
    currentPeriodEnd: string | null;
  } | null;
  discountCode: string | null;
  warnings: string[];
};

export type PriceChangeSummary = {
  total: number;
  stripeCount: number;
  offlineCount: number;
  onListPriceCount: number;
  overrideCount: number;
  upfrontCount: number;
  defaultSelectedCount: number;
  totalCreditOwed: number;
  totalAdditionalDue: number;
  unknownCreditCount: number;
  /** Change in recurring revenue per period across the default-selected rows. */
  defaultSelectedDelta: number;
};

export type PriceChangePlan = {
  membership: { id: string; name: string };
  option: { label: string; billingPeriod: string; oldPrice: number; newPrice: number };
  direction: "increase" | "decrease" | "none";
  rows: PriceChangeRow[];
  summary: PriceChangeSummary;
  notes: string[];
};

/** Subscription statuses that are still live enough to be worth repricing. */
export const REPRICEABLE_STATUSES = ["active", "pending", "past_due"] as const;

export function planPriceChange(input: {
  membership: { id: string; name: string };
  option: MembershipOption;
  newPrice: number;
  subs: Array<PricedSubscription & { member: { id: string; firstName: string | null; lastName: string | null } }>;
  now: Date;
}): PriceChangePlan {
  const { membership, option, newPrice, subs, now } = input;
  const oldPrice = money(option.price);
  const target = money(newPrice);
  const direction = target > oldPrice ? "increase" : target < oldPrice ? "decrease" : "none";

  const rows: PriceChangeRow[] = subs.map((s) => {
    const currentPrice = money(num(s.price));
    const isStripe = !!s.stripeSubscriptionId;
    const onListPrice = currentPrice === oldPrice;
    const upfront = isUpfrontPeriod(s.billingPeriod);
    const credit = computeCredit(s, currentPrice, target, now);
    const warnings: string[] = [];

    if (!onListPrice) {
      warnings.push(
        `Pays $${currentPrice.toFixed(2)}, not the plan's $${oldPrice.toFixed(2)} — this is a per-member override.`,
      );
    }
    if (s.optionLabel !== option.label) {
      warnings.push(`Stored option label is "${s.optionLabel}", not "${option.label}".`);
    }
    if (isStripe && !s.stripePriceId) {
      warnings.push("No Stripe price id recorded — the Stripe item will need to be resolved live at apply time.");
    }
    if (isStripe && s.stripeStatus && s.stripeStatus !== "active" && s.stripeStatus !== "trialing") {
      warnings.push(`Stripe reports this subscription as "${s.stripeStatus}".`);
    }
    if (credit.kind === "UNKNOWN") {
      warnings.push("Unused-time credit cannot be computed — no usable period end is stored.");
    }
    if (s.discountCode) {
      warnings.push(`Carries discount "${s.discountCode}" — the new price is before that discount.`);
    }
    if (currentPrice === target) {
      warnings.push("Already at the new price — nothing would change.");
    }

    const name = [s.member.firstName, s.member.lastName].filter(Boolean).join(" ").trim();

    return {
      memberSubscriptionId: s.id,
      memberId: s.memberId,
      memberName: name || "(no name)",
      optionLabel: s.optionLabel,
      labelMatchesOption: s.optionLabel === option.label,
      billingPeriod: s.billingPeriod,
      billingType: s.billingType,
      status: s.status,
      channel: isStripe ? "stripe" : "offline",
      currentPrice,
      newPrice: target,
      delta: money(target - currentPrice),
      onListPrice,
      upfront,
      // Deliberately conservative: only members sitting on the old sticker
      // price, whose price actually moves, and who are NOT upfront-paid.
      // Upfront rows carry a money consequence the owner must tick per row.
      defaultSelected: onListPrice && currentPrice !== target && !upfront,
      credit,
      stripe: isStripe
        ? {
            subscriptionId: s.stripeSubscriptionId!,
            priceId: s.stripePriceId,
            stripeStatus: s.stripeStatus,
            currentPeriodEnd: s.currentPeriodEnd ? s.currentPeriodEnd.toISOString() : null,
          }
        : null,
      discountCode: s.discountCode,
      warnings,
    };
  });

  rows.sort((a, b) => {
    // Stripe monthly (the safe bulk) first, upfront offline last — the modal
    // reads top-to-bottom from "tick all of these" to "read each one".
    if (a.upfront !== b.upfront) return a.upfront ? 1 : -1;
    if (a.channel !== b.channel) return a.channel === "stripe" ? -1 : 1;
    return a.memberName.localeCompare(b.memberName);
  });

  const summary: PriceChangeSummary = {
    total: rows.length,
    stripeCount: rows.filter((r) => r.channel === "stripe").length,
    offlineCount: rows.filter((r) => r.channel === "offline").length,
    onListPriceCount: rows.filter((r) => r.onListPrice).length,
    overrideCount: rows.filter((r) => !r.onListPrice).length,
    upfrontCount: rows.filter((r) => r.upfront).length,
    defaultSelectedCount: rows.filter((r) => r.defaultSelected).length,
    totalCreditOwed: money(
      rows.filter((r) => r.credit.kind === "CREDIT_OWED").reduce((s, r) => s + (r.credit.amount ?? 0), 0),
    ),
    totalAdditionalDue: money(
      rows.filter((r) => r.credit.kind === "ADDITIONAL_DUE").reduce((s, r) => s + (r.credit.amount ?? 0), 0),
    ),
    unknownCreditCount: rows.filter((r) => r.credit.kind === "UNKNOWN").length,
    defaultSelectedDelta: money(rows.filter((r) => r.defaultSelected).reduce((s, r) => s + r.delta, 0)),
  };

  const notes: string[] = [];
  notes.push(
    `Members are matched on plan + billing period (${option.billingPeriod}), not on the stored option label — the label is unreliable on migrated rows.`,
  );
  if (summary.overrideCount > 0) {
    notes.push(
      `${summary.overrideCount} member${summary.overrideCount === 1 ? "" : "s"} already pay something other than $${oldPrice.toFixed(2)}. They are listed but never pre-selected.`,
    );
  }
  if (summary.unknownCreditCount > 0) {
    notes.push(
      `${summary.unknownCreditCount} upfront member${summary.unknownCreditCount === 1 ? "" : "s"} have no stored period end, so unused-time credit cannot be computed for them.`,
    );
  }
  if (rows.some((r) => !r.labelMatchesOption)) {
    notes.push(`Some rows store a different option label — shown per row so you can see the drift.`);
  }
  notes.push("This is a preview. Nothing has been written, charged, refunded, or emailed.");

  return {
    membership,
    option: { label: option.label, billingPeriod: option.billingPeriod, oldPrice, newPrice: target },
    direction,
    rows,
    summary,
    notes,
  };
}
