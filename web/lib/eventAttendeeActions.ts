// What the Attendees screen may DO with a row — the pure half of B11 slice 3.
//
// PURE. No prisma, no fetch, no Date.now(). The screen (components/events/
// AttendeesModal.tsx) and the at-the-door charge route both read these, and
// scripts/event-attendee-actions-tests.ts exercises every branch by hand.
//
// Nothing here moves money or decides an amount a family is billed. Every
// action resolves to an EXISTING route (offline-payment, resend-receipt,
// approve / propose-change / decline, bill-registrants, the registration
// DELETE); this module only answers "which of those applies to this row" and
// "what do the tiles, chips and collect panel say" — all from the ONE ledger
// built by lib/eventAttendees.buildAttendeeLedger. The server re-checks every
// rule; a stale screen gets a refusal, never a wrong write.

import {
  matchesFilter,
  rowOwes,
  type AttendeeFilter,
  type AttendeeLedger,
  type AttendeeRow,
} from "@/lib/eventAttendees";
import { eventAllowedPaymentMethods, type EventPaymentMethod } from "@/lib/eventPayments";

const money = (n: number) => Math.round(n * 100) / 100;

// ── Tiles + filter chips ────────────────────────────────────────────────────

export type AttendeeTile = {
  key: "collected" | "outstanding" | "scheduled" | "waiting";
  label: string;
  /** Money tiles carry dollars; the waiting tile carries a head count. */
  amount: number | null;
  count: number;
  sub: string;
  tone: "warn" | "brand" | null;
};

/** The four tiles, straight off the ledger. No second source of any figure. */
export function attendeeTiles(l: AttendeeLedger): AttendeeTile[] {
  const t = l.tiles;
  const collectedCount = l.rows.filter((r) => !r.removed && r.status === "PAID").length;
  return [
    { key: "collected", label: "Collected", amount: t.collected, count: collectedCount, sub: collectedCount === 1 ? "1 paid" : `${collectedCount} paid`, tone: null },
    { key: "outstanding", label: "Outstanding", amount: t.outstanding, count: t.outstandingCount, sub: `${t.outstandingCount} owe`, tone: t.outstanding > 0 ? "warn" : null },
    { key: "scheduled", label: "Scheduled", amount: t.scheduled, count: t.scheduledCount, sub: `${t.scheduledCount} card${t.scheduledCount === 1 ? "" : "s"} on file`, tone: null },
    { key: "waiting", label: "Waiting on you", amount: null, count: t.waitingOnYou, sub: "coach decisions", tone: t.waitingOnYou > 0 ? "brand" : null },
  ];
}

export const ATTENDEE_FILTERS: { key: AttendeeFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "owes", label: "Owes money" },
  { key: "waiting", label: "Waiting on you" },
  { key: "scheduled", label: "Card scheduled" },
  { key: "settled", label: "Settled" },
];

/** Chip labels with their live counts — the ledger's own `filters` record. */
export function filterChips(l: AttendeeLedger): { key: AttendeeFilter; label: string; count: number }[] {
  return ATTENDEE_FILTERS.map((f) => ({ ...f, count: l.filters[f.key] }));
}

/** The rows a chip shows. Removed rows only when asked for, and never counted. */
export function visibleRows(l: AttendeeLedger, filter: AttendeeFilter, showRemoved: boolean): AttendeeRow[] {
  return l.rows.filter((r) => (r.removed ? showRemoved && filter === "all" : matchesFilter(r, filter)));
}

// ── Collect payment ─────────────────────────────────────────────────────────

export type CollectContext = {
  /** Split-cost event: everyone active is billed the per-head share. */
  isVariable: boolean;
  /** Split share (variable) or the event's list price (fixed) — the same
   *  fallbacks bill-registrants applies when a row has no recorded amount. */
  perHead: number | null;
  publicPrice: number | null;
};

/** Statuses a payment link may go to. SCHEDULED is already authorized (a link
 *  would collect twice — bill-registrants refuses it too); PENDING_REVIEW has
 *  not been approved, so billing it would skip the coach. An abandoned
 *  checkout (PENDING_PAYMENT) is exactly who the link exists for. */
