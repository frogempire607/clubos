// Accounting Phase 3 — the QuickBooks opening balance, as a PURE module.
//
// No prisma, no next, no clock. lib/glOpeningServer.ts reads and writes;
// everything decided here is a function of its arguments and proven by
// scripts/gl-opening-tests.ts.
//
// ── What this does ──────────────────────────────────────────────────────────
// A club leaving QuickBooks has a trial balance on the day before its
// AthletixOS books start. That trial balance IS the opening position, and one
// journal entry per legal entity, dated that day, is how it gets onto the
// ledger. After that, Phase 2's posting engine carries on from live activity.
//
// Frog Empire's books start 2027-01-01, so its opening entry is dated
// 2026-12-31 (Julian, Phase 3 decision).
//
// ── Income and expense balances roll into retained earnings ─────────────────
// A QuickBooks trial balance taken mid-life carries income and expense
// balances for the year to date. Those are not an opening position for a new
// set of books — they are history, and their net is what the owners have
// earned and not taken out. So every income and expense line is collapsed into
// ONE retained-earnings figure rather than opening a revenue account with a
// balance, which would make the new books' first P&L include last year's
// trading.
//
// ── It must balance, and it refuses rather than plugging ────────────────────
// A trial balance that does not balance is a broken export or a mis-mapping,
// and the honest response is to say so. Writing a balancing plug to Opening
// Balance Equity would hide the problem inside the one number nobody audits.

import { parseMoney } from "@/lib/ledgerImport";

// ── Parsing ─────────────────────────────────────────────────────────────────

export type TrialBalanceRow = {
  idx: number;
  /// The account name exactly as QuickBooks printed it. This is the mapping
  /// key, so it is kept verbatim — trimmed, never normalised.
  account: string;
  debitCents: number;
  creditCents: number;
};

export type ParsedTrialBalance = {
  rows: TrialBalanceRow[];
  /// Distinct account names, in the order they appeared.
  accounts: string[];
  totalDebitCents: number;
  totalCreditCents: number;
  balanced: boolean;
  problems: string[];
};

const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/// Column aliases. QuickBooks prints "Trial Balance" with Debit and Credit
/// columns; some exports and most hand-made spreadsheets use one signed
/// Amount or Balance column instead, so both shapes are read.
const COLS = {
  account: ["account", "account name", "account full name", "name", "accounts"],
  debit: ["debit", "debits", "dr"],
  credit: ["credit", "credits", "cr"],
  amount: ["amount", "balance", "total", "ending balance"],
};

/// Rows QuickBooks prints that are not accounts. A subtotal counted as an
/// account would double everything under it.
const SKIP_ROW = /^(total|totals|total for|net income|net revenue|net loss|grand total)\b/i;

