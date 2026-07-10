import crypto from "crypto";

// Billing control center — shared constants + PURE decision logic.
//
// Everything in this module is deliberately side-effect-free (no prisma, no
// stripe) so the server routes, the roster derivation, and the targeted test
// script (`scripts/billing-admin-tests.ts`) all run the exact same rules.
// Server-side writes (audit rows etc.) live in the routes themselves.

// ── Migration triage classification ──────────────────────────────────────

export const MIGRATION_GROUPS = [
  "A", // manual owner approval
  "B", // reactivation email
  "C", // owner review / hold
  "LEAVE_ALONE",
  "FUTURE_FOLLOW_UP",
  "NEEDS_PAYMENT_METHOD",
] as const;
export type MigrationGroup = (typeof MIGRATION_GROUPS)[number];

export const GROUP_LABELS: Record<MigrationGroup, string> = {
  A: "Group A — manual approval",
  B: "Group B — reactivation email",
  C: "Group C — owner review",
  LEAVE_ALONE: "Leave alone",
  FUTURE_FOLLOW_UP: "Future follow-up",
  NEEDS_PAYMENT_METHOD: "Needs payment method",
};

export const FINAL_ACTIONS = [
  "MANUAL_APPROVE",
  "ACTIVATION_EMAIL",
  "LEAVE_ALONE",
  "FUTURE_FOLLOW_UP",
  "NEEDS_CARD",
  "OWNER_REVIEW",
] as const;
export type FinalAction = (typeof FINAL_ACTIONS)[number];

export const FINAL_ACTION_LABELS: Record<FinalAction, string> = {
  MANUAL_APPROVE: "Manual approve",
  ACTIVATION_EMAIL: "Reactivation email",
  LEAVE_ALONE: "Leave alone",
  FUTURE_FOLLOW_UP: "Future follow-up",
  NEEDS_CARD: "Needs card",
  OWNER_REVIEW: "Owner review",
};

// ── Readiness ─────────────────────────────────────────────────────────────

export type Readiness =
  | "READY"
  | "WAITING_OWNER"
  | "WAITING_CLIENT"
  | "HOLD"
  | "LEAVE_ALONE";

export const READINESS_LABELS: Record<Readiness, string> = {
  READY: "Ready",
  WAITING_OWNER: "Waiting on owner decision",
  WAITING_CLIENT: "Waiting on client / payment method",
  HOLD: "Hold",
  LEAVE_ALONE: "Already active / leave alone",
};

export type ReadinessInput = {
  migrationGroup?: string | null;
  migrationFinalAction?: string | null;
  migrationStatus?: string | null;
  approvalStatus?: string | null;
  /** Resolved recurring price (option/override precedence applied); null = no plan configured. */
  price: number | null;
  hasPlan: boolean;
  /** stripeSetupPaymentMethodId captured (a real saved card/wallet). */
  hasCapturedCard: boolean;
  /** Member explicitly chose CASH/CHECK, or the club has no online payments. */
  offlineIntended: boolean;
  finalPeriodPaid?: boolean;
  /** migrationFinalBillingDate ?? billingAnchorDate — the proposed first charge. */
  finalBillingDate: Date | null;
  /** A live (active/trialing/past_due) Stripe subscription already exists. */
  hasLiveStripeSub: boolean;
  /** Latest reactivation offer status, if any. */
  reactivationStatus?: string | null;
  now?: Date;
};

/**
 * Derive the migration-readiness indicator from DB facts only (no Stripe
 * calls). Explicit owner classification always wins over derivation, so a
 * client the owner parked never flips back to "Ready" on its own.
 */