const LINKABLE = new Set(["REGISTERED", "AWAITING_CASH", "AWAITING_CHECK", "PAYMENT_FAILED", "PENDING_PAYMENT"]);

/** What a payment link would ask this row for — the display mirror of
 *  lib/eventRepricing.amountToCollect. The review step shows the server's own
 *  figure before anything is sent, so this can never become what is billed. */
export function collectAmount(r: AttendeeRow, ctx: CollectContext): number {
  if (!r.registrationId || r.removed || !LINKABLE.has(r.status)) return 0;
  if (r.owes > 0) return r.owes;
  if (ctx.isVariable) return money(Math.max(0, ctx.perHead ?? 0));
  if (r.amountDue > 0) return money(Math.max(0, r.amountDue - r.paid));
  return money(Math.max(0, ctx.publicPrice ?? 0));
}

export function isCollectable(r: AttendeeRow, ctx: CollectContext): boolean {
  return collectAmount(r, ctx) > 0;
}

export type CollectSummary = { ids: string[]; count: number; total: number };

/** "Email payment link to all unpaid (n)" — n and the total it quotes. */
export function collectSummary(rows: AttendeeRow[], ctx: CollectContext): CollectSummary {
  const hits = rows.filter((r) => isCollectable(r, ctx));
  return {
    ids: hits.map((r) => r.registrationId as string),
    count: hits.length,
    total: money(hits.reduce((s, r) => s + collectAmount(r, ctx), 0)),
  };
}

/** Which rows get a checkbox: anything that can be emailed a link or have
 *  cash recorded. Selection is by registration id. */
export function isSelectable(r: AttendeeRow, ctx: CollectContext): boolean {
  return isCollectable(r, ctx) || cashRecordable(r);
}

/** "Email selected (n)" — only the selected rows a link can actually go to. */
export function selectedCollect(selected: Iterable<string>, rows: AttendeeRow[], ctx: CollectContext): CollectSummary {
  const want = new Set(selected);
  return collectSummary(rows.filter((r) => r.registrationId && want.has(r.registrationId)), ctx);
}

/** Cash/check can be recorded when the registration carries a recorded amount
 *  (the offline-payment route settles amountDue exactly; a null amount is a
 *  refusal) and nothing is committed yet. Coach review comes first. */
export function cashRecordable(r: AttendeeRow): boolean {
  if (!r.registrationId || r.removed) return false;
  if (!["REGISTERED", "AWAITING_CASH", "AWAITING_CHECK", "PAYMENT_FAILED", "PENDING_PAYMENT"].includes(r.status)) return false;
  return r.amountDue > 0;
}

export type CashSelection = { ids: string[]; count: number; total: number; skipped: string[] };

/** "Record cash for selected" — what will be recorded, and who can't be. */
export function selectedCash(selected: Iterable<string>, rows: AttendeeRow[]): CashSelection {
  const want = new Set(selected);
  const picked = rows.filter((r) => r.registrationId && want.has(r.registrationId));
  const ok = picked.filter(cashRecordable);
  return {
    ids: ok.map((r) => r.registrationId as string),
    count: ok.length,
    total: money(ok.reduce((s, r) => s + r.amountDue, 0)),
    skipped: picked.filter((r) => !cashRecordable(r)).map((r) => r.name),
  };
}

// ── Stale amounts ───────────────────────────────────────────────────────────

/**
 * Fixed-price rows carrying an amount the event's own price doesn't produce —
 * usually a figure recorded before the pricing changed. Surfaced with a
 * "Reprice all unpaid" action before anything is emailed (the old
 * Registrations screen's check, kept). A per-session purchase legitimately
 * carries its own total, so it is never flagged. Split events bill the
 * per-head share, which has no stale snapshot to compare.
 */
export function mismatchedRows(
  rows: AttendeeRow[],
  ctx: CollectContext,
  detail: (registrationId: string) => { discountAmount?: number | null; sessionIds?: string[] | null } | null | undefined,
): AttendeeRow[] {
  if (ctx.isVariable) return [];
  const list = ctx.publicPrice ?? 0;
  if (!(list > 0)) return [];
  return rows.filter((r) => {
    if (!r.registrationId || r.removed || !isCollectable(r, ctx) || !(r.amountDue > 0)) return false;
    const d = detail(r.registrationId);
    if (d?.sessionIds && d.sessionIds.length > 0) return false;
    const expected = Math.max(0, list - Number(d?.discountAmount ?? 0));
    return Math.round(r.amountDue * 100) !== Math.round(expected * 100);
  });
}

