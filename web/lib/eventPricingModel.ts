// Event pricing model + signup access — B11 slice 2. PURE: no prisma, no IO.
//
// The editor speaks three words for money (FREE | FIXED | SPLIT) and three for
// access (MEMBERS | PUBLIC_LINK | STAFF_ONLY). The database, until slice 2,
// spoke seven columns that combined into those states implicitly. This module
// is the ONE translation in each direction, so the editor, the API, the public
// page and the register route can never disagree about what an event is.
//
// Rules (design handoff README, "Interactions & Behavior"):
//   1. SPLIT ⇔ variableCostEnabled. Member/non-member prices are OFF under SPLIT.
//   2. SPLIT or FREE ⇒ no payment methods (nothing to collect at signup).
//   3. chargeOnApproval ⇒ CARD (card at signup) is not allowed.
//   4. STAFF_ONLY ⇒ no public link, no self-booking.
//   5. Session prices that total LESS than the whole-event price are a bundle
//      nobody has a reason to buy — say so.

export type PricingModel = "FREE" | "FIXED" | "SPLIT";
export type SignupAccess = "MEMBERS" | "PUBLIC_LINK" | "STAFF_ONLY";
export type SplitInvoiceWhen = "AFTER_EVENT" | "ON_DATE";
export type PaymentMethod = "CARD" | "AUTO_CARD" | "CASH" | "CHECK";

export const PRICING_MODELS: PricingModel[] = ["FREE", "FIXED", "SPLIT"];
export const SIGNUP_ACCESS: SignupAccess[] = ["MEMBERS", "PUBLIC_LINK", "STAFF_ONLY"];

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The legacy columns the model is derived from (all still written). */
export type LegacyEventColumns = {
  variableCostEnabled?: boolean | null;
  memberPrice?: unknown;
  nonMemberPrice?: unknown;
  dropInFee?: unknown;
  visibility?: string | null;
  purchaseAccess?: string | null;
  publicRegistration?: boolean | null;
  invoiceScheduledAt?: Date | string | null;
};

/** Mirrors the migration backfill exactly — tests hold the two together. */
export function derivePricingModel(e: LegacyEventColumns): PricingModel {
  if (e.variableCostEnabled) return "SPLIT";
  const anyPrice = (num(e.memberPrice) ?? 0) > 0 || (num(e.nonMemberPrice) ?? 0) > 0 || (num(e.dropInFee) ?? 0) > 0;
  return anyPrice ? "FIXED" : "FREE";
}

export function deriveSignupAccess(e: LegacyEventColumns): SignupAccess {
  if (e.purchaseAccess === "STAFF_ONLY" || e.visibility === "STAFF_ONLY") return "STAFF_ONLY";
  if (e.publicRegistration) return "PUBLIC_LINK";
  return "MEMBERS";
}

export function deriveSplitInvoiceWhen(e: LegacyEventColumns, model: PricingModel): SplitInvoiceWhen | null {
  if (model !== "SPLIT") return null;
  return e.invoiceScheduledAt ? "ON_DATE" : "AFTER_EVENT";
}

/**
 * The reverse translation: what the old columns must say so every reader that
 * has not been rewritten yet (the public page's visibility check, the
 * variable-cost billing job, the register route's drop-in branch) keeps
 * agreeing with the editor. The API writes BOTH sets on every save.
 */
