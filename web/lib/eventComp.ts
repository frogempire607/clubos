// Event payroll — the single model for compensating people who work an event
// (staff or guest clinicians). PURE: constants + math only, no prisma/IO, so
// tests and any surface can share the exact rules.
//
// The money rules (owner-approved 2026-07-17):
//   GROSS_COLLECTED = money actually collected — after discounts (amounts are
//     what payers really paid), after refunds/chargebacks, before processing
//     fees. Pending cash/check, failed and abandoned payments never count.
//   NET_COLLECTED   = gross minus known processing fees (stripeFeeAmount).
//     Offline cash/check rows have no fee, so they count equally in both.
//   compNoRefunds   = the owner's strict no-refunds policy: percent comp is
//     computed as if no refund/chargeback ever happened.
//
// Refunds reduce the basis via Transaction.refundedAmount, maintained by the
// charge.refunded / charge.dispute.created webhooks — do NOT assume filtering
// on SUCCEEDED excludes refunded money (a partially-refunded row stays
// SUCCEEDED on purpose).

export const COMP_METHODS = ["FLAT", "PERCENT", "NONE"] as const;
export type CompMethod = (typeof COMP_METHODS)[number];

export const COMP_METHOD_LABELS: Record<CompMethod, string> = {
  FLAT: "Flat payment",
  PERCENT: "% of event revenue",
  NONE: "No compensation (informational)",
};

export const COMP_BASES = ["GROSS_COLLECTED", "NET_COLLECTED"] as const;
export type CompBasis = (typeof COMP_BASES)[number];

export const COMP_BASIS_LABELS: Record<CompBasis, string> = {
  GROSS_COLLECTED: "Gross collected (after discounts & refunds, before fees)",
  NET_COLLECTED: "Net collected (gross minus processing fees)",
};

export const COMP_PAYEE_TYPES = ["STAFF", "CONTRACTOR"] as const;
export type CompPayeeType = (typeof COMP_PAYEE_TYPES)[number];

/**
 * The Transaction facts revenue math needs. Money fields accept whatever the
 * source hands over (number | Prisma Decimal | string) — everything is coerced
 * through Number() so Decimal rows can be passed straight in.
 */
export type CompTxn = {
  status: string;
  reconciliationStatus?: string | null;
  amount: number | string | { toString(): string };
  refundedAmount?: number | string | { toString(): string } | null;
  stripeFeeAmount?: number | string | { toString(): string } | null;
};

export type CollectedRevenue = {
  gross: number;
  net: number;
  refunded: number;
  fees: number;
  countedTransactions: number;
};

/**
 * Collected revenue for a set of event transactions.
 *
 * Included: SUCCEEDED rows, plus REFUNDED rows (fully-refunded — they
 * contribute amount − refunded, i.e. ~0, unless ignoreRefunds). Excluded
 * entirely: PENDING (cash/check not yet received), FAILED, VOID rows, and
 * REVIEW rows (flagged duplicates awaiting a human — counting them would pay
 * a percentage on money that's about to be refunded).
 */
export function collectedRevenue(
  txns: CompTxn[],
  opts?: { ignoreRefunds?: boolean },
): CollectedRevenue {
  const ignoreRefunds = !!opts?.ignoreRefunds;
  let gross = 0;
  let refunded = 0;
  let fees = 0;
  let counted = 0;
  for (const t of txns) {
    if (t.status !== "SUCCEEDED" && t.status !== "REFUNDED") continue;
    const recon = t.reconciliationStatus ?? null;
    if (recon === "VOID" || recon === "REVIEW") continue;
    const amount = Number(t.amount as number) || 0;
    // A fully-refunded row may predate refundedAmount tracking — status alone
    // must still zero it out.
    const rawRefund =
      t.refundedAmount != null ? Number(t.refundedAmount as number) || 0 : t.status === "REFUNDED" ? amount : 0;
    const refund = Math.min(Math.max(rawRefund, 0), amount);
    const kept = ignoreRefunds ? amount : amount - refund;
    gross += kept;
    refunded += refund;
    // Stripe keeps its fee on refund, so the fee always reduces net in full.
    fees += Number(t.stripeFeeAmount as number) || 0;
    counted++;
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    gross: round(Math.max(gross, 0)),
    net: round(Math.max(gross - fees, 0)),
    refunded: round(refunded),
    fees: round(fees),
    countedTransactions: counted,
  };
}

export type CompAssignmentInput = {
  compMethod: string;
  flatAmount?: number | null;
  percent?: number | null;
  basis?: string | null;
};

/**
 * What one assignment is owed given the event's collected revenue.
 * null = nothing to pay (informational assignment).
 */
export function computePayoutAmount(
  a: CompAssignmentInput,
  revenue: Pick<CollectedRevenue, "gross" | "net">,
): number | null {
  if (a.compMethod === "NONE") return null;
  if (a.compMethod === "FLAT") {
    const amt = Number(a.flatAmount) || 0;
    return amt > 0 ? Math.round(amt * 100) / 100 : null;
  }
  if (a.compMethod === "PERCENT") {
    const pct = Number(a.percent) || 0;
    if (!(pct > 0)) return null;
    const base = a.basis === "NET_COLLECTED" ? revenue.net : revenue.gross;
    const amt = (Math.min(pct, 100) / 100) * base;
    return Math.round(amt * 100) / 100;
  }
  return null;
}

/** One-line human explanation for the payout record / preview. */
export function payoutBasisNote(
  a: CompAssignmentInput,
  revenue: CollectedRevenue,
  eventName: string,
  opts?: { ignoreRefunds?: boolean },
): string {
  if (a.compMethod === "FLAT") return `Flat payment for ${eventName}.`;
  if (a.compMethod === "PERCENT") {
    const basis = a.basis === "NET_COLLECTED" ? "net collected" : "gross collected";
    const base = a.basis === "NET_COLLECTED" ? revenue.net : revenue.gross;
    return (
      `${Number(a.percent) || 0}% of ${basis} revenue for ${eventName} ` +
      `($${base.toFixed(2)} across ${revenue.countedTransactions} payment${revenue.countedTransactions === 1 ? "" : "s"}` +
      (opts?.ignoreRefunds
        ? "; refunds ignored per the event's no-refunds policy)"
        : revenue.refunded > 0
          ? `; $${revenue.refunded.toFixed(2)} of refunds already deducted)`
          : ")")
    );
  }
  return `Worked ${eventName} (informational).`;
}