// ── Row actions ─────────────────────────────────────────────────────────────

export type RowAction = "record" | "resend" | "chargeNow" | "decide" | "remove" | "addEmail" | "discount";

export type RowActionContext = {
  /** From the registrations payload: may THIS user approve/decline/propose. */
  canDecide: boolean;
  now: Date;
  /** Per-registration extras the ledger doesn't carry. */
  detail?: {
    transactionId?: string | null;
    fixMemberId?: string | null;
  } | null;
};

/**
 * The inline actions a row offers, in display order. The server enforces
 * each one again; this only keeps a button off rows it can't apply to.
 */
export function rowActions(r: AttendeeRow, ctx: RowActionContext): RowAction[] {
  if (r.removed) return [];
  const out: RowAction[] = [];
  if (r.registrationId) {
    if (r.status === "PENDING_REVIEW" && r.waitingOn === "COACH" && ctx.canDecide) out.push("decide");
    if (cashRecordable(r)) out.push("record");
    if (r.status === "PAID") out.push("resend");
    // Charge now = the event-day charge a family already consented to, whose
    // date has arrived but the sweep hasn't reached yet. Never early.
    if (r.status === "SCHEDULED" && r.scheduledAt && new Date(r.scheduledAt).getTime() <= ctx.now.getTime()) {
      out.push("chargeNow");
    }
    if (!r.email && ctx.detail?.fixMemberId) out.push("addEmail");
    if (
      ["REGISTERED", "AWAITING_CASH", "AWAITING_CHECK", "PAYMENT_FAILED", "PENDING_PAYMENT", "PENDING_REVIEW"].includes(r.status) &&
      !ctx.detail?.transactionId
    ) {
      out.push("discount");
    }
  }
  out.push("remove");
  return out;
}

/** How a remove is carried out, or why it can't be, decided before the call so
 *  the confirm sheet can say it. Mirrors the refusals in
 *  DELETE /api/events/[id]/registrations/[regId]; the server has the last word. */
export type RemovePlan =
  | { kind: "registration"; registrationId: string; note: string }
  | { kind: "booking"; memberId: string; note: string }
  | { kind: "blocked"; reason: string };

export function removePlan(r: AttendeeRow, detail?: { transactionId?: string | null } | null): RemovePlan {
  if (r.registrationId) {
    if (r.status === "PAID" || r.paid > 0) {
      return { kind: "blocked", reason: `${r.name} has already paid. Refund them first, then remove them — removing never deletes money that was received.` };
    }
    if (r.status === "SCHEDULED") {
      return { kind: "blocked", reason: `${r.name}'s card charge is authorized for the event date. Cancel the scheduled charge before removing them.` };
    }
    if (detail?.transactionId || r.status === "AWAITING_CASH" || r.status === "AWAITING_CHECK") {
      return { kind: "blocked", reason: `An open cash/check record exists for ${r.name}. Void it in Financials first, then remove them.` };
    }
    return {
      kind: "registration",
      registrationId: r.registrationId,
      note: r.owes > 0
        ? `They come off the roster and the billing list together — the $${r.owes.toFixed(2)} they owe is cleared and no more payment links go out.`
        : "They come off the roster and the billing list together.",
    };
  }
  if (r.memberId) {
    return { kind: "booking", memberId: r.memberId, note: "They come off the roster. There's no bill attached to this spot." };
  }
  return { kind: "blocked", reason: "This row can't be removed from here." };
}

// ── Add attendee ────────────────────────────────────────────────────────────

/** What staff can pick under "Paying by". Each maps onto one branch of
 *  POST /api/events/[id]/charge — the existing at-the-door path. */
export type StaffAddMethod = "INVOICE" | "TERMINAL" | "CASH" | "CHECK";