export function legacyColumnsFor(input: {
  pricingModel: PricingModel;
  signupAccess: SignupAccess;
  memberPrice?: number | null;
  nonMemberPrice?: number | null;
  sellIndividualSessions?: boolean;
  /** Lowest per-session price, for the legacy single drop-in fee. */
  minSessionPrice?: number | null;
  splitInvoiceWhen?: SplitInvoiceWhen | null;
  splitInvoiceDate?: Date | null;
}): {
  variableCostEnabled: boolean;
  memberPrice: number | null;
  nonMemberPrice: number | null;
  dropInFee: number | null;
  visibility: "PUBLIC" | "MEMBERS_ONLY" | "STAFF_ONLY";
  purchaseAccess: "ANYONE" | "STAFF_ONLY";
  publicRegistration: boolean;
  invoiceScheduledAt: Date | null;
} {
  const fixed = input.pricingModel === "FIXED";
  return {
    variableCostEnabled: input.pricingModel === "SPLIT",
    memberPrice: fixed ? input.memberPrice ?? null : null,
    nonMemberPrice: fixed ? input.nonMemberPrice ?? null : null,
    dropInFee: fixed && input.sellIndividualSessions ? input.minSessionPrice ?? null : null,
    visibility: input.signupAccess === "STAFF_ONLY" ? "STAFF_ONLY" : input.signupAccess === "PUBLIC_LINK" ? "PUBLIC" : "MEMBERS_ONLY",
    purchaseAccess: input.signupAccess === "STAFF_ONLY" ? "STAFF_ONLY" : "ANYONE",
    publicRegistration: input.signupAccess === "PUBLIC_LINK",
    invoiceScheduledAt:
      input.pricingModel === "SPLIT" && input.splitInvoiceWhen === "ON_DATE" ? input.splitInvoiceDate ?? null : null,
  };
}

// ── Exclusion rules ────────────────────────────────────────────────────────

export type ExclusionInput = {
  pricingModel: PricingModel;
  signupAccess: SignupAccess;
  paymentMethods: PaymentMethod[];
  chargeOnApproval: boolean;
  requiresCoachApproval: boolean;
};

export type Exclusions = {
  /** Methods that stay after the rules; what the API should persist. */
  paymentMethods: PaymentMethod[];
  /** Why the payment-method list is off entirely, if it is. */
  paymentMethodsLocked: string | null;
  /** Why CARD specifically is off, if it is (rule 3). */
  cardDisabledReason: string | null;
  /** Rule 4. */
  publicLinkLocked: string | null;
  /** The desktop conflict panel line, or null when nothing conflicts. */
  conflict: string | null;
};

export function applyExclusions(input: ExclusionInput): Exclusions {
  const lockedBecause =
    input.pricingModel === "SPLIT"
      ? "Payment methods are off because the cost is split — everyone is invoiced after the event, from the Attendees list."
      : input.pricingModel === "FREE"
        ? "This event is free, so there is nothing to collect."
        : null;
  const cardDisabled =
    input.requiresCoachApproval && input.chargeOnApproval
      ? "Off — a coach approval can't charge a card up front too. Uncheck 'charge on approve' to re-enable."
      : null;
  let methods = lockedBecause ? [] : input.paymentMethods.filter((m, i, a) => a.indexOf(m) === i);
  if (cardDisabled) methods = methods.filter((m) => m !== "CARD");
  const publicLinkLocked =
    input.signupAccess === "STAFF_ONLY"
      ? "Staff adds people to this event — there is no public link and members can't book it themselves."
      : null;
  const conflict = cardDisabled && input.paymentMethods.includes("CARD") ? "One rule is doing the work of two — card at signup and charge-on-approve can't both be on." : null;
  return { paymentMethods: methods, paymentMethodsLocked: lockedBecause, cardDisabledReason: cardDisabled, publicLinkLocked, conflict };
}

// ── Bundle sanity ──────────────────────────────────────────────────────────

export type BundleCheck =
  | { kind: "NONE" }
  | { kind: "SAVING"; sessionsTotal: number; wholeEvent: number; saving: number }
  | { kind: "CHEAPER_A_LA_CARTE"; sessionsTotal: number; wholeEvent: number; difference: number; sentence: string };

const money = (n: number) => `$${n.toFixed(n % 1 === 0 ? 0 : 2)}`;

