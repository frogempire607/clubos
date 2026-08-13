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

import { recurringUnitWithFee, feeBreakdown } from "@/lib/fees";
import type { EmailBlock } from "@/lib/emailBlocks";

export type MembershipOption = {
  label: string;
  price: number;
  billingPeriod: string;
};

/**
 * Which question the review screen is answering.
 *
 *   "proposed" — the owner is editing a price that is NOT saved yet. The plan
 *                still holds the OLD price, so members sitting on it are the
 *                safe bulk and get pre-ticked.
 *
 *   "current"  — the owner opened the review from the plan card or the edit
 *                screen with nothing pending. The target IS the plan's saved
 *                price, and the question is "who is not on it". Nobody is
 *                pre-ticked here: the previous sticker price was overwritten
 *                when the plan was saved, so there is no longer any way to
 *                tell "was on the old list price" apart from "has a
 *                deliberate override". Guessing between those is how you
 *                silently reprice someone's negotiated rate.
 */
export type PriceChangeMode = "proposed" | "current";

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

export type OptionResolution =
  | { ok: true; option: MembershipOption }
  | { ok: false; code: "NOT_FOUND"; candidates: MembershipOption[] }
  | { ok: false; code: "AMBIGUOUS_PERIOD"; candidates: MembershipOption[] };

/**
 * Resolve which option is being repriced.
 *
 * Matching subscribers happens on (membershipId, billingPeriod), so the period
 * has to identify exactly one option. Today no plan in the club has two options
 * sharing a period, but nothing stops an owner adding one — and at that point
 * the period no longer says which option a subscriber is on. There is no honest
 * tiebreak available: price is the field being changed, and members carrying an
 * override don't match their option's price anyway. So refuse and make the
 * owner choose, rather than pick one and reprice the wrong group.
 */
export function resolveOption(
  options: MembershipOption[],
  label: string,
  billingPeriod?: string | null,
): OptionResolution {
  const byLabel = options.filter(
    (o) => o.label === label && (billingPeriod ? o.billingPeriod === billingPeriod : true),
  );
  if (byLabel.length === 0) return { ok: false, code: "NOT_FOUND", candidates: options };

  const option = byLabel[0];
  const sharingPeriod = options.filter((o) => o.billingPeriod === option.billingPeriod);
  if (sharingPeriod.length > 1) {
    return { ok: false, code: "AMBIGUOUS_PERIOD", candidates: sharingPeriod };
  }
  return { ok: true, option };
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
  mode: PriceChangeMode;
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
  /** Omit (or pass null) to review against the plan's CURRENT saved price. */
  newPrice?: number | null;
  subs: Array<PricedSubscription & { member: { id: string; firstName: string | null; lastName: string | null } }>;
  now: Date;
}): PriceChangePlan {
  const { membership, option, subs, now } = input;
  const oldPrice = money(option.price);
  const mode: PriceChangeMode = input.newPrice == null ? "current" : "proposed";
  const target = mode === "current" ? oldPrice : money(input.newPrice as number);
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
        mode === "current"
          ? `Pays $${currentPrice.toFixed(2)}, not the plan's current $${oldPrice.toFixed(2)}.`
          : `Pays $${currentPrice.toFixed(2)}, not the plan's $${oldPrice.toFixed(2)} — this is a per-member override.`,
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
      //
      // In "current" mode nothing is pre-ticked at all — see PriceChangeMode.
      // The screen offers "select everyone not on this price" as an explicit
      // click instead, so the bulk is still one action but never a default.
      defaultSelected: mode === "proposed" && onListPrice && currentPrice !== target && !upfront,
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
    `Members are matched on plan + billing period (${option.billingPeriod}), not on the stored option label — renaming an option never changes who appears here.`,
  );
  if (mode === "current") {
    notes.push(
      `This compares every subscriber against the plan's current price of $${oldPrice.toFixed(2)}. Nobody is pre-selected — once a plan is saved there is no way to tell an out-of-date price apart from a deliberate override, so the choice is yours.`,
    );
  } else if (summary.overrideCount > 0) {
    notes.push(
      `${summary.overrideCount} member${summary.overrideCount === 1 ? "" : "s"} already pay something other than $${oldPrice.toFixed(2)}. They are listed but never pre-selected.`,
    );
  }
  if (summary.unknownCreditCount > 0) {
    notes.push(
      summary.unknownCreditCount === 1
        ? "1 upfront member has no stored period end, so unused-time credit cannot be computed for them."
        : `${summary.unknownCreditCount} upfront members have no stored period end, so unused-time credit cannot be computed for them.`,
    );
  }
  if (rows.some((r) => !r.labelMatchesOption)) {
    notes.push(`Some rows store a different option label — shown per row so you can see the drift.`);
  }
  notes.push("This is a preview. Nothing has been written, charged, refunded, or emailed.");

  return {
    membership,
    option: { label: option.label, billingPeriod: option.billingPeriod, oldPrice, newPrice: target },
    mode,
    direction,
    rows,
    summary,
    notes,
  };
}