export function parseTrialBalance(table: string[][]): ParsedTrialBalance {
  const problems: string[] = [];
  let headerAt = -1;
  let col: { account?: number; debit?: number; credit?: number; amount?: number } = {};

  // QuickBooks puts the club name, the report name and the date above the
  // headings, so the first 30 rows are scanned rather than assuming row 0.
  for (let i = 0; i < Math.min(table.length, 30); i += 1) {
    const cells = (table[i] ?? []).map(norm);
    const found: typeof col = {};
    for (const [key, aliases] of Object.entries(COLS) as [keyof typeof COLS, string[]][]) {
      const at = cells.findIndex((c) => aliases.includes(c));
      if (at >= 0) found[key] = at;
    }
    if (found.account !== undefined && (found.debit !== undefined || found.credit !== undefined || found.amount !== undefined)) {
      headerAt = i;
      col = found;
      break;
    }
  }

  if (headerAt === -1) {
    return {
      rows: [],
      accounts: [],
      totalDebitCents: 0,
      totalCreditCents: 0,
      balanced: false,
      problems: [
        'Couldn\'t find the column headings. Export QuickBooks\' "Trial Balance" report as CSV or Excel — it needs an Account column and either Debit and Credit columns or a single signed Amount column.',
      ],
    };
  }

  const rows: TrialBalanceRow[] = [];
  const seen: string[] = [];
  let skippedSubtotals = 0;

  for (let i = headerAt + 1; i < table.length; i += 1) {
    const cells = table[i] ?? [];
    const account = (cells[col.account ?? 0] ?? "").trim();
    if (!account) continue;
    if (SKIP_ROW.test(account)) {
      skippedSubtotals += 1;
      continue;
    }

    let debitCents = 0;
    let creditCents = 0;

    if (col.debit !== undefined || col.credit !== undefined) {
      const d = col.debit !== undefined ? parseMoney(cells[col.debit] ?? "") : null;
      const c = col.credit !== undefined ? parseMoney(cells[col.credit] ?? "") : null;
      // A negative in the Debit column means a credit, which is how some
      // exports print a contra balance.
      const dv = Math.round((d ?? 0) * 100);
      const cv = Math.round((c ?? 0) * 100);
      debitCents = dv > 0 ? dv : 0;
      creditCents = cv > 0 ? cv : 0;
      if (dv < 0) creditCents += -dv;
      if (cv < 0) debitCents += -cv;
    } else if (col.amount !== undefined) {
      const a = parseMoney(cells[col.amount] ?? "");
      if (a === null) continue;
      const cents = Math.round(a * 100);
      // Signed single-column convention: positive is a debit.
      if (cents >= 0) debitCents = cents;
      else creditCents = -cents;
    }

    if (debitCents === 0 && creditCents === 0) continue;
    rows.push({ idx: i, account, debitCents, creditCents });
    if (!seen.includes(account)) seen.push(account);
  }

  const totalDebitCents = rows.reduce((s, r) => s + r.debitCents, 0);
  const totalCreditCents = rows.reduce((s, r) => s + r.creditCents, 0);
  if (rows.length === 0) problems.push("No account balances were found below the headings.");
  if (skippedSubtotals > 0) {
    problems.push(
      `${skippedSubtotals} subtotal or total ${skippedSubtotals === 1 ? "row was" : "rows were"} skipped — counting those would double the accounts under them.`,
    );
  }

  return {
    rows,
    accounts: seen,
    totalDebitCents,
    totalCreditCents,
    balanced: totalDebitCents === totalCreditCents,
    problems,
  };
}

// ── Mapping ─────────────────────────────────────────────────────────────────

export type TargetAccount = {
  id: string;
  number: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
};

/// `null` means SKIP: the row is deliberately left out of the opening entry.
/// Skipping unbalances the import, which is correct — a skipped balance has to
/// be accounted for somewhere, and the import refuses until it is.
export type OpeningMapping = Record<string, string | null>;

/// Suggest an AthletixOS account for a QuickBooks account name.
///
/// Three passes, most confident first: an exact normalised name match, then a
/// leading account number in the QuickBooks name ("1000 · Checking" is how
/// QuickBooks prints a numbered chart), then the best token overlap. A
/// suggestion below the confidence floor returns null rather than a guess —
/// the owner mapping twelve accounts by hand is a far better outcome than one
/// silently wrong mapping inside a balanced-looking import.
export function suggestTarget(qbName: string, accounts: TargetAccount[]): string | null {
  const q = norm(qbName);
  if (!q) return null;

  const exact = accounts.find((a) => norm(a.name) === q);
  if (exact) return exact.id;

  const leadingNumber = qbName.trim().match(/^(\d{3,6})\b/);
  if (leadingNumber) {
    const byNumber = accounts.find((a) => a.number === leadingNumber[1]);
    if (byNumber) return byNumber.id;
  }

  // QuickBooks sub-accounts print as "Parent:Child" or "Parent · Child"; the
  // leaf is the meaningful part.
  const leaf = norm(qbName.split(/[:·]/).pop() ?? qbName);
  const leafExact = accounts.find((a) => norm(a.name) === leaf);
  if (leafExact) return leafExact.id;

  const qTokens = new Set(leaf.split(" ").filter((t) => t.length > 2));
  if (qTokens.size === 0) return null;

  let best: { id: string; score: number } | null = null;
  for (const a of accounts) {
    const aTokens = new Set(norm(a.name).split(" ").filter((t) => t.length > 2));
    if (aTokens.size === 0) continue;
    let hits = 0;
    for (const t of qTokens) if (aTokens.has(t)) hits += 1;
    // Jaccard-ish: shared tokens over the union, so "Rent" matching "Rent"
    // beats "Rent" matching "Rent Deposit Equipment Insurance".
    const score = hits / (qTokens.size + aTokens.size - hits);
    if (hits > 0 && (!best || score > best.score)) best = { id: a.id, score };
  }
  // Half the tokens shared. Below that the suggestion is noise, and a wrong
  // suggestion the owner accepts is worse than no suggestion at all.
  return best && best.score >= 0.5 ? best.id : null;
}