/** Rule 5 — compares the à-la-carte total to the whole-event (member) price. */
export function bundleSanity(sessionPrices: (number | null | undefined)[], wholeEventPrice: number | null | undefined): BundleCheck {
  const priced = sessionPrices.filter((p): p is number => typeof p === "number" && Number.isFinite(p) && p > 0);
  const whole = num(wholeEventPrice);
  if (priced.length === 0 || whole == null || whole <= 0) return { kind: "NONE" };
  const total = Math.round(priced.reduce((a, b) => a + b, 0) * 100) / 100;
  if (total < whole) {
    const difference = Math.round((whole - total) * 100) / 100;
    return {
      kind: "CHEAPER_A_LA_CARTE",
      sessionsTotal: total,
      wholeEvent: whole,
      difference,
      sentence: `à la carte totals ${money(total)}, which is ${money(difference)} cheaper than the ${money(whole)} whole-event price — nobody has a reason to buy the bundle`,
    };
  }
  return { kind: "SAVING", sessionsTotal: total, wholeEvent: whole, saving: Math.round((total - whole) * 100) / 100 };
}

// ── Per-session purchase ───────────────────────────────────────────────────

export type SessionForPurchase = { id: string; price: unknown; startsAt?: Date | string | null };

export type SessionQuote =
  | { ok: true; sessionIds: string[]; cents: number; label: string }
  | { ok: false; error: string };

/**
 * What a per-session purchase costs. Only FIXED events that sell sessions
 * individually, only sessions that carry a price, never an empty pick, never a
 * session that has already started. The label is what the receipt says.
 */
export function quoteSessions(input: {
  pricingModel: PricingModel;
  sellIndividualSessions: boolean;
  sessions: SessionForPurchase[];
  requestedIds: string[];
  now?: Date;
}): SessionQuote {
  if (input.pricingModel !== "FIXED" || !input.sellIndividualSessions) {
    return { ok: false, error: "This event doesn't sell individual sessions." };
  }
  const ids = Array.from(new Set(input.requestedIds.filter(Boolean)));
  if (ids.length === 0) return { ok: false, error: "Pick at least one session." };
  const now = input.now ?? new Date();
  let cents = 0;
  for (const id of ids) {
    const s = input.sessions.find((x) => x.id === id);
    if (!s) return { ok: false, error: "One of those sessions isn't on this event." };
    const p = num(s.price);
    if (p == null || p <= 0) return { ok: false, error: "One of those sessions isn't sold on its own." };
    if (s.startsAt && new Date(s.startsAt).getTime() < now.getTime()) {
      return { ok: false, error: "One of those sessions has already started." };
    }
    cents += Math.round(p * 100);
  }
  const ordered = input.sessions.filter((s) => ids.includes(s.id)).map((s) => s.id);
  return { ok: true, sessionIds: ordered, cents, label: ordered.length === 1 ? "Single session" : `${ordered.length} sessions` };
}

/** Collapsed Money-card summary — one derivation for every surface that states prices. */
export function moneySummary(e: {
  pricingModel: PricingModel;
  memberPrice?: number | null;
  nonMemberPrice?: number | null;
  sellIndividualSessions?: boolean;
  sessionPrices?: (number | null | undefined)[];
  splitTotal?: number | null;
  splitExpectedSignups?: number | null;
  splitInvoiceWhen?: SplitInvoiceWhen | null;
}): string {
  if (e.pricingModel === "FREE") return "Free — nobody is charged";
  if (e.pricingModel === "SPLIT") {
    const total = e.splitTotal ?? 0;
    const heads = e.splitExpectedSignups ?? 0;
    const each = heads > 0 ? ` ≈ $${(total / heads).toFixed(2)} each` : "";
    return `Split ${money(total)}${each} · ${e.splitInvoiceWhen === "ON_DATE" ? "invoiced on the date you picked" : "invoiced after the event"}`;
  }
  const parts: string[] = [];
  if (e.memberPrice != null) parts.push(`Member ${money(e.memberPrice)}`);
  if (e.nonMemberPrice != null) parts.push(`Non-member ${money(e.nonMemberPrice)}`);
  const priced = (e.sessionPrices ?? []).filter((p): p is number => typeof p === "number" && p > 0);
  if (e.sellIndividualSessions && priced.length) parts.push(`sessions from ${money(Math.min(...priced))}`);
  return parts.length ? parts.join(" · ") : "Fixed price — no amounts set yet";
}

// ── One write, both vocabularies ───────────────────────────────────────────