// ── Apply-side rules ────────────────────────────────────────────────────────

/**
 * The `unit_amount` a Stripe subscription item must carry for `price` dollars.
 *
 * MUST match how the subscription was created, which passes the price through
 * `recurringUnitWithFee` — the club's 2.9% passthrough is baked into the Stripe
 * amount, not added at charge time. Frog Empire has `passProcessingFees: true`,
 * so a member on the $190 sticker is billed $195.51 by Stripe. Writing a bare
 * `price * 100` on a reprice would silently strip the passthrough off every
 * touched subscription and quietly cut the club's take on each one.
 */
export function stripeUnitAmountCents(price: number, passProcessingFees: boolean): number {
  return recurringUnitWithFee(Math.round(price * 100), passProcessingFees);
}

/**
 * The direction that matters for advance notice: what happens to the people
 * actually being changed, NOT what happened to the plan's list price.
 *
 * These differ. Reviewing against the plan's current price (see
 * PriceChangeMode "current") makes the plan-level direction "none" — the list
 * price isn't moving — while a $0 comp member being moved onto the $175 plan
 * price is unambiguously an increase for that family. Gating on the plan-level
 * direction would let that one through with no notice.
 */
export function directionForRows(
  rows: Array<{ currentPrice: number; newPrice: number }>,
): "increase" | "decrease" | "none" {
  if (rows.some((r) => r.newPrice > r.currentPrice)) return "increase";
  if (rows.some((r) => r.newPrice < r.currentPrice)) return "decrease";
  return "none";
}

export type NoticeCheck = { ok: true } | { ok: false; code: string; error: string };

/**
 * Increases require advance notice. A family must be told their price is going
 * up BEFORE it goes up — so an increase cannot run without a future date on
 * which the new price takes effect, and the notification goes out immediately,
 * which is necessarily before it.
 *
 * Decreases need no gate: nobody is harmed by paying less sooner, and the
 * notification still goes out.
 */
export function validateNotice(args: {
  direction: "increase" | "decrease" | "none";
  notifyBeforeDate: Date | null;
  now: Date;
}): NoticeCheck {
  const { direction, notifyBeforeDate, now } = args;
  if (direction !== "increase") return { ok: true };
  if (!notifyBeforeDate) {
    return {
      ok: false,
      code: "NOTICE_REQUIRED",
      error:
        "This is a price increase. Set the date the new price takes effect — families must be told before it does.",
    };
  }
  if (!Number.isFinite(notifyBeforeDate.getTime())) {
    return { ok: false, code: "NOTICE_INVALID", error: "That effective date could not be read." };
  }
  if (notifyBeforeDate.getTime() <= now.getTime()) {
    return {
      ok: false,
      code: "NOTICE_IN_PAST",
      error:
        "The effective date must be in the future. An increase that has already taken effect cannot be announced in advance.",
    };
  }
  return { ok: true };
}

/** Per-row outcome of an apply run. */
export type ApplyOutcome =
  | "UPDATED"
  | "SKIPPED_NOT_FOUND"
  | "SKIPPED_ALREADY_AT_PRICE"
  | "SKIPPED_CHANGED_UNDERNEATH"
  | "FAILED_STRIPE"
  | "FAILED_STRIPE_UNVERIFIED"
  | "FAILED_DB_ROLLED_BACK"
  | "FAILED_DB_ROLLBACK_FAILED";

export type ApplyRowResult = {
  memberSubscriptionId: string;
  memberId: string | null;
  memberName: string | null;
  outcome: ApplyOutcome;
  channel: "stripe" | "offline" | null;
  fromPrice: number | null;
  toPrice: number | null;
  credit: CreditResult | null;
  emailed: boolean;
  emailStatus: string | null;
  message: string | null;
};

const OUTCOME_IS_FAILURE = new Set<ApplyOutcome>([
  "FAILED_STRIPE",
  "FAILED_STRIPE_UNVERIFIED",
  "FAILED_DB_ROLLED_BACK",
  "FAILED_DB_ROLLBACK_FAILED",
]);

