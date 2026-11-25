// Event refunds — the pure half (2026-11-25).
//
// PURE. No prisma, no Stripe, no Date.now(). The sheet
// (components/events/attendees/RefundSheet.tsx), the route
// (app/api/events/[id]/registrations/[regId]/refund) and the engine
// (lib/eventRefundServer.ts) all take their arithmetic and their words from
// here; scripts/event-refund-tests.ts exercises every branch.
//
// Everything is integer CENTS until it is printed.

export type RefundMode = "price" | "all" | "custom";

/** How the money came in — decides whether a refund moves money or records it. */
export type RefundVia = "CARD" | "CASH" | "CHECK" | "OTHER";

export type RefundFacts = {
  /** What the family actually paid, fee included. */
  paidCents: number;
  /** The registration's own price (amountDue). Null when it isn't recorded. */
  priceCents: number | null;
  /** Already refunded on this payment. */
  refundedCents: number;
};

const toCents = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
export { toCents as dollarsToCents };

export const centsText = (c: number) => `$${(c / 100).toFixed(2)}`;

/** Build the facts from what is stored. A price above what was paid (a part
 *  payment, a later reprice) can never make a refund bigger than the payment. */
export function refundFacts(input: { amountPaid: unknown; amountDue: unknown; txAmount?: unknown; refundedCents: number }): RefundFacts {
  const regPaid = toCents(input.amountPaid) ?? 0;
  const tx = toCents(input.txAmount);
  // The smaller of the two: never more than the registration says they paid,
  // never more than the payment itself.
  const paidCents = Math.max(0, tx != null && tx > 0 ? Math.min(regPaid, tx) : regPaid);
  const due = toCents(input.amountDue);
  return {
    paidCents,
    priceCents: due != null && due > 0 ? Math.min(due, paidCents) : null,
    refundedCents: Math.max(0, Math.min(input.refundedCents, paidCents)),
  };
}

export const refundLeft = (f: RefundFacts) => Math.max(0, f.paidCents - f.refundedCents);
/** The card processing fee they paid on top of the price. 0 when there wasn't one, or the price isn't recorded. */
export const refundFee = (f: RefundFacts) => (f.priceCents == null ? 0 : Math.max(0, f.paidCents - f.priceCents));

export type RefundOption = { mode: RefundMode; label: string; note: string; cents: number };

/**
 * What the sheet offers, in order; the first is the default. "Event price
 * only" is left out when the price isn't recorded or is already all refunded,
 * and "Everything paid" when it would be the same number as the price.
 */
export function refundOptions(f: RefundFacts): RefundOption[] {
  const left = refundLeft(f);
  if (left <= 0) return [];
  const out: RefundOption[] = [];
  const fee = refundFee(f);
  const priceLeft = f.priceCents == null ? 0 : Math.min(left, Math.max(0, f.priceCents - f.refundedCents));
  if (priceLeft > 0) {
    out.push({
      mode: "price",
      label: "Event price only",
      note: fee > 0 ? `Keeps the ${centsText(fee)} card processing fee.` : "There was no card processing fee on this payment.",
      cents: priceLeft,
    });
  }
  if (priceLeft !== left) {
    out.push({
      mode: "all",
      label: f.refundedCents > 0 ? "Everything left" : "Everything paid",
      note: fee > 0 ? `Includes the ${centsText(fee)} card processing fee.` : "The whole payment.",
      cents: left,
    });
  }
  out.push({ mode: "custom", label: "Custom amount", note: `Anything up to ${centsText(left)}.`, cents: left });
  return out;
}

export type ResolvedRefund = { ok: true; cents: number; full: boolean } | { ok: false; error: string };

/** The amount a choice means. The server runs this again on its own facts. */
export function resolveRefund(mode: RefundMode, customCents: number | null, f: RefundFacts): ResolvedRefund {
  const left = refundLeft(f);
  if (left <= 0) return { ok: false, error: "This payment has already been refunded in full." };
  let cents: number;
  if (mode === "custom") {
    if (customCents == null || !Number.isInteger(customCents) || customCents <= 0) return { ok: false, error: "Enter how much to refund." };
    if (customCents > left) return { ok: false, error: `The most you can refund is ${centsText(left)}.` };
    cents = customCents;
  } else {
    const o = refundOptions(f).find((x) => x.mode === mode);
    if (o) cents = o.cents;
    // "Everything" is hidden when it equals the price, but it still means everything.
    else if (mode === "all") cents = left;
    else return { ok: false, error: f.priceCents == null ? "The event price isn't recorded on this registration. Choose another amount." : "The event price has already been refunded." };
  }
  return { ok: true, cents, full: cents === left };
}

