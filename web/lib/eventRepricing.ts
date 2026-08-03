// Event repricing — the ONE model for "what does this registration owe right
// now", and what must change when the owner edits an event's pricing.
//
// Why this file exists: EventRegistration.amountDue is a SNAPSHOT taken at
// registration time. Nothing used to reconcile it when the event's pricing
// changed afterwards, so a camp repriced from a variable-cost split to a flat
// $450 kept invoicing the dead per-head figure (Frog Empire Road Trip,
// 2026-08-03: 11 rows stuck at $533.33 = an orphaned variableCostTotal ÷
// variableCostEstimatedSignups, invoiced 22 minutes before the event was
// switched to fixed pricing). The snapshot is still authoritative for money
// that is already committed — this module draws the line between the two.
//
// PURE — no prisma, no IO, no Date.now() beyond an injected `now`. Callers
// (bill-registrants, the reprice endpoint, the roster UI, the cash-entry
// prompt) all resolve amounts through here so the screen, the email, and the
// Stripe line item can never disagree again.

import { publicFixedPrice } from "@/lib/eventPricing";
import { CHECKOUT_HOLD_MS } from "@/lib/eventPayments";

export type PricingEvent = {
  variableCostEnabled?: boolean | null;
  variableCostMode?: string | null;
  variableCostTotal?: unknown;
  variableCostEstimatedSignups?: number | null;
  variableCostEstimatedTotal?: unknown;
  publicPricingOption?: string | null;
  memberPrice?: unknown;
  nonMemberPrice?: unknown;
  dropInFee?: unknown;
};

export type PricingRegistration = {
  id: string;
  name?: string | null;
  status: string;
  amountDue?: unknown;
  amountPaid?: unknown;
  transactionId?: string | null;
  createdAt?: Date | string | null;
};

export type RepriceRow = {
  id: string;
  name: string;
  status: string;
  /** What the row says today. */
  current: number;
  /** What the event's CURRENT pricing says it should be. */
  expected: number;
  /** current !== expected and the row is repriceable. */
  changed: boolean;
  /** Non-null when the amount must not be touched — money is committed. */
  lockReason: string | null;
};

export type RepricePlan = {
  variable: boolean;
  /** Per-head share for variable-cost events; null on fixed-price events. */
  perHead: number | null;
  /** The event's flat price; 0 when none is set. Null on variable-cost events. */
  fixedPrice: number | null;
  divisor: number | null;
  rows: RepriceRow[];
  /** Rows that would change if applied. */
  changed: RepriceRow[];
  /** Rows skipped because money is already committed. */
  locked: RepriceRow[];
  currentTotal: number;
  expectedTotal: number;
};

const money = (n: number) => Math.round(n * 100) / 100;

function num(v: unknown): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Statuses that are gone — never repriced, never invoiced, never counted in a
 * split. CANCELED is the ONLY way a registration leaves the billing list;
 * there is no hard delete (see DELETE /api/events/[id]/registrations/[regId]).
 */
export function isCanceledRegistration(reg: { status: string }): boolean {
  return reg.status === "CANCELED";
}

/**
 * Why this registration's amount must not be rewritten, or null if it's free
 * to reprice. The rule is "has money been committed against this number?" —
 * once it has, changing the figure underneath it desyncs a Stripe
 * authorization, a recorded Transaction, or a receipt already in someone's
 * inbox. Those need an explicit refund/void decision, not a silent update.
 */
export function pricingLockReason(
  reg: PricingRegistration,
  now: Date = new Date(),
): string | null {
  if (reg.status === "PAID") return "already paid";
  if (num(reg.amountPaid) > 0) return "a payment is already recorded";
  if (reg.status === "SCHEDULED") return "card charge already authorized for the event date";
  if (reg.transactionId) return "a cash/check Transaction is already open — void it first";
  if (reg.status === "AWAITING_CASH" || reg.status === "AWAITING_CHECK") {
    return "an offline payment record is already open — void it first";
  }
  // An in-flight card checkout holds a live Stripe session at the old amount.
  // Past the hold window it's an abandoned row and safe to reprice (same
  // window capacity uses — see CHECKOUT_HOLD_MS).
  if (reg.status === "PENDING_PAYMENT") {
    const started = reg.createdAt ? new Date(reg.createdAt).getTime() : 0;
    if (started && now.getTime() - started < CHECKOUT_HOLD_MS) return "card checkout in progress";
  }
  return null;
}

/**
 * Per-head share for a variable-cost event. Mirrors bill-registrants exactly —
 * OFFICIAL splits across actual attendees, ESTIMATED across expected signups
 * (falling back to actual when no estimate is set). Returns null when the
 * event isn't variable-cost or the total isn't set yet.
 */