export function isFailureOutcome(o: ApplyOutcome): boolean {
  return OUTCOME_IS_FAILURE.has(o);
}

/**
 * The member-facing notification for one repriced subscription.
 *
 * Shows base + processing fee + total whenever the club passes fees through,
 * because a member who sees "$175" and is charged $180.08 reads that as a bug
 * (the standing rule from the 2026-07-15 billing batch).
 */
export function buildPriceChangeEmail(args: {
  clubName: string;
  memberName: string;
  planName: string;
  optionLabel: string;
  billingPeriod: string;
  fromPrice: number;
  toPrice: number;
  passProcessingFees: boolean;
  /** Date the new price takes effect. Null = next billing cycle. */
  effectiveDate: Date | null;
  channel: "stripe" | "offline";
  credit: CreditResult;
  /** Owner's note to the family. Plain text — rendered as its own paragraph. */
  memo?: string | null;
}): { subject: string; blocks: EmailBlock[] } {
  const {
    clubName, memberName, planName, optionLabel, billingPeriod,
    fromPrice, toPrice, passProcessingFees, effectiveDate, channel, credit, memo,
  } = args;

  const goingUp = toPrice > fromPrice;
  const period = PERIOD_WORD[billingPeriod] ?? billingPeriod.toLowerCase();
  const fmtUsd = (n: number) => `$${n.toFixed(2)}`;
  const fmtDate = (d: Date) =>
    d.toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });

  const subject = goingUp
    ? `A change to your ${planName} membership price`
    : `Good news — your ${planName} membership price is going down`;

  const blocks: EmailBlock[] = [
    { type: "heading", level: 2, text: goingUp ? "Your membership price is changing" : "Your membership price is going down" },
    {
      type: "paragraph",
      runs: [{ kind: "text", text: `Hi ${memberName || "there"},` }],
    },
    {
      type: "paragraph",
      runs: [
        { kind: "text", text: `${clubName} is updating the price of the ` },
        { kind: "text", text: `${planName} — ${optionLabel}`, bold: true },
        { kind: "text", text: ` membership, billed ${period}.` },
      ],
    },
    ...(memo && memo.trim()
      ? [{
          type: "paragraph" as const,
          runs: [{ kind: "text" as const, text: memo.trim(), italic: true }],
        }]
      : []),
    {
      type: "list",
      style: "bulleted",
      items: [
        [{ kind: "text", text: `You pay today: ${fmtUsd(fromPrice)}` }],
        [{ kind: "text", text: `You will pay: ${fmtUsd(toPrice)}` }],
        [
          {
            kind: "text",
            text: effectiveDate
              ? `Takes effect: ${fmtDate(effectiveDate)}`
              : "Takes effect: your next billing cycle",
          },
        ],
      ],
    },
  ];

  if (passProcessingFees) {
    const b = feeBreakdown(toPrice, true);
    blocks.push({
      type: "paragraph",
      runs: [
        {
          kind: "text",
          text: `Your card is charged ${fmtUsd(b.total)} — ${fmtUsd(b.base)} membership plus ${fmtUsd(b.fee)} card processing.`,
        },
      ],
    });
  }

  if (channel === "stripe") {
    blocks.push({
      type: "paragraph",
      runs: [
        {
          kind: "text",
          text: "Nothing is needed from you. Your existing payment method will be charged the new amount on your next billing date — you have not been charged or refunded today.",
        },
      ],
    });
  } else {
    blocks.push({
      type: "paragraph",
      runs: [
        {
          kind: "text",
          text: "You pay this membership directly rather than by automatic card billing, so nothing has been charged or refunded. The new amount applies from the date above.",
        },
      ],
    });
  }

  if (credit.kind === "CREDIT_OWED" && credit.amount != null) {
    blocks.push({
      type: "paragraph",
      runs: [
        { kind: "text", text: "Because you have already paid for time at the old price, we owe you " },
        { kind: "text", text: fmtUsd(credit.amount), bold: true },
        { kind: "text", text: ` for unused time. We will be in touch to settle that — you do not need to do anything.` },
      ],
    });
  }

  blocks.push({
    type: "paragraph",
    runs: [{ kind: "text", text: "If anything here looks wrong, just reply to this email and we'll sort it out." }],
  });

  return { subject, blocks };
}

const PERIOD_WORD: Record<string, string> = {
  WEEKLY: "weekly",
  MONTHLY: "monthly",
  QUADRIMESTRAL: "every four months",
  QUARTERLY: "quarterly",
  SEMI_ANNUAL: "every six months",
  ANNUAL: "annually",
  ONE_TIME: "as a one-time payment",
};