export function deriveReadiness(input: ReadinessInput): { state: Readiness; reasons: string[] } {
  const now = input.now ?? new Date();
  const group = input.migrationGroup ?? null;
  const action = input.migrationFinalAction ?? null;

  if (input.hasLiveStripeSub) {
    return { state: "LEAVE_ALONE", reasons: ["Already has a live Stripe subscription"] };
  }
  if (group === "LEAVE_ALONE" || action === "LEAVE_ALONE") {
    return { state: "LEAVE_ALONE", reasons: ["Owner marked leave alone"] };
  }
  if (group === "C" || action === "OWNER_REVIEW") {
    return { state: "HOLD", reasons: ["Owner review required"] };
  }
  if (group === "FUTURE_FOLLOW_UP" || action === "FUTURE_FOLLOW_UP") {
    return { state: "HOLD", reasons: ["Parked for future follow-up"] };
  }
  if (input.migrationStatus === "COMPLETED") {
    return { state: "LEAVE_ALONE", reasons: ["Migration already completed"] };
  }

  // Free / final-period-paid members have nothing to charge.
  if (input.finalPeriodPaid) {
    return { state: "READY", reasons: ["Final period already paid — no charge to set up"] };
  }
  if (input.hasPlan && input.price === 0) {
    return { state: "READY", reasons: ["Free membership — no recurring charge"] };
  }

  const reasons: string[] = [];
  if (!input.hasPlan || input.price == null) reasons.push("No membership plan configured");
  const dateOk = !!input.finalBillingDate && input.finalBillingDate.getTime() > now.getTime();
  if (!dateOk) {
    reasons.push(
      input.finalBillingDate
        ? "Billing date is in the past — owner must set a new future date"
        : "No owner-approved billing date",
    );
  }
  if (reasons.length) return { state: "WAITING_OWNER", reasons };

  // Owner decisions are in place; is the client side ready?
  const needsCard = !input.offlineIntended && !input.hasCapturedCard;
  if (needsCard || group === "NEEDS_PAYMENT_METHOD" || action === "NEEDS_CARD") {
    return { state: "WAITING_CLIENT", reasons: ["No saved payment method"] };
  }
  if (input.reactivationStatus === "SENT") {
    return { state: "WAITING_CLIENT", reasons: ["Reactivation email sent — awaiting client confirmation"] };
  }
  return { state: "READY", reasons: [] };
}

// ── Internal billing mode (display) ──────────────────────────────────────

export type BillingMode =
  | "STRIPE_RECURRING"
  | "MANUAL"
  | "FREE"
  | "PENDING_ACTIVATION"
  | "PENDING_APPROVAL"
  | "INCOMPLETE"
  | "CANCELED"
  | "NONE";

export const BILLING_MODE_LABELS: Record<BillingMode, string> = {
  STRIPE_RECURRING: "Stripe recurring",
  MANUAL: "Manual / offline",
  FREE: "Free",
  PENDING_ACTIVATION: "Pending activation",
  PENDING_APPROVAL: "Pending approval",
  INCOMPLETE: "Incomplete",
  CANCELED: "Canceled",
  NONE: "No billing",
};

export type BillingModeInput = {
  sub: {
    billingType: string;
    status: string;
    price: number;
    stripeSubscriptionId: string | null;
  } | null;
  migrationStatus?: string | null;
  approvalStatus?: string | null;
};

/** Classify the member's CURRENT internal billing mode for display. */
export function deriveBillingMode(input: BillingModeInput): BillingMode {
  const sub = input.sub;
  if (sub) {
    if (sub.status === "canceled" || sub.status === "expired") return "CANCELED";
    if (sub.stripeSubscriptionId) return "STRIPE_RECURRING";
    if (sub.price <= 0) return "FREE";
    if (sub.billingType === "MANUAL") return "MANUAL";
    if (sub.status === "pending") return "PENDING_ACTIVATION";
    return "MANUAL";
  }
  if (input.approvalStatus === "PENDING_APPROVAL") return "PENDING_APPROVAL";
  if (input.migrationStatus === "INVITED" || input.migrationStatus === "ACTIVATED") {
    return "PENDING_ACTIVATION";
  }
  if (input.migrationStatus === "IMPORTED" || input.migrationStatus === "NEEDS_REVIEW") {
    return "INCOMPLETE";
  }
  return "NONE";
}

// ── Charge timing ─────────────────────────────────────────────────────────

export type ChargeTiming = {
  immediate: boolean;
  firstChargeDate: Date | null;
  label: string;
};

/**
 * Would starting billing with this first-charge date charge NOW or on a
 * future date? Null/past/today (within a minute of now) = immediate.
 * The label is what buttons/emails must show — timing is never vague.
 */
export function chargeTiming(firstChargeDate: Date | null | undefined, now: Date = new Date()): ChargeTiming {
  const d = firstChargeDate ?? null;
  const immediate = !d || d.getTime() <= now.getTime() + 60_000;
  return {
    immediate,
    firstChargeDate: immediate ? now : d,
    label: immediate
      ? "charges immediately on confirmation"
      : `first payment ${d!.toLocaleDateString("en-US", { month: "long", day: "numeric" })}`,
  };
}

// ── Offer pricing precedence ─────────────────────────────────────────────
// Mirrors the migration-approve resolution exactly: assigned plan's first
// option → the member's registered/selected option → the owner's explicit
// price override always wins. Legacy snapshot fills gaps.