/** The event method each staff choice is an instance of. The charge route
 *  refuses a choice whose event method isn't on the event. */
export const STAFF_METHOD_REQUIRES: Record<StaffAddMethod, EventPaymentMethod> = {
  INVOICE: "CARD",
  TERMINAL: "CARD",
  CASH: "CASH",
  CHECK: "CHECK",
};

export const STAFF_METHOD_LABELS: Record<StaffAddMethod, string> = {
  INVOICE: "Card — email a payment link",
  TERMINAL: "Card — on your reader now",
  CASH: "Cash — received now",
  CHECK: "Check — received now",
};

export type AddEventShape = {
  pricingModel?: string | null;
  variableCostEnabled?: boolean | null;
  memberPrice?: unknown;
  nonMemberPrice?: unknown;
  dropInFee?: unknown;
  paymentMethods?: unknown;
  sellIndividualSessions?: boolean | null;
  sessions?: { id: string; name?: string | null; price?: unknown; startsAt?: string | Date | null }[] | null;
};

export type AddPaymentPlan =
  | { kind: "FREE"; note: string }
  | { kind: "SPLIT"; note: string }
  | {
      kind: "PAID";
      methods: StaffAddMethod[];
      /** Event methods staff can't use on someone's behalf, with why. */
      unavailable: { method: EventPaymentMethod; reason: string }[];
      note: string;
    };

const numOrNull = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

export function isPricedEvent(e: AddEventShape): boolean {
  const priced = [e.memberPrice, e.nonMemberPrice, e.dropInFee].some((v) => (numOrNull(v) ?? 0) > 0);
  const sessionPriced = !!e.sellIndividualSessions && (e.sessions ?? []).some((s) => (numOrNull(s.price) ?? 0) > 0);
  return priced || sessionPriced;
}

/**
 * "Paying by" — ONLY what the event allows, inherited from the event's own
 * "How people pay". Nothing here is a second payment setting.
 */
export function staffAddPaymentPlan(e: AddEventShape): AddPaymentPlan {
  if (e.variableCostEnabled || e.pricingModel === "SPLIT") {
    return { kind: "SPLIT", note: "The cost is split, so nobody pays now — everyone is invoiced from this list once the total is set." };
  }
  if (e.pricingModel === "FREE" || !isPricedEvent(e)) {
    return { kind: "FREE", note: "This event is free, so there is nothing to collect." };
  }
  const allowed = eventAllowedPaymentMethods(e);
  const methods: StaffAddMethod[] = [];
  if (allowed.includes("CARD")) methods.push("INVOICE", "TERMINAL");
  if (allowed.includes("CASH")) methods.push("CASH");
  if (allowed.includes("CHECK")) methods.push("CHECK");
  const unavailable: { method: EventPaymentMethod; reason: string }[] = [];
  if (allowed.includes("AUTO_CARD")) {
    unavailable.push({
      method: "AUTO_CARD",
      reason: "A saved-card charge needs the family's own consent at signup, so staff can't choose it for them.",
    });
  }
  return {
    kind: "PAID",
    methods,
    unavailable,
    note: "Payment options come from the event — change them in the event's “How people pay”, not here.",
  };
}

export type TakingOption =
  | { key: "MEMBER"; label: string; amount: number }
  | { key: "NON_MEMBER"; label: string; amount: number }
  | { key: "DROP_IN"; label: string; amount: number }
  | { key: "SESSIONS"; label: string; amount: null };

/** "Taking" — the whole-event prices, plus "Pick sessions…" when the event
 *  sells sessions on their own. Word for the event is the caller's. */
export function takingOptions(e: AddEventShape, now: Date): TakingOption[] {
  const out: TakingOption[] = [];
  const m = numOrNull(e.memberPrice);
  const nm = numOrNull(e.nonMemberPrice);
  const di = numOrNull(e.dropInFee);
  if (m != null && m > 0) out.push({ key: "MEMBER", label: `Whole event — member $${m.toFixed(2)}`, amount: m });
  if (nm != null && nm > 0) out.push({ key: "NON_MEMBER", label: `Whole event — non-member $${nm.toFixed(2)}`, amount: nm });
  if (sellableSessions(e, now).length > 0) {
    out.push({ key: "SESSIONS", label: "Pick sessions…", amount: null });
  } else if (di != null && di > 0 && (e.sessions?.length ?? 0) > 1) {
    out.push({ key: "DROP_IN", label: `One session — $${di.toFixed(2)}`, amount: di });
  }
  return out;
}