/** "25.50" → 2550. Null for anything that isn't a plain dollar amount. */
export function parseDollars(s: string): number | null {
  const t = s.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

// ── Once, and only once ─────────────────────────────────────────────────────

/**
 * The Stripe idempotency key for the NEXT refund on a registration.
 *
 * The amount is deliberately NOT in it. The key names the state the payment
 * was in ("$0 refunded so far, 1 attempt refused"), so from one state Stripe
 * can create at most one refund:
 *   · the same tap twice            → same key, same body → the SAME refund
 *   · two people, different amounts → same key, different body → Stripe refuses the second
 *   · a later, deliberate refund    → refundedCents moved  → a new key
 *   · a retry after a real refusal  → refusals moved       → a new key
 *
 * The last line is why `refusals` is there at all: Stripe replays a stored
 * refusal for the same key for a day, so "Insufficient funds" would keep
 * coming back long after the club's balance recovered. It only counts answers
 * Stripe definitely gave; an answer we never saw keeps the key.
 */
export function refundIdempotencyKey(registrationId: string, refundedCents: number, refusals: number): string {
  return `aox-evrefund-${registrationId}-${refundedCents}-${refusals}`;
}

/** The sheet says what it thought was already refunded; anything else is stale. */
export function refundIsStale(expectedRefundedCents: number, f: RefundFacts): string | null {
  if (expectedRefundedCents === f.refundedCents) return null;
  return f.refundedCents > expectedRefundedCents
    ? `${centsText(f.refundedCents)} has already been refunded on this payment. Nothing more was sent. Close this and open it again to see what's left.`
    : "This payment changed since you opened it. Nothing was refunded. Close this and open it again.";
}

// ── What went wrong, in plain words ─────────────────────────────────────────

export const LOW_BALANCE_TEXT = "The club's Stripe balance is too low right now. Try again after new payments come in.";

export type RefundFailure = {
  kind: "LOW_BALANCE" | "ALREADY_REFUNDED" | "DISPUTED" | "BUSY" | "REFUSED" | "UNKNOWN";
  text: string;
  /** Stripe definitely said no — nothing moved, and the next try needs a new key. */
  definite: boolean;
};

/** A thrown Stripe error → what to tell staff. Never the raw message or code. */
export function describeRefundError(e: unknown): RefundFailure {
  const err = (e ?? {}) as { type?: unknown; code?: unknown; message?: unknown; statusCode?: unknown };
  const type = String(err.type ?? "");
  const code = String(err.code ?? "");
  const msg = String(err.message ?? "");
  const status = Number(err.statusCode ?? 0);
  if (type === "StripeIdempotencyError" || code === "idempotency_key_in_use" || /idempoten/i.test(msg)) {
    return { kind: "BUSY", definite: false, text: "Another refund on this payment is already going through. Nothing extra was sent. Wait a minute, then open this again." };
  }
  if (code === "balance_insufficient" || code === "insufficient_funds" || /insufficient (available )?funds/i.test(msg)) {
    return { kind: "LOW_BALANCE", definite: true, text: LOW_BALANCE_TEXT };
  }
  if (code === "charge_already_refunded" || /already been refunded/i.test(msg)) {
    return { kind: "ALREADY_REFUNDED", definite: true, text: "Stripe says this payment has already been refunded. Nothing more was sent." };
  }
  if (code === "charge_disputed" || /charged? ?back|disput/i.test(msg)) {
    return { kind: "DISPUTED", definite: true, text: "The family disputed this payment with their bank, so it can't be refunded here. Nothing was refunded." };
  }
  // 4xx = Stripe read the request and said no. Anything else (a dropped
  // connection, a 5xx, a rate limit) may or may not have gone through.
  if (status >= 400 && status < 500 && status !== 429 && status !== 409) {
    return { kind: "REFUSED", definite: true, text: "Stripe didn't accept this refund, so nothing was refunded. Look at the payment in Stripe, or try a different amount." };
  }
  return { kind: "UNKNOWN", definite: false, text: "Stripe didn't answer, so we can't tell yet if the refund went through. Wait a minute and open this again. Trying again won't refund them twice." };
}

// ── Words ───────────────────────────────────────────────────────────────────

export function cardText(card: { brand?: string | null; last4?: string | null } | null | undefined): string | null {
  if (!card?.last4) return null;
  const b = (card.brand ?? "card").replace(/_/g, " ");
  const names: Record<string, string> = { amex: "American Express", mastercard: "Mastercard", visa: "Visa", discover: "Discover", link: "Link" };
  return `${names[b] ?? b.charAt(0).toUpperCase() + b.slice(1)} ending in ${card.last4}`;
}

/** "back to Visa ending in 4242" / "you hand back $60.00 in cash". */
export function refundDestination(via: RefundVia, card: string | null): string {
  if (via === "CARD") return card ? `Goes back to ${card}.` : "Goes back to the card they paid with.";
  if (via === "CHECK") return "They paid by check. Write them a check; this records it.";
  if (via === "CASH") return "They paid in cash. Hand the cash back; this records it.";
  return "They didn't pay by card through AthletixOS. Give the money back yourself; this records it.";
}

/** What a removed registrant's money reads as. `failed` = the latest refund
 *  try was refused and nothing has come back since. */
export function removedRefundLabel(paid: number, refunded: number, failed: boolean): string {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const p = r2(paid);
  const r = r2(Math.min(refunded, paid));
  if (r >= p) return `Removed, refunded $${r.toFixed(2)}`;
  if (r <= 0) return failed ? `Paid $${p.toFixed(2)}, refund failed, not refunded` : `Removed, paid $${p.toFixed(2)}, not refunded`;
  return `Removed, paid $${p.toFixed(2)}, $${r.toFixed(2)} refunded${failed ? ", last refund failed" : ""}`;
}

/** Someone still registered: "Paid $62.11" and what went back. */
export function paidLabel(paid: number, refunded: number, failed: boolean): string {
  const base = `Paid $${paid.toFixed(2)}`;
  if (refunded > 0) return refunded >= paid ? `${base}, refunded in full` : `${base}, $${refunded.toFixed(2)} refunded`;
  return failed ? `${base}, refund failed` : base;
}

/** Audit action names — read back for the key counter and the failed label. */
export const REFUNDED_ACTION = "EVENT_REGISTRATION_REFUNDED";
export const REFUND_FAILED_ACTION = "EVENT_REGISTRATION_REFUND_FAILED";