export function variablePerHead(
  event: PricingEvent,
  activeCount: number,
): { perHead: number | null; divisor: number | null; total: number | null } {
  if (!event.variableCostEnabled) return { perHead: null, divisor: null, total: null };
  const mode = event.variableCostMode === "OFFICIAL" ? "OFFICIAL" : "ESTIMATED";
  const total =
    event.variableCostTotal != null
      ? num(event.variableCostTotal)
      : event.variableCostEstimatedTotal != null
        ? num(event.variableCostEstimatedTotal)
        : 0;
  if (!(total > 0)) return { perHead: null, divisor: null, total: null };

  const divisor =
    mode === "OFFICIAL"
      ? activeCount
      : event.variableCostEstimatedSignups && event.variableCostEstimatedSignups > 0
        ? event.variableCostEstimatedSignups
        : activeCount;
  if (!(divisor > 0)) return { perHead: null, divisor: null, total };
  return { perHead: money(total / divisor), divisor, total };
}

/**
 * What the event's CURRENT pricing says this registrant owes — ignoring
 * whatever stale figure the row is carrying. This is the number the reprice
 * preview compares against, and the number a fixed-price event should collect.
 */
export function expectedAmount(
  event: PricingEvent,
  activeCount: number,
): number {
  if (event.variableCostEnabled) {
    const { perHead } = variablePerHead(event, activeCount);
    return perHead ?? 0;
  }
  return publicFixedPrice(event);
}

/**
 * What to actually collect from this registration today.
 *
 * Variable-cost: always the live split (the snapshot is only ever a preview).
 * Fixed-price: the recorded amountDue wins — it may legitimately differ per
 * registrant (member vs non-member price, a staff discount) — EXCEPT when it
 * is zero/absent, where the event's flat price fills in. Callers must pair
 * this with `amountMismatch` and refuse to send money on a mismatch without an
 * explicit confirmation; a snapshot the owner has never seen is exactly how
 * $533.33 got emailed to five families.
 */
export function amountToCollect(
  event: PricingEvent,
  reg: PricingRegistration,
  activeCount: number,
): number {
  if (event.variableCostEnabled) return expectedAmount(event, activeCount);
  const recorded = num(reg.amountDue);
  return recorded > 0 ? recorded : publicFixedPrice(event);
}

/** True when what we'd collect differs from what the event's pricing says. */
export function amountMismatch(
  event: PricingEvent,
  reg: PricingRegistration,
  activeCount: number,
): boolean {
  const collect = amountToCollect(event, reg, activeCount);
  const expected = expectedAmount(event, activeCount);
  return Math.round(collect * 100) !== Math.round(expected * 100);
}

/**
 * The full before/after table for an event's active registrations. This is
 * what the owner sees BEFORE anything is written or emailed — the answer to
 * "what will each of these families actually be charged?".
 */
export function planReprice(
  event: PricingEvent,
  registrations: PricingRegistration[],
  opts: { now?: Date } = {},
): RepricePlan {
  const now = opts.now ?? new Date();
  const active = registrations.filter((r) => !isCanceledRegistration(r));
  const activeCount = active.length;

  const variable = !!event.variableCostEnabled;
  const { perHead, divisor } = variablePerHead(event, activeCount);
  const fixedPrice = variable ? null : publicFixedPrice(event);
  const expected = expectedAmount(event, activeCount);

  const rows: RepriceRow[] = active.map((r) => {
    const current = money(num(r.amountDue));
    const lockReason = pricingLockReason(r, now);
    return {
      id: r.id,
      name: r.name ?? "",
      status: r.status,
      current,
      expected: money(expected),
      changed: !lockReason && Math.round(current * 100) !== Math.round(expected * 100),
      lockReason,
    };
  });

  const changed = rows.filter((r) => r.changed);
  const locked = rows.filter((r) => r.lockReason);

  return {
    variable,
    perHead,
    fixedPrice,
    divisor,
    rows,
    changed,
    locked,
    currentTotal: money(rows.reduce((s, r) => s + r.current, 0)),
    expectedTotal: money(
      rows.reduce((s, r) => s + (r.lockReason ? r.current : r.expected), 0),
    ),
  };
}

/**
 * Did this event edit change what registrants owe? Used by the PATCH route to
 * decide whether to hand back a repricing preview instead of leaving stale
 * amounts behind silently.
 */
export function pricingChanged(before: PricingEvent, after: PricingEvent): boolean {
  const key = (e: PricingEvent) =>
    JSON.stringify([
      !!e.variableCostEnabled,
      e.variableCostMode ?? null,
      e.variableCostTotal == null ? null : num(e.variableCostTotal),
      e.variableCostEstimatedSignups ?? null,
      e.variableCostEstimatedTotal == null ? null : num(e.variableCostEstimatedTotal),
      e.publicPricingOption ?? null,
      e.memberPrice == null ? null : num(e.memberPrice),
      e.nonMemberPrice == null ? null : num(e.nonMemberPrice),
      e.dropInFee == null ? null : num(e.dropInFee),
    ]);
  return key(before) !== key(after);
}

/**
 * The specific transition that caused the Frog Empire bug: variable cost
 * turned OFF. Every non-committed registration is carrying a per-head split of
 * a total that no longer exists, so the snapshot is not "a price someone
 * agreed to" — it is debris. Clearing it makes the fixed price take over.
 */
export function variableCostTurnedOff(before: PricingEvent, after: PricingEvent): boolean {
  return !!before.variableCostEnabled && !after.variableCostEnabled;
}
