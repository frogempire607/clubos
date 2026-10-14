// QuickBooks → AthletixOS history import — the PURE part (2026-10-14).
//
// Input: QuickBooks Online "Transaction List by Date" (or any report with
// Date / Transaction type / Name / Memo / Account / Split / Amount columns),
// exported as CSV or Excel.
//
// The owner maps every QuickBooks account name in the file to one of:
//   BANK      → one of the club's bank accounts (lib/bankAccounts.ts)
//   CATEGORY  → an AthletixOS category (expense, income, or a non-P&L one
//               like Stripe payout / transfer / owner draw)
//   SKIP      → ignore rows that only touch it
// A row is importable when ONE side (Account or Split) is a bank account;
// the other side gives its category.
//
// For each importable row the plan is:
//   MATCH   an existing bank row on that account, same direction and amount,
//           within ±3 days → the QuickBooks category is applied to it ONLY if
//           the owner never categorised that row in AthletixOS
//   CREATE  a new bank row (source QUICKBOOKS) — ONLY when the date is before
//           that account's bank-feed history begins (or the account is kept
//           by hand). An unmatched row inside the feed's history is NOT
//           created: it would double-count; it's listed for the owner instead
//   SKIP    with the reason
// Nothing here touches the database; lib/ledgerImportServer.ts applies it.

export type QbRow = {
  idx: number;
  date: string; // YYYY-MM-DD
  type: string;
  num: string;
  name: string;
  memo: string;
  account: string;
  split: string;
  amount: number; // as printed (sign kept)
};

export type ParsedImport = { rows: QbRow[]; accounts: string[]; types: string[]; problems: string[] };

// ── CSV ─────────────────────────────────────────────────────────────────────