/** Sessions a staff add can sell individually: FIXED + sellIndividualSessions,
 *  priced, not started. Same gates as lib/eventPricingModel.quoteSessions,
 *  which the server runs again. */
export function sellableSessions(e: AddEventShape, now: Date) {
  if ((e.pricingModel ?? "FIXED") !== "FIXED" || !e.sellIndividualSessions) return [];
  return (e.sessions ?? []).filter((s) => {
    const p = numOrNull(s.price);
    if (p == null || p <= 0) return false;
    if (s.startsAt && new Date(s.startsAt).getTime() < now.getTime()) return false;
    return true;
  });
}

export function sessionsTotal(e: AddEventShape, ids: string[], now: Date): number {
  const pick = new Set(ids);
  return money(sellableSessions(e, now).filter((s) => pick.has(s.id)).reduce((t, s) => t + (numOrNull(s.price) ?? 0), 0));
}

export type AddRequest =
  | { route: "bookings"; body: { memberId: string } }
  | {
      route: "charge";
      body: {
        memberId: string;
        pricingType?: "MEMBER" | "NON_MEMBER" | "DROP_IN";
        paymentMethod?: StaffAddMethod;
        sessionIds?: string[];
        reference?: string | null;
      };
    };

/**
 * The one request an add turns into. Free → the booking route (a free spot
 * has no bill). Everything else → the charge route, which creates the
 * registration (the bill) and the booking (the spot) in the same request.
 */
export function buildAddRequest(
  e: AddEventShape,
  input: { memberId: string; taking: TakingOption["key"] | null; sessionIds: string[]; method: StaffAddMethod | null; reference?: string | null },
): { ok: true; req: AddRequest } | { ok: false; error: string } {
  const plan = staffAddPaymentPlan(e);
  if (!input.memberId) return { ok: false, error: "Pick who you're adding." };
  if (plan.kind === "FREE") return { ok: true, req: { route: "bookings", body: { memberId: input.memberId } } };
  if (plan.kind === "SPLIT") return { ok: true, req: { route: "charge", body: { memberId: input.memberId } } };
  if (!input.method || !plan.methods.includes(input.method)) {
    return { ok: false, error: "Pick how they're paying — only this event's payment options can be used." };
  }
  let pricingType: "MEMBER" | "NON_MEMBER" | "DROP_IN" = "MEMBER";
  let sessionIds: string[] | undefined;
  if (input.taking === "NON_MEMBER") pricingType = "NON_MEMBER";
  else if (input.taking === "DROP_IN") pricingType = "DROP_IN";
  else if (input.taking === "SESSIONS") {
    if (input.sessionIds.length === 0) return { ok: false, error: "Pick at least one session." };
    pricingType = "DROP_IN";
    sessionIds = input.sessionIds;
  }
  return {
    ok: true,
    req: {
      route: "charge",
      body: {
        memberId: input.memberId,
        pricingType,
        paymentMethod: input.method,
        ...(sessionIds ? { sessionIds } : {}),
        ...(input.method === "CHECK" && input.reference ? { reference: input.reference } : {}),
      },
    },
  };
}

/** Server side of the same rule: may this staff method be used on an event
 *  with these allowed methods? */
export function staffMethodAllowed(method: StaffAddMethod | "STRIPE", allowed: EventPaymentMethod[]): boolean {
  const need = method === "STRIPE" ? "CARD" : STAFF_METHOD_REQUIRES[method];
  return allowed.includes(need);
}

/** Initials for the phone card avatar. */
export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("");
}

/** Used by tests and the footer: the ledger's own "of" figure. */
export function ledgerGrandTotal(l: AttendeeLedger): number {
  return money(l.tiles.outstanding + l.tiles.collected + l.tiles.scheduled);
}

// Re-exported so the screen imports its row rules from one place.
export { rowOwes, matchesFilter };