export type PricingMemberInput = {
  legacyMembershipName?: string | null;
  legacyMembershipPrice?: number | string | null; // Decimal comes through as string
  legacyBillingFrequency?: string | null;
  migrationSelectedOption?: unknown;
  migrationPriceOverride?: number | string | null;
};

export type PlanInput = {
  name: string;
  options: unknown; // Json: [{ label, price, billingPeriod }]
} | null;

export type ResolvedPricing = {
  planName: string;
  optionLabel: string | null;
  price: number;
  period: string;
};

function parseOptions(raw: unknown): { label?: unknown; price?: unknown; billingPeriod?: unknown }[] {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw || "[]") : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function resolveOfferPricing(member: PricingMemberInput, plan: PlanInput): ResolvedPricing {
  let planName = member.legacyMembershipName || "Continued membership";
  let price = member.legacyMembershipPrice != null ? Number(member.legacyMembershipPrice) : 0;
  let period = member.legacyBillingFrequency || "MONTHLY";
  let optionLabel: string | null = null;

  if (plan) {
    planName = plan.name;
    const opts = parseOptions(plan.options);
    if (opts[0] && typeof opts[0].price === "number") {
      price = opts[0].price;
      optionLabel = typeof opts[0].label === "string" ? opts[0].label : null;
      if (opts[0].billingPeriod) period = String(opts[0].billingPeriod);
    }
  }

  const sel = member.migrationSelectedOption;
  if (sel && typeof sel === "object") {
    const s = sel as { label?: unknown; price?: unknown; billingPeriod?: unknown };
    if (typeof s.price === "number") price = s.price;
    if (typeof s.billingPeriod === "string" && s.billingPeriod) period = s.billingPeriod;
    if (typeof s.label === "string" && s.label) optionLabel = s.label;
  }

  if (member.migrationPriceOverride != null) {
    price = Number(member.migrationPriceOverride);
  }

  return { planName, optionLabel, price, period };
}

/** "MONTHLY" → "monthly", "SEMI_ANNUAL" → "every 6 months", … for display. */
export function prettyPeriod(period: string | null | undefined): string {
  switch ((period || "").toUpperCase()) {
    case "WEEKLY": return "weekly";
    case "BIWEEKLY": return "every 2 weeks";
    case "MONTHLY": return "monthly";
    case "QUARTERLY": return "quarterly";
    case "SEMI_ANNUAL": return "every 6 months";
    case "ANNUAL": return "yearly";
    case "ONE_TIME": return "one-time";
    default: return (period || "").toLowerCase() || "recurring";
  }
}

// ── Payment-method safety ─────────────────────────────────────────────────

/**
 * Opaque reference for a Stripe payment method. Raw `pm_…` ids are sensitive
 * payment data and never leave the server; clients act on this digest and the
 * server re-lists the customer's methods to find the match.
 */
export function pmRef(paymentMethodId: string): string {
  return crypto.createHash("sha256").update(paymentMethodId).digest("hex").slice(0, 16);
}

export type RemovalCheckInput = {
  /** The PM is the default (or only) method behind a live/trialing/past_due Stripe sub. */
  backsLiveSubscription: boolean;
  /** A pending activation / pending approval / sent reactivation expects to charge this PM. */
  backsPendingActivation: boolean;
  /** Another usable saved method exists on the same customer. */
  otherValidMethodExists: boolean;
};

/**
 * A method that anything live or pending would charge can NEVER be removed
 * directly — the replacement must be collected AND made the default first
 * (which repoints the subscription/activation), after which the old method
 * no longer backs anything and becomes removable.
 */
export function canRemovePaymentMethod(input: RemovalCheckInput): { allowed: boolean; reason: string | null } {
  if (input.backsLiveSubscription) {
    return {
      allowed: false,
      reason: input.otherValidMethodExists
        ? "This method still backs an active subscription. Make the replacement method the default first — that repoints the subscription — then remove this one."
        : "This method backs an active subscription and there is no replacement on file. Add a new payment method and make it the default first, then remove this one.",
    };
  }
  if (input.backsPendingActivation) {
    return {
      allowed: false,
      reason: input.otherValidMethodExists
        ? "A pending activation is set to charge this method. Make the replacement the default first, then remove this one."
        : "A pending activation is set to charge this method. Collect a replacement card first, or cancel the pending activation, then remove it.",
    };
  }
  return { allowed: true, reason: null };
}