/** RFC 4180-ish: quotes, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  const t = text.replace(/^﻿/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') {
        if (t[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(cell); out.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); out.push(row); }
  return out;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const COLS: Record<keyof Omit<QbRow, "idx">, string[]> = {
  date: ["date", "transaction date", "txn date"],
  type: ["transaction type", "type", "txn type"],
  num: ["num", "no", "number", "ref no", "check no"],
  name: ["name", "payee", "vendor", "customer", "payee name"],
  memo: ["memo description", "memo", "description", "line description"],
  account: ["account", "account full name", "account name", "bank account", "distribution account"],
  split: ["split", "split account", "category"],
  amount: ["amount", "total", "line amount"],
};

/** Money as QuickBooks prints it: "$1,234.56", "-12.00", "(12.00)". */
export function parseMoney(raw: string): number | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s.replace(/[$\s]/g, ""));
  const n = Number(s.replace(/[()$,\s-]/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round((neg ? -n : n) * 100) / 100;
}

/** MM/DD/YYYY, M/D/YY, YYYY-MM-DD → YYYY-MM-DD. */
export function parseQbDate(raw: string): string | null {
  const s = (raw ?? "").trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    const mo = Number(m[1]), d = Number(m[2]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  return null;
}

/** Rows of a QuickBooks report (title lines and totals are skipped). */
export function parseQbTable(table: string[][]): ParsedImport {
  const problems: string[] = [];
  let headerAt = -1;
  let col: Partial<Record<keyof typeof COLS, number>> = {};
  for (let i = 0; i < Math.min(table.length, 30); i++) {
    const cells = table[i].map(norm);
    const found: typeof col = {};
    for (const [key, aliases] of Object.entries(COLS) as [keyof typeof COLS, string[]][]) {
      const at = cells.findIndex((c) => aliases.includes(c));
      if (at >= 0) found[key] = at;
    }
    if (found.date !== undefined && found.amount !== undefined && (found.account !== undefined || found.split !== undefined)) {
      headerAt = i;
      col = found;
      break;
    }
  }
  if (headerAt < 0) {
    return { rows: [], accounts: [], types: [], problems: ["Couldn't find the column headings. Export QuickBooks' “Transaction List by Date” report (it has Date, Transaction type, Name, Memo/Description, Account, Split and Amount)."] };
  }
  const get = (r: string[], k: keyof typeof COLS) => (col[k] === undefined ? "" : (r[col[k]!] ?? "").trim());
  const rows: QbRow[] = [];
  let skipped = 0;
  for (let i = headerAt + 1; i < table.length; i++) {
    const r = table[i];
    if (!r || r.every((c) => !c || !c.trim())) continue;
    const date = parseQbDate(get(r, "date"));
    const amount = parseMoney(get(r, "amount"));
    if (!date || amount === null) { if (r.some((c) => /\d/.test(c)) && !/total/i.test(r.join(" "))) skipped++; continue; }
    rows.push({
      idx: rows.length, date, type: get(r, "type"), num: get(r, "num"), name: get(r, "name"), memo: get(r, "memo"),
      account: get(r, "account"), split: get(r, "split"), amount,
    });
  }
  if (skipped) problems.push(`${skipped} line(s) had no readable date or amount and were left out.`);
  const accounts = Array.from(new Set(rows.flatMap((r) => [r.account, r.split]).filter((a) => a && a !== "-Split-"))).sort();
  const types = Array.from(new Set(rows.map((r) => r.type).filter(Boolean))).sort();
  return { rows, accounts, types, problems };
}

// ── Mapping ─────────────────────────────────────────────────────────────────

export type AccountMap =
  | { kind: "BANK"; bankAccountId: string }
  | { kind: "CATEGORY"; category: string | null } // null = "needs review" in AthletixOS
  | { kind: "SKIP" };
export type Direction = "IN" | "OUT" | "TRANSFER" | "SKIP" | "AUTO";
export type ImportMapping = { accounts: Record<string, AccountMap>; types: Record<string, Direction> };

/** Categories with no P&L meaning — what QuickBooks calls equity / transfers. */
export const SPECIAL_CATEGORIES = [
  { key: "stripe_payout", label: "Stripe / card payout (already counted in AthletixOS)" },
  { key: "TRANSFER", label: "Transfer between our own accounts" },
  { key: "OWNER_DRAW", label: "Owner draw" },
  { key: "OWNER_CONTRIBUTION", label: "Owner contribution" },
  { key: "LOAN_DEPOSIT", label: "Loan received" },
  { key: "LOAN_REPAYMENT", label: "Loan repayment" },
] as const;

const CATEGORY_HINTS: [RegExp, string][] = [
  [/stripe|undeposited|square|paypal|payout|merchant deposit/i, "stripe_payout"],
  [/transfer/i, "TRANSFER"],
  [/owner.*(draw|pay|personal)|draws?\b|distribution/i, "OWNER_DRAW"],
  [/owner.*(invest|contrib|equity)|capital/i, "OWNER_CONTRIBUTION"],
  [/loan|note payable|line of credit/i, "LOAN_REPAYMENT"],
  [/rent|lease/i, "RENT"],
  [/payroll|wages|salar/i, "PAYROLL"],
  [/contract|1099|guest coach/i, "CONTRACTOR"],
  [/advertis|marketing|promotion/i, "MARKETING"],
  [/software|subscription|computer|internet service/i, "SOFTWARE"],
  [/travel|lodging|hotel|airfare|mileage|vehicle|gas|fuel/i, "TRAVEL"],
  [/meal|food|entertain/i, "MEALS"],
  [/insurance/i, "INSURANCE"],
  [/repair|maintenance|cleaning|janitor/i, "MAINTENANCE"],
  [/utilit|electric|water|phone|internet/i, "UTILITIES"],
  [/legal|accounting|professional|bookkeep|tax prep/i, "PROFESSIONAL"],
  [/bank (charge|fee)|service charge|merchant (account )?fee|processing fee|fees?\b/i, "FEES"],
  [/supplies|equipment|material|uniform|gear|merch(andise)? cost|cost of goods/i, "EQUIPMENT"],
  [/tournament|event|clinic|camp/i, "EVENTS"],
  [/membership|dues|tuition/i, "memberships"],
  [/donation|contribution income|grant/i, "donations"],
  [/sponsor/i, "sponsorships"],
  [/sales|services|income|revenue/i, "other_income"],
];

/** A first guess for an account name: one of the bank accounts, else a category. */
export function suggestAccountMap(qbName: string, bankAccounts: { id: string; name: string; mask: string | null }[]): AccountMap {
  const n = qbName.toLowerCase();
  const byMask = bankAccounts.find((b) => b.mask && n.includes(b.mask));
  if (byMask) return { kind: "BANK", bankAccountId: byMask.id };
  const byName = bankAccounts.find((b) => b.name && norm(b.name) && norm(qbName).includes(norm(b.name)));
  if (byName) return { kind: "BANK", bankAccountId: byName.id };
  if (/checking|savings|bank|credit card|visa|mastercard|amex/i.test(qbName) && !/fee|charge/i.test(qbName)) {
    return bankAccounts.length === 1 ? { kind: "BANK", bankAccountId: bankAccounts[0].id } : { kind: "SKIP" };
  }
  if (/uncategori[sz]ed|ask my accountant/i.test(qbName)) return { kind: "CATEGORY", category: null };
  for (const [re, cat] of CATEGORY_HINTS) if (re.test(qbName)) return { kind: "CATEGORY", category: cat };
  return { kind: "CATEGORY", category: null };
}

/** Money in / out / transfer from QuickBooks' transaction type. */
export function directionOfType(type: string): Exclude<Direction, "AUTO"> | null {
  const t = type.toLowerCase();
  if (/transfer|credit card payment/.test(t)) return "TRANSFER";
  if (/deposit|sales receipt|receive payment|^payment$|refund receipt received|interest/.test(t)) return "IN";
  if (/expense|check|bill payment|purchase|cash expense|credit card credit|refund/.test(t)) return /credit card credit/.test(t) ? "IN" : "OUT";
  return null;
}

// ── Plan ────────────────────────────────────────────────────────────────────

export type ExistingBankRow = {
  id: string;
  bankAccountId: string;
  date: string; // YYYY-MM-DD
  amount: number; // Plaid sign: positive = money out
  categoryOverride: string | null;
  reviewed: boolean; // owner already decided on it in AthletixOS
};
export type AccountCoverage = { bankAccountId: string; kind: "PLAID" | "MANUAL"; feedStarts: string | null };

export type PlannedRow = {
  idx: number;
  action: "MATCH" | "CREATE" | "SKIP";
  reason: string;
  bankAccountId: string | null;
  /** Plaid sign: positive = money out. */
  bankAmount: number | null;
  category: string | null;
  transfer: boolean;
  matchedRowId: string | null;
  /** MATCH only: the category will be written (the row was still uncategorised). */
  appliesCategory: boolean;
};

export type ImportPlanSummary = { total: number; match: number; create: number; skip: number; categorised: number; inFeedUnmatched: number };

const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
export const MATCH_DAYS = 3;

export function planImport(input: {
  rows: readonly QbRow[];
  mapping: ImportMapping;
  existing: readonly ExistingBankRow[];
  coverage: readonly AccountCoverage[];
  /** QuickBooks rows already brought in by an earlier import (bank account + date + amount), never re-created. */
  alreadyImported?: readonly { bankAccountId: string; date: string; amount: number }[];
}): { rows: PlannedRow[]; summary: ImportPlanSummary } {
  const cov = new Map(input.coverage.map((c) => [c.bankAccountId, c]));
  const byAccount = new Map<string, ExistingBankRow[]>();
  for (const e of input.existing) {
    const list = byAccount.get(e.bankAccountId) ?? [];
    list.push(e);
    byAccount.set(e.bankAccountId, list);
  }
  const used = new Set<string>();
  const prior = new Set((input.alreadyImported ?? []).map((p) => `${p.bankAccountId}|${p.date}|${p.amount.toFixed(2)}`));
  const out: PlannedRow[] = [];
  const skip = (r: QbRow, reason: string, extra: Partial<PlannedRow> = {}): PlannedRow => ({
    idx: r.idx, action: "SKIP", reason, bankAccountId: null, bankAmount: null, category: null, transfer: false, matchedRowId: null, appliesCategory: false, ...extra,
  });

  for (const r of input.rows) {
    const mA = input.mapping.accounts[r.account];
    const mS = input.mapping.accounts[r.split];
    let bankSide: "account" | "split" | null = null;
    if (mA?.kind === "BANK") bankSide = "account";
    else if (mS?.kind === "BANK") bankSide = "split";
    if (!bankSide) { out.push(skip(r, "Doesn't touch a bank account (e.g. an invoice or journal entry).")); continue; }
    const bankMap = (bankSide === "account" ? mA : mS) as Extract<AccountMap, { kind: "BANK" }>;
    const otherName = bankSide === "account" ? r.split : r.account;
    const other = input.mapping.accounts[otherName];
    if (other?.kind === "SKIP") { out.push(skip(r, `“${otherName}” is set to skip.`)); continue; }
    const typeDir = input.mapping.types[r.type] ?? "AUTO";
    if (typeDir === "SKIP") { out.push(skip(r, `“${r.type}” rows are set to skip.`)); continue; }
    let dir: Exclude<Direction, "AUTO" | "SKIP"> | null = typeDir === "AUTO" ? (directionOfType(r.type) as never) : typeDir;
    // A transfer to another of OUR bank accounts is a transfer whatever its type says.
    if (other?.kind === "BANK") dir = "TRANSFER";
    // QuickBooks prints the amount from the "Account" column's side; when the
    // bank is in "Split" the sign is the other way round for the bank.
    const signedForBank = bankSide === "account" ? r.amount : -r.amount;
    if (!dir || (dir as string) === "SKIP") dir = signedForBank < 0 ? "OUT" : "IN";
    const abs = Math.abs(r.amount);
    if (abs === 0) { out.push(skip(r, "Zero amount.")); continue; }
    // A transfer's direction for THIS bank account: negative on the bank side = out.
    const outward = dir === "OUT" || (dir === "TRANSFER" && signedForBank < 0);
    const bankAmount = outward ? abs : -abs;
    const transfer = dir === "TRANSFER";
    const category = transfer ? "TRANSFER" : other?.kind === "CATEGORY" ? other.category : null;

    const candidates = (byAccount.get(bankMap.bankAccountId) ?? [])
      .filter((e) => !used.has(e.id) && Math.abs(e.amount - bankAmount) < 0.005 && Math.abs(dayDiff(e.date, r.date)) <= MATCH_DAYS)
      .sort((a, b) => Math.abs(dayDiff(a.date, r.date)) - Math.abs(dayDiff(b.date, r.date)));
    const hit = candidates[0];
    if (hit) {
      used.add(hit.id);
      const applies = !hit.reviewed && !hit.categoryOverride && !!category;
      out.push({
        idx: r.idx, action: "MATCH", bankAccountId: bankMap.bankAccountId, bankAmount, category, transfer, matchedRowId: hit.id, appliesCategory: applies,
        reason: applies ? "Matches a bank row — its QuickBooks category will be applied." : hit.reviewed || hit.categoryOverride ? "Matches a bank row you already categorised — left as you set it." : "Matches a bank row.",
      });
      continue;
    }
    const c = cov.get(bankMap.bankAccountId);
    const beforeFeed = !c || c.kind === "MANUAL" || !c.feedStarts || r.date < c.feedStarts;
    if (!beforeFeed) {
      out.push(skip(r, "No matching bank row, but the bank feed already covers this date — not imported so nothing is counted twice. Check it in the Bank tab.", { bankAccountId: bankMap.bankAccountId, bankAmount, category }));
      continue;
    }
    if (prior.has(`${bankMap.bankAccountId}|${r.date}|${bankAmount.toFixed(2)}`)) {
      out.push(skip(r, "Already brought in by an earlier import.", { bankAccountId: bankMap.bankAccountId, bankAmount, category }));
      continue;
    }
    out.push({
      idx: r.idx, action: "CREATE", bankAccountId: bankMap.bankAccountId, bankAmount, category, transfer, matchedRowId: null, appliesCategory: false,
      reason: category ? "Before the bank feed begins — added as history." : "Before the bank feed begins — added as history, needs a category.",
    });
  }
  const summary: ImportPlanSummary = {
    total: out.length,
    match: out.filter((p) => p.action === "MATCH").length,
    create: out.filter((p) => p.action === "CREATE").length,
    skip: out.filter((p) => p.action === "SKIP").length,
    categorised: out.filter((p) => (p.action === "MATCH" && p.appliesCategory) || (p.action === "CREATE" && !!p.category)).length,
    inFeedUnmatched: out.filter((p) => p.action === "SKIP" && p.reason.startsWith("No matching bank row")).length,
  };
  return { rows: out, summary };
}