export function suggestMapping(accounts: string[], targets: TargetAccount[]): OpeningMapping {
  const out: OpeningMapping = {};
  for (const name of accounts) out[name] = suggestTarget(name, targets);
  return out;
}

// ── The plan ────────────────────────────────────────────────────────────────

export type OpeningLine = {
  accountId: string;
  debitCents: number;
  creditCents: number;
  memo: string | null;
};

export type OpeningPlan = {
  lines: OpeningLine[];
  /// Income and expense balances, collapsed. Positive = the club had earned
  /// more than it spent, so retained earnings is a credit.
  retainedEarningsCents: number;
  /// Accounts the mapping leaves out, with their balances — so the reason the
  /// import doesn't balance is visible rather than mysterious.
  skipped: { account: string; debitCents: number; creditCents: number }[];
  /// QuickBooks names with no mapping decision at all.
  unmapped: string[];
  totalDebitCents: number;
  totalCreditCents: number;
  differenceCents: number;
  balanced: boolean;
};

/// Build the opening entry's lines.
///
/// One line per AthletixOS account, because several QuickBooks accounts often
/// map to one of ours ("Checking" and "Checking - old" both going to 1000) and
/// two lines on the same account in one entry reads as a mistake.
export function planOpeningEntry(
  parsed: ParsedTrialBalance,
  mapping: OpeningMapping,
  targets: TargetAccount[],
  retainedEarningsAccountId: string,
): OpeningPlan {
  const byId = new Map(targets.map((t) => [t.id, t]));
  const net = new Map<string, number>(); // accountId → net debit cents
  const skipped: OpeningPlan["skipped"] = [];
  const unmapped: string[] = [];
  let retainedEarningsCents = 0;

  for (const row of parsed.rows) {
    const target = Object.prototype.hasOwnProperty.call(mapping, row.account)
      ? mapping[row.account]
      : undefined;

    if (target === undefined) {
      if (!unmapped.includes(row.account)) unmapped.push(row.account);
      continue;
    }
    if (target === null) {
      skipped.push({ account: row.account, debitCents: row.debitCents, creditCents: row.creditCents });
      continue;
    }
    const account = byId.get(target);
    if (!account) {
      if (!unmapped.includes(row.account)) unmapped.push(row.account);
      continue;
    }

    const netDebit = row.debitCents - row.creditCents;

    // Income and expenses are history, not an opening position — collapse
    // them. Credit-positive: income credits add to earnings, expense debits
    // subtract, which is one subtraction for both classes.
    if (account.type === "INCOME" || account.type === "EXPENSE") {
      retainedEarningsCents += -netDebit;
      continue;
    }
    net.set(target, (net.get(target) ?? 0) + netDebit);
  }

  if (retainedEarningsCents !== 0) {
    net.set(
      retainedEarningsAccountId,
      (net.get(retainedEarningsAccountId) ?? 0) + -retainedEarningsCents,
    );
  }

  const lines: OpeningLine[] = [];
  for (const [accountId, netDebit] of net) {
    if (netDebit === 0) continue;
    const a = byId.get(accountId);
    lines.push({
      accountId,
      debitCents: netDebit > 0 ? netDebit : 0,
      creditCents: netDebit < 0 ? -netDebit : 0,
      memo: a ? `Opening balance — ${a.number} ${a.name}` : "Opening balance",
    });
  }
  lines.sort((x, y) => {
    const ax = byId.get(x.accountId)?.number ?? "";
    const ay = byId.get(y.accountId)?.number ?? "";
    return ax.localeCompare(ay, "en", { numeric: true });
  });

  const totalDebitCents = lines.reduce((s, l) => s + l.debitCents, 0);
  const totalCreditCents = lines.reduce((s, l) => s + l.creditCents, 0);
  const differenceCents = totalDebitCents - totalCreditCents;

  return {
    lines,
    retainedEarningsCents,
    skipped,
    unmapped,
    totalDebitCents,
    totalCreditCents,
    differenceCents,
    balanced: differenceCents === 0,
  };
}

