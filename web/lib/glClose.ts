// Accounting Phase 3 — the month-close checklist, as a PURE module.
//
// No prisma, no next, no clock. lib/glCloseServer.ts gathers the facts;
// everything decided here is a function of them.
//
// ── What a close IS ─────────────────────────────────────────────────────────
// Closing a month sets the lock date for one legal entity to the last day of
// that month, which makes the Phase 1 ledger service refuse any entry dated on
// or before it. That is the whole mechanism — there is no separate "closed"
// flag the ledger consults, because two sources of truth for "can I post to
// January?" would eventually disagree.
//
// The checklist is a SNAPSHOT, stored on the close row. It records what was
// true at the moment the month was closed, which is the question an auditor
// asks six months later. Recomputing it live would answer a different and
// less useful question.
//
// Reopening restores the lock date the entity had BEFORE the close, rather
// than clearing it — a club that closed December and then January must get
// December's lock back when it reopens January, not an unlocked year.

export const CHECK_KEYS = [
  "reconciled",
  "nothingWaiting",
  "noUncategorized",
  "undepositedReviewed",
  "depreciationPosted",
] as const;
export type CheckKey = (typeof CHECK_KEYS)[number];

export type CloseFacts = {
  /// Bank and card accounts that have no FINISHED reconciliation for this
  /// month, by name. Empty means every one of them is reconciled.
  unreconciledAccounts: string[];
  /// How many bank/card accounts exist at all. Zero changes the message from
  /// "reconcile these" to "there is nothing to reconcile".
  reconcilableCount: number;
  /// Source records dated in this month that would post but haven't. From a
  /// DRY RUN of the real posting sweep, so it cannot disagree with it.
  waitingToPost: number;
  /// Bank rows in this month with no category.
  uncategorizedBankRows: number;
  /// The Undeposited Funds balance at month end, in cents.
  undepositedCents: number;
  /// Whether somebody has ticked "I've reviewed undeposited funds". A non-zero
  /// 1020 balance is not itself wrong — cash really can be in the drawer over
  /// a month end — so this needs a human, not a rule.
  undepositedAcknowledged: boolean;
  /// Months of depreciation due on or before this month that are not posted.
  depreciationDue: number;
};

export type CheckResult = {
  key: CheckKey;
  label: string;
  ok: boolean;
  detail: string;
  /// A failing blocking check stops the close. All five block — a close is a
  /// statement that the month is finished, and "finished except for the bank
  /// reconciliation" is not a thing a CPA can use.
  blocking: boolean;
};

export type Checklist = {
  items: CheckResult[];
  ready: boolean;
  blockers: string[];
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function evaluateChecklist(f: CloseFacts): Checklist {
  const items: CheckResult[] = [
    {
      key: "reconciled",
      label: "Every bank and card account is reconciled for this month",
      ok: f.unreconciledAccounts.length === 0,
      detail:
        f.reconcilableCount === 0
          ? "No bank or card accounts are linked, so there is nothing to reconcile."
          : f.unreconciledAccounts.length === 0
            ? `All ${plural(f.reconcilableCount, "account", "accounts")} reconciled.`
            : `Still to reconcile: ${f.unreconciledAccounts.join(", ")}.`,
      blocking: true,
    },
    {
      key: "nothingWaiting",
      label: "Nothing is waiting to post",
      ok: f.waitingToPost === 0,
      detail:
        f.waitingToPost === 0
          ? "Every payment, refund, payout and expense in this month is on the ledger."
          : `${plural(f.waitingToPost, "record", "records")} would post. Run "Post anything waiting" first.`,
      blocking: true,
    },
    {
      key: "noUncategorized",
      label: "No bank rows are left uncategorised",
      ok: f.uncategorizedBankRows === 0,
      detail:
        f.uncategorizedBankRows === 0
          ? "Every bank row in this month has a category."
          : `${plural(f.uncategorizedBankRows, "bank row", "bank rows")} still need a category. An uncategorised row never posts, so closing now would leave this month permanently short.`,
      blocking: true,
    },
    {
      key: "undepositedReviewed",
      label: "Undeposited funds reviewed",
      // A zero balance needs no tick: there is nothing to review.
      ok: f.undepositedCents === 0 || f.undepositedAcknowledged,
      detail:
        f.undepositedCents === 0
          ? "Nothing sitting in Undeposited Funds."
          : f.undepositedAcknowledged
            ? "Reviewed — the balance is cash genuinely still on hand."
            : "There is money in Undeposited Funds at month end. That is fine if the cash really is in the drawer, and wrong if a deposit was never recorded — so somebody has to say which.",
      blocking: true,
    },
    {
      key: "depreciationPosted",
      label: "Depreciation is posted",
      ok: f.depreciationDue === 0,
      detail:
        f.depreciationDue === 0
          ? "No depreciation is outstanding for this month or any month before it."
          : `${plural(f.depreciationDue, "month", "months")} of depreciation is unposted. Post it before closing, or this month's profit is overstated.`,
      blocking: true,
    },
  ];

  const blockers = items.filter((i) => i.blocking && !i.ok).map((i) => i.label);
  return { items, ready: blockers.length === 0, blockers };
}

// ── Months ──────────────────────────────────────────────────────────────────

/// Date-only first of the month a `YYYY-MM` key names.
export function periodStart(monthKey: string): string {
  return `${monthKey}-01`;
}

/// The last day of the month — and the lock date a close sets.
export function periodEnd(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  if (!y || !m) return `${monthKey}-01`;
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export function isValidMonthKey(v: string): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) return false;
  const y = Number(v.slice(0, 4));
  return y >= 2000 && y <= 2100;
}

export function monthLabel(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  if (!y || !m) return monthKey;
  return new Date(y, m - 1, 15).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/// The lock date a close should set: the later of this month's end and the
/// lock the entity already has.
///
/// Closing an EARLIER month than one already closed must not move the lock
/// backwards — that would silently reopen everything in between. So a close
/// out of order raises the lock only if it would go forwards, and
/// `closeWouldUnlock` lets the caller warn instead of doing it quietly.
export function lockDateForClose(monthKey: string, currentLock: string | null): string {
  const end = periodEnd(monthKey);
  return currentLock && currentLock > end ? currentLock : end;
}

export function closeWouldUnlock(monthKey: string, currentLock: string | null): boolean {
  return !!currentLock && currentLock > periodEnd(monthKey);
}

/// Whether a month is already covered by the entity's lock date — in which
/// case entries can't be posted into it whether or not a close row exists.
export function monthIsLocked(monthKey: string, currentLock: string | null): boolean {
  return !!currentLock && currentLock >= periodEnd(monthKey);
}

export type ReopenCheck = { ok: boolean; reason?: string };

/// Reopening is owner-only (enforced in the route), needs a reason, and is
/// audited. The reason is not ceremony: a reopened month means every statement
/// already handed to a CPA may now change, and the only way anybody finds out
/// why is if somebody wrote it down.
export function validateReopen(reason: string): ReopenCheck {
  const trimmed = reason.trim();
  if (trimmed.length < 10) {
    return {
      ok: false,
      reason:
        "Say why this month is being reopened, in a sentence. Whoever reads the books later needs to know what changed after they were closed.",
    };
  }
  if (trimmed.length > 500) return { ok: false, reason: "Keep the reason under 500 characters." };
  return { ok: true };
}
