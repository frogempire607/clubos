// Accounting Phase 2, task 7 — the reconciliation arithmetic, PURE.
//
// No prisma, no next. lib/glReconcileServer.ts does the I/O; these are the
// rules, and scripts/gl-posting-tests.ts proves them without a database.

export { isValidDateOnly, formatCents } from "@/lib/ledger";

/// A line's effect on the account's balance, signed in the account's OWN
/// normal direction — which is what a statement shows.
///
/// A debit-normal account (checking) goes up on a debit. A credit-normal
/// account (a card) goes up on a credit, so a $50 purchase on a card is +50 to
/// the balance you owe. Getting this backwards flips every card reconciliation,
/// which is why it lives in one function instead of being inlined.
export function signedBalanceOf(normalBalance: string, debitCents: number, creditCents: number): number {
  return normalBalance === "DEBIT" ? debitCents - creditCents : creditCents - debitCents;
}

/// statementEnding − clearedBalance. Finish is allowed only at exactly 0.
export function differenceOf(statementEndingCents: number, clearedBalanceCents: number): number {
  return statementEndingCents - clearedBalanceCents;
}

/// Can this reconciliation be finished?
///
/// Deliberately strict: exactly zero, no tolerance. A "close enough"
/// reconciliation is not a reconciliation — the whole value of the exercise is
/// that the last penny is accounted for.
export function canFinish(status: string, differenceCents: number): boolean {
  return status === "OPEN" && differenceCents === 0;
}

/// Why finishing is refused, in words an owner can act on.
export function finishBlockedReason(status: string, differenceCents: number): string | null {
  if (status === "FINISHED") return "That statement is already reconciled.";
  if (differenceCents === 0) return null;
  const off = Math.abs(differenceCents);
  const dir = differenceCents > 0 ? "more than the ledger" : "less than the ledger";
  return (
    `The statement says $${(off / 100).toFixed(2)} ${dir}. ` +
    "Tick the lines that cleared, add anything missing, or re-check the ending balance you typed."
  );
}

/// The last day of the month a date falls in, as "YYYY-MM-DD" — the default
/// statement end most banks use.
export function monthEnd(isoDate: string): string {
  const [y, m] = isoDate.split("-").map(Number);
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/// The first day of the same month.
export function monthStart(isoDate: string): string {
  return `${isoDate.slice(0, 7)}-01`;
}

/// The reconciliation summary a report header shows.
export type ReconcileSummary = {
  openingClearedCents: number;
  clearedCount: number;
  unclearedCount: number;
  clearedBalanceCents: number;
  statementEndingCents: number;
  differenceCents: number;
  balanced: boolean;
};

export function summarise(
  lines: { cleared: boolean; signedCents: number }[],
  openingClearedCents: number,
  statementEndingCents: number,
): ReconcileSummary {
  const clearedLines = lines.filter((l) => l.cleared);
  const clearedBalanceCents = openingClearedCents + clearedLines.reduce((s, l) => s + l.signedCents, 0);
  const differenceCents = differenceOf(statementEndingCents, clearedBalanceCents);
  return {
    openingClearedCents,
    clearedCount: clearedLines.length,
    unclearedCount: lines.length - clearedLines.length,
    clearedBalanceCents,
    statementEndingCents,
    differenceCents,
    balanced: differenceCents === 0,
  };
}
