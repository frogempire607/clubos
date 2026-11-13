// When a family pays for a membership by CARD checkout, any cash/check request
// still waiting for the same plan is finished business: leaving it open means
// the front desk later "collects" cash for a month the card already paid.
//
// PURE — no prisma. The decisions live here so they can be tested; the writes
// are in lib/offlineSupersedeServer.ts.
//
// Three things can be waiting, and each has its own test:
//   1. a MEMBERSHIP_PURCHASE approval ("I'd like this plan, I'll pay cash")
//      the club has not answered yet;
//   2. an offline membership row that was accepted but never paid for;
//   3. the PENDING cash/check Transaction that says how much is owed for it.

const OFFLINE = new Set(["CASH", "CHECK"]);
const DAY = 86_400_000;

/** 1 — a waiting cash/check request for THIS plan. A card request, or one for another plan, is left alone. */
export function approvalSupersededByCard(payload: unknown, membershipId: string): boolean {
  const p = (payload ?? {}) as { membershipId?: unknown; paymentMethod?: unknown };
  if (typeof p.membershipId !== "string" || p.membershipId !== membershipId) return false;
  return OFFLINE.has(String(p.paymentMethod ?? "").toUpperCase());
}

export type OfflineRowFacts = {
  id: string; membershipId: string; status: string; billingType: string | null; stripeSubscriptionId: string | null;
  price: number; paidThroughDate: Date | null; createdAt: Date;
};
export type PendingTxFacts = {
  id: string; amount: number; status: string; manual: boolean; category: string | null;
  paymentSource: string | null; paymentMethod: string | null; createdAt: Date;
};

/** 3 — an unpaid cash/check amount-due row for a membership. */
export function isPendingOfflineMembershipTx(t: PendingTxFacts): boolean {
  if (t.status !== "PENDING" || !t.manual) return false;
  if ((t.category ?? "") !== "memberships") return false;
  return OFFLINE.has((t.paymentSource ?? "").toUpperCase()) || OFFLINE.has((t.paymentMethod ?? "").toUpperCase());
}

/**
 * "The same membership and period": the amount due belongs to this offline row
 * when it is for the row's price and was raised while the row existed (a day of
 * slack — the two are written seconds apart, sometimes across midnight UTC).
 * An older debt for an earlier month is NOT this period and is never touched.
 */
export function txBelongsToRow(t: PendingTxFacts, row: OfflineRowFacts): boolean {
  if (!isPendingOfflineMembershipTx(t)) return false;
  if (Math.abs(t.amount - row.price) > 0.005) return false;
  return t.createdAt.getTime() >= row.createdAt.getTime() - DAY;
}

export type SupersedePlan = { cancelRowIds: string[]; voidTxIds: string[] };

/**
 * 2 + 3 — which offline rows and amount-due rows the card payment replaces.
 *
 *  · Only rows on the SAME plan, never the row the card just paid for.
 *  · Only rows with NO money behind them: never a Stripe row, never one with a
 *    paid-through date. A cash membership somebody actually paid for is real
 *    and is not ours to end.
 *  · A row still `pending` (waiting for its first cash) is always replaced.
 *  · A row already `active` (the club activates on acceptance) is replaced only
 *    when its amount due is still sitting there unpaid — that open request is
 *    the evidence nobody paid for it.
 */
export function supersedePlan(input: { membershipId: string; paidSubscriptionId: string; rows: OfflineRowFacts[]; pendingTxs: PendingTxFacts[] }): SupersedePlan {
  const cancelRowIds: string[] = [];
  const voidTx = new Set<string>();
  for (const row of input.rows) {
    if (row.id === input.paidSubscriptionId) continue;
    if (row.membershipId !== input.membershipId) continue;
    if (row.stripeSubscriptionId || (row.billingType ?? "") !== "MANUAL") continue;
    if (row.paidThroughDate) continue;
    const owed = input.pendingTxs.filter((t) => !voidTx.has(t.id) && txBelongsToRow(t, row));
    if (row.status === "pending" || (row.status === "active" && row.price > 0 && owed.length > 0)) {
      cancelRowIds.push(row.id);
      for (const t of owed) voidTx.add(t.id);
    }
  }
  return { cancelRowIds, voidTxIds: Array.from(voidTx) };
}

export const SUPERSEDED_NOTE = "Closed automatically — the family paid for this membership by card instead.";