export type EventWriteInput = {
  // New vocabulary (the slice-2 editor). When pricingModel is present, this is
  // the source of truth and the legacy columns are derived from it.
  pricingModel?: PricingModel | null;
  signupAccess?: SignupAccess | null;
  splitInvoiceWhen?: SplitInvoiceWhen | null;
  splitInvoiceDate?: Date | null;
  sellIndividualSessions?: boolean | null;
  sessionPrices?: (number | null | undefined)[];
  // Legacy vocabulary (the old modal, and anything else still posting it).
  memberPrice?: number | null;
  nonMemberPrice?: number | null;
  dropInFee?: number | null;
  variableCostEnabled?: boolean | null;
  visibility?: string | null;
  purchaseAccess?: string | null;
  publicRegistration?: boolean | null;
  invoiceScheduledAt?: Date | null;
};

export type EventWriteColumns = {
  pricingModel: PricingModel;
  signupAccess: SignupAccess;
  splitInvoiceWhen: SplitInvoiceWhen | null;
  sellIndividualSessions: boolean;
  memberPrice: number | null;
  nonMemberPrice: number | null;
  dropInFee: number | null;
  variableCostEnabled: boolean;
  visibility: string;
  purchaseAccess: string;
  publicRegistration: boolean;
  invoiceScheduledAt: Date | null;
};

/**
 * Every save writes BOTH sets of columns so no reader — old or new — can see a
 * contradictory event. Whichever vocabulary the caller spoke is the source;
 * the other is derived from it with the two functions above.
 */
export function resolveEventWrite(b: EventWriteInput): EventWriteColumns {
  if (b.pricingModel) {
    const priced = (b.sessionPrices ?? []).filter((p): p is number => typeof p === "number" && p > 0);
    const legacy = legacyColumnsFor({
      pricingModel: b.pricingModel,
      signupAccess: b.signupAccess ?? "MEMBERS",
      memberPrice: b.memberPrice ?? null,
      nonMemberPrice: b.nonMemberPrice ?? null,
      sellIndividualSessions: !!b.sellIndividualSessions,
      minSessionPrice: priced.length ? Math.min(...priced) : null,
      splitInvoiceWhen: b.splitInvoiceWhen ?? null,
      splitInvoiceDate: b.splitInvoiceDate ?? b.invoiceScheduledAt ?? null,
    });
    return {
      pricingModel: b.pricingModel,
      signupAccess: b.signupAccess ?? "MEMBERS",
      splitInvoiceWhen: b.pricingModel === "SPLIT" ? b.splitInvoiceWhen ?? "AFTER_EVENT" : null,
      sellIndividualSessions: b.pricingModel === "FIXED" && !!b.sellIndividualSessions,
      ...legacy,
    };
  }
  const legacyIn: LegacyEventColumns = {
    variableCostEnabled: b.variableCostEnabled ?? false,
    memberPrice: b.memberPrice,
    nonMemberPrice: b.nonMemberPrice,
    dropInFee: b.dropInFee,
    visibility: b.visibility ?? "PUBLIC",
    purchaseAccess: b.purchaseAccess ?? "ANYONE",
    publicRegistration: b.publicRegistration ?? false,
    invoiceScheduledAt: b.invoiceScheduledAt ?? null,
  };
  const model = derivePricingModel(legacyIn);
  return {
    pricingModel: model,
    signupAccess: deriveSignupAccess(legacyIn),
    splitInvoiceWhen: deriveSplitInvoiceWhen(legacyIn, model),
    sellIndividualSessions: model === "FIXED" && (num(b.dropInFee) ?? 0) > 0,
    memberPrice: b.memberPrice ?? null,
    nonMemberPrice: b.nonMemberPrice ?? null,
    dropInFee: b.dropInFee ?? null,
    variableCostEnabled: !!b.variableCostEnabled,
    visibility: legacyIn.visibility!,
    purchaseAccess: legacyIn.purchaseAccess!,
    publicRegistration: !!b.publicRegistration,
    invoiceScheduledAt: b.variableCostEnabled ? b.invoiceScheduledAt ?? null : null,
  };
}