export type OpeningBlocker = { code: string; message: string };

/// Everything that must be true before an opening entry can post. Returned as
/// a list rather than thrown one at a time, so the owner sees every problem at
/// once instead of fixing five things in five round trips.
export function openingBlockers(input: {
  booksStartDate: string | null;
  asOfDate: string | null;
  lockedThrough: string | null;
  hasClosedMonth: boolean;
  plan: OpeningPlan;
  parsed: ParsedTrialBalance;
}): OpeningBlocker[] {
  const out: OpeningBlocker[] = [];

  if (!input.booksStartDate) {
    out.push({
      code: "NO_BOOKS_START_DATE",
      message:
        "Set the books start date first (Overview → Books). The opening balance is dated the day before it, so without it there is no date to use.",
    });
  }

  if (input.asOfDate && input.lockedThrough && input.asOfDate <= input.lockedThrough) {
    out.push({
      code: "LOCKED",
      message: `The opening date ${input.asOfDate} is on or before the lock date ${input.lockedThrough}, so nothing can be posted there. Reopen that period first, or move the lock date back.`,
    });
  }

  if (input.hasClosedMonth) {
    out.push({
      code: "MONTH_CLOSED",
      message:
        "A month has already been closed, so the opening balance can no longer be replaced — changing it now would change statements that have already been signed off. Post a correcting journal entry instead.",
    });
  }

  if (input.plan.unmapped.length > 0) {
    out.push({
      code: "UNMAPPED",
      message: `${input.plan.unmapped.length} QuickBooks ${input.plan.unmapped.length === 1 ? "account has" : "accounts have"} no mapping yet: ${input.plan.unmapped.slice(0, 5).join(", ")}${input.plan.unmapped.length > 5 ? "…" : ""}`,
    });
  }

  if (!input.parsed.balanced) {
    out.push({
      code: "FILE_UNBALANCED",
      message: `The file itself doesn't balance — debits ${input.parsed.totalDebitCents / 100} against credits ${input.parsed.totalCreditCents / 100}. That is a broken export, not a mapping problem. Re-export the trial balance.`,
    });
  }

  if (!input.plan.balanced) {
    const skippedTotal = input.plan.skipped.reduce(
      (s, r) => s + Math.abs(r.debitCents - r.creditCents),
      0,
    );
    out.push({
      code: "PLAN_UNBALANCED",
      message:
        `The opening entry doesn't balance — it is out by ${Math.abs(input.plan.differenceCents) / 100}.` +
        (skippedTotal > 0
          ? ` ${input.plan.skipped.length} skipped ${input.plan.skipped.length === 1 ? "account carries" : "accounts carry"} ${skippedTotal / 100}; map them to something, or map them to an equity account if they genuinely belong there.`
          : " Check the mapping — nothing is being skipped, so two accounts are probably mapped to the same place with opposite signs."),
    });
  }

  if (input.plan.lines.length === 0 && input.parsed.rows.length > 0) {
    out.push({
      code: "NOTHING_TO_POST",
      message: "Every row is skipped or nets to zero, so there is nothing to post.",
    });
  }

  return out;
}

/// The day before the books start — the opening entry's date.
///
/// UTC arithmetic, never a locally-parsed Date: an opening balance landing a
/// day out would put it inside the first period instead of before it, and
/// every statement would then include it twice over.
export function openingDateFor(booksStartDate: string): string {
  const d = new Date(`${booksStartDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function openingSourceId(importId: string, legalEntityId: string | null): string {
  return `${importId}:${legalEntityId ?? "none"}`;
}
