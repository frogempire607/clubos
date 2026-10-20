// Accounting Phase 1 — the double-entry rules, as a PURE module.
//
// No prisma, no next, no I/O. Everything here is a function of its arguments,
// so scripts/ledger-tests.ts can prove the rules without a database — and the
// build gate runs those tests with DATABASE_URL pointed at a dead address.
//
// lib/ledgerServer.ts is the only module that writes a gl_* table, and it
// enforces every rule below before it does. Plan: docs/accounting/plan.md.
//
// ── MONEY IS INTEGER CENTS ──────────────────────────────────────────────────
// Deliberately unlike the Decimal(10,2) the rest of the app uses for money. A
// ledger must never see a rounding artifact, and integer cents make
// "debits === credits" an exact integer comparison rather than a tolerance
// check. A 32-bit signed int caps one line at $21,474,836.47; aggregates are
// summed as JS numbers, exact to 2^53 cents (~$90 trillion).

export type AccountType = "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
export type NormalBalance = "DEBIT" | "CREDIT";

export const ACCOUNT_TYPES: AccountType[] = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"];

/// Accounts the posting engine must find by identity rather than by number or
/// name — because a club may rename them and Phase 2 still has to post to the
/// right one. A system account can be renamed but never deactivated.
export type SystemAccountKey =
  | "STRIPE_CLEARING"
  | "DUE_TO"
  | "DUE_FROM"
  | "OPENING_BALANCE_EQUITY"
  | "RETAINED_EARNINGS";

export const SYSTEM_ACCOUNT_KEYS: SystemAccountKey[] = [
  "STRIPE_CLEARING",
  "DUE_TO",
  "DUE_FROM",
  "OPENING_BALANCE_EQUITY",
  "RETAINED_EARNINGS",
];

/// Human labels for the five classes, in the order a balance sheet and P&L
/// read. Used by the Chart of Accounts tab.
export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  ASSET: "Assets",
  LIABILITY: "Liabilities",
  EQUITY: "Equity",
  INCOME: "Income",
  EXPENSE: "Expenses",
};

/// `subtype` on an EXPENSE account. Cost of sales is its own section on a P&L
/// (it produces the gross-profit line) but it is an expense for every other
/// purpose, so it is a subtype rather than a sixth type — the five accounting
/// classes are what every balance-sheet/P&L classifier keys on.
export const COST_OF_SALES = "COST_OF_SALES";

// ── Chart of accounts template ──────────────────────────────────────────────

export type ChartTemplateRow = {
  number: string;
  name: string;
  type: AccountType;
  normalBalance: NormalBalance;
  subtype?: string;
  isContra?: boolean;
  isSystem?: boolean;
  systemKey?: SystemAccountKey;
  description?: string;
};

/// The sports-club template, seeded into every eligible club and then fully
/// theirs: renameable, extensible, deactivatable (except system accounts).
///
/// Order here IS the display order — `sortOrder` is the array index within a
/// type, so inserting a row shifts only the rows after it in the same section.
export const CHART_TEMPLATE: ChartTemplateRow[] = [
  // ── Assets ────────────────────────────────────────────────────────────────
  { number: "1000", name: "Operating Checking", type: "ASSET", normalBalance: "DEBIT" },
  { number: "1010", name: "Savings", type: "ASSET", normalBalance: "DEBIT" },
  {
    number: "1050",
    name: "Stripe Clearing",
    type: "ASSET",
    normalBalance: "DEBIT",
    isSystem: true,
    systemKey: "STRIPE_CLEARING",
    description:
      "Money Stripe has taken from a payer but not yet paid out to the bank. A payout moves it from here to the bank account.",
  },
  { number: "1100", name: "Accounts Receivable", type: "ASSET", normalBalance: "DEBIT" },
  { number: "1300", name: "Prepaid Expenses", type: "ASSET", normalBalance: "DEBIT" },
  {
    number: "1400",
    name: "Due From Related Entity",
    type: "ASSET",
    normalBalance: "DEBIT",
    isSystem: true,
    systemKey: "DUE_FROM",
    description: "What another of your entities owes this one. Created automatically on an entry that spans two entities.",
  },
  { number: "1500", name: "Training Equipment", type: "ASSET", normalBalance: "DEBIT" },
  { number: "1520", name: "Furniture & Fixtures", type: "ASSET", normalBalance: "DEBIT" },
  { number: "1530", name: "Leasehold Improvements", type: "ASSET", normalBalance: "DEBIT" },
  {
    number: "1590",
    name: "Accumulated Depreciation",
    type: "ASSET",
    normalBalance: "CREDIT",
    isContra: true,
    description: "Contra-asset: reduces the book value of the assets above.",
  },

  // ── Liabilities ───────────────────────────────────────────────────────────
  { number: "2000", name: "Accounts Payable", type: "LIABILITY", normalBalance: "CREDIT" },
  {
    number: "2100",
    name: "Credit Cards",
    type: "LIABILITY",
    normalBalance: "CREDIT",
    description: "Add a sub-account per card.",
  },
  {
    number: "2200",
    name: "Deferred Revenue",
    type: "LIABILITY",
    normalBalance: "CREDIT",
    description: "Money collected for membership time or a camp that has not happened yet.",
  },
  { number: "2300", name: "Sales Tax Payable", type: "LIABILITY", normalBalance: "CREDIT" },
  { number: "2400", name: "Payroll Liabilities", type: "LIABILITY", normalBalance: "CREDIT" },
  {
    number: "2500",
    name: "Due To Related Entity",
    type: "LIABILITY",
    normalBalance: "CREDIT",
    isSystem: true,
    systemKey: "DUE_TO",
    description: "What this entity owes another of your entities. Created automatically on an entry that spans two entities.",
  },
  { number: "2700", name: "Loans Payable", type: "LIABILITY", normalBalance: "CREDIT" },

  // ── Equity ────────────────────────────────────────────────────────────────
  { number: "3000", name: "Owner / Partner Capital", type: "EQUITY", normalBalance: "CREDIT" },
  { number: "3100", name: "Owner Contributions", type: "EQUITY", normalBalance: "CREDIT" },
  { number: "3200", name: "Owner Distributions", type: "EQUITY", normalBalance: "DEBIT" },
  {
    number: "3900",
    name: "Retained Earnings",
    type: "EQUITY",
    normalBalance: "CREDIT",
    isSystem: true,
    systemKey: "RETAINED_EARNINGS",
    description: "Accumulated profit from prior years.",
  },
  {
    number: "3950",
    name: "Opening Balance Equity",
    type: "EQUITY",
    normalBalance: "CREDIT",
    isSystem: true,
    systemKey: "OPENING_BALANCE_EQUITY",
    description: "The balancing account for imported opening balances. Should be zero once the import is reconciled.",
  },

  // ── Income ────────────────────────────────────────────────────────────────
  { number: "4000", name: "Membership Revenue", type: "INCOME", normalBalance: "CREDIT" },
  { number: "4100", name: "Camps & Clinics", type: "INCOME", normalBalance: "CREDIT" },
  { number: "4200", name: "Events & Tournaments", type: "INCOME", normalBalance: "CREDIT" },
  { number: "4300", name: "Private Lessons", type: "INCOME", normalBalance: "CREDIT" },
  { number: "4400", name: "Merchandise Sales", type: "INCOME", normalBalance: "CREDIT" },
  { number: "4500", name: "Drop-ins & Trials", type: "INCOME", normalBalance: "CREDIT" },
  { number: "4600", name: "Sponsorships", type: "INCOME", normalBalance: "CREDIT" },
  { number: "4700", name: "Donations", type: "INCOME", normalBalance: "CREDIT" },
  {
    number: "4800",
    name: "Processing Fees Recovered",
    type: "INCOME",
    normalBalance: "CREDIT",
    description:
      "The processing-fee gross-up when the club passes fees to the payer. Keeps the sticker price in its own revenue account.",
  },
  {
    number: "4900",
    name: "Refunds & Discounts",
    type: "INCOME",
    normalBalance: "DEBIT",
    isContra: true,
    description: "Contra-revenue: reduces income rather than appearing as an expense.",
  },
  { number: "4950", name: "Other Income", type: "INCOME", normalBalance: "CREDIT" },

  // ── Cost of sales (EXPENSE with a COST_OF_SALES subtype) ──────────────────
  { number: "5000", name: "Merchandise Cost", type: "EXPENSE", normalBalance: "DEBIT", subtype: COST_OF_SALES },
  {
    number: "5100",
    name: "Event Costs",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    subtype: COST_OF_SALES,
    description: "Awards, officials, venue.",
  },

  // ── Expenses ──────────────────────────────────────────────────────────────
  { number: "6000", name: "Rent", type: "EXPENSE", normalBalance: "DEBIT" },
  { number: "6050", name: "Utilities", type: "EXPENSE", normalBalance: "DEBIT" },
  { number: "6100", name: "Staff Payroll", type: "EXPENSE", normalBalance: "DEBIT" },
  { number: "6110", name: "Contract Coaches (1099)", type: "EXPENSE", normalBalance: "DEBIT" },
  { number: "6150", name: "Payroll Taxes", type: "EXPENSE", normalBalance: "DEBIT" },
  { number: "6200", name: "Insurance", type: "EXPENSE", normalBalance: "DEBIT" },
  { number: "6250", name: "Equipment & Supplies", type: "EXPENSE", normalBalance: "DEBIT" },
  { number: "6300", name: "Repairs & Maintenance", type: "EXPENSE", normalBalance: "DEBIT" },
  { number: "6350", name: "Software & Subscriptions", type: "EXPENSE", normalBalance: "DEBIT" },
  { number: "6400", name: "Payment Processing Fees", type: "EXPENSE", normalBalance: "DEBIT" },
  { number: "6450", name: "Bank Fees", type: "EXPENSE", normalBalance: "DEBIT" },
  { number: "6500", name: "Marketing & Advertising", type: "EXPENSE", normalBalance: "DEBIT" },
  { number: "6550", name: "Travel & Competition Fees", type: "EXPENSE", normalBalance: "DEBIT" },
  { number: "6600", name: "Professional Fees", type: "EXPENSE", normalBalance: "DEBIT" },
  { number: "6650", name: "Licenses, Dues & Sanctioning", type: "EXPENSE", normalBalance: "DEBIT" },
  { number: "6700", name: "Office Expenses", type: "EXPENSE", normalBalance: "DEBIT" },
  { number: "6750", name: "Meals", type: "EXPENSE", normalBalance: "DEBIT" },
  { number: "6800", name: "Depreciation Expense", type: "EXPENSE", normalBalance: "DEBIT" },
  { number: "6900", name: "Miscellaneous", type: "EXPENSE", normalBalance: "DEBIT" },
  { number: "7000", name: "Interest Expense", type: "EXPENSE", normalBalance: "DEBIT" },
];

/// Template rows carrying a systemKey, by key. Used by the seed to assert the
/// template never loses a system account.
export function templateSystemRows(): Record<SystemAccountKey, ChartTemplateRow> {
  const out = {} as Record<SystemAccountKey, ChartTemplateRow>;
  for (const row of CHART_TEMPLATE) if (row.systemKey) out[row.systemKey] = row;
  return out;
}

/// `sortOrder` for a template row = its index within its own type, spaced by
/// 10 so a club can insert an account between two seeded ones.
export function templateSortOrder(): Map<string, number> {
  const perType = new Map<AccountType, number>();
  const out = new Map<string, number>();
  for (const row of CHART_TEMPLATE) {
    const n = perType.get(row.type) ?? 0;
    out.set(row.number, n * 10);
    perType.set(row.type, n + 1);
  }
  return out;
}

// ── Category mapping ────────────────────────────────────────────────────────
// A mapping LAYER over lib/financials.ts, not a rename. Those keys and labels
// are untouched; this is read when Phase 2 posts a transaction or an expense.
//
// The full table, with the three mappings flagged for Julian's review, is in
// docs/accounting/plan.md. Keep the two in step.

/// Revenue category (lib/financials REVENUE_CATEGORIES) → income account number.
export const REVENUE_CATEGORY_TO_ACCOUNT: Record<string, string> = {
  memberships: "4000",
  // A class drop-in is arguably 4500 Drop-ins & Trials, but this key also
  // covers membership-covered class bookings, and sending those to 4500 would
  // inflate drop-in revenue. FLAGGED FOR REVIEW in plan.md.
  classes: "4000",
  events: "4200",
  camps_clinics: "4100",
  private_lessons: "4300",
  products: "4400",
  donations: "4700",
  sponsorships: "4600",
  // These two describe HOW money arrived, not what was sold, so neither can be
  // mapped to a revenue account honestly. 4950 keeps the books balanced and the
  // row visible for recategorization. Phase 2 should prefer the transaction's
  // `type` via resolveRevenueCategory before falling back to these.
  manual_invoice: "4950",
  cash_payment: "4950",
  other_income: "4950",
};

/// Where an uncategorized revenue row goes. Never dropped — an unmapped dollar
/// that silently posts nowhere is the failure this whole feature exists to end.
export const REVENUE_FALLBACK_ACCOUNT = "4950";

/// Expense category (lib/financials EXPENSE_CATEGORIES) → expense account.
export const EXPENSE_CATEGORY_TO_ACCOUNT: Record<string, string> = {
  RENT: "6000",
  PAYROLL: "6100",
  CONTRACTOR: "6110",
  EQUIPMENT: "6250",
  SOFTWARE: "6350",
  MARKETING: "6500",
  TRAVEL: "6550",
  MEALS: "6750",
  INSURANCE: "6200",
  MAINTENANCE: "6300",
  UTILITIES: "6050",
  PROFESSIONAL: "6600",
  // The label is "Bank / Processing fees" and conflates both. Phase 2 posts
  // Stripe fees to 6400 specifically, so the manual category goes there too and
  // one account stays authoritative. FLAGGED FOR REVIEW in plan.md.
  FEES: "6400",
  EVENTS: "5100",
  OTHER: "6900",
};

export const EXPENSE_FALLBACK_ACCOUNT = "6900";

/// Payment method (lib/financials PAYMENT_METHODS) → the balance-sheet account
/// the money landed in. Phase 2 uses this to pick the debit side of a money-in
/// entry. `null` means "do not post" — a comped attendance is not revenue and
/// never has been, so it must not manufacture a journal entry.
export const PAYMENT_METHOD_TO_ACCOUNT: Record<string, string | null> = {
  STRIPE: "1050",
  CARD: "1050",
  // NOTE for Phase 2: cash physically sits in a drawer before it is deposited,
  // which a true "1020 Undeposited Funds" account would model. The template
  // (fixed by the brief) has no such account, and it only matters once
  // automatic posting starts — listed as a Phase 2 blocker in plan.md.
  CASH: "1000",
  CHECK: "1000",
  BANK: "1000",
  INVOICE: "1100",
  COMP: null,
  OTHER: "1000",
};

export function accountForRevenueCategory(key: string | null | undefined): string {
  if (!key) return REVENUE_FALLBACK_ACCOUNT;
  return REVENUE_CATEGORY_TO_ACCOUNT[key] ?? REVENUE_FALLBACK_ACCOUNT;
}

export function accountForExpenseCategory(key: string | null | undefined): string {
  if (!key) return EXPENSE_FALLBACK_ACCOUNT;
  return EXPENSE_CATEGORY_TO_ACCOUNT[key] ?? EXPENSE_FALLBACK_ACCOUNT;
}

/// `undefined` = unknown method (treat as OTHER); `null` = deliberately no
/// posting (COMP). The two are different answers and the caller must not
/// collapse them.
export function accountForPaymentMethod(key: string | null | undefined): string | null {
  if (!key) return PAYMENT_METHOD_TO_ACCOUNT.OTHER;
  if (!(key in PAYMENT_METHOD_TO_ACCOUNT)) return PAYMENT_METHOD_TO_ACCOUNT.OTHER;
  return PAYMENT_METHOD_TO_ACCOUNT[key];
}

// ── Entry validation ────────────────────────────────────────────────────────

/// The shape a caller hands the service. Accounts are referenced by id; the
/// service resolves them and passes the resolved set to the validators.
export type DraftLine = {
  accountId: string;
  debitCents: number;
  creditCents: number;
  legalEntityId?: string | null;
  program?: string | null;
  memo?: string | null;
  memberId?: string | null;
};

export type DraftEntry = {
  /// "YYYY-MM-DD". Date-only on purpose: an accounting date has no time.
  entryDate: string;
  memo?: string | null;
  legalEntityId?: string | null;
  reference?: string | null;
  sourceType?: string;
  sourceId?: string | null;
  lines: DraftLine[];
};

/// What the validator needs to know about an account. A subset of GlAccount so
/// the rules stay testable without the Prisma types.
export type AccountFact = {
  id: string;
  number: string;
  name: string;
  type: AccountType | string;
  active: boolean;
  isSystem: boolean;
  systemKey?: string | null;
};

export type EntryTotals = { debitCents: number; creditCents: number; differenceCents: number; balanced: boolean };

/// Debits, credits, and whether they match to the cent. Also what the UI's
/// live balance indicator calls — one definition, so the indicator can never
/// disagree with what the server will accept.
export function entryTotals(lines: Pick<DraftLine, "debitCents" | "creditCents">[]): EntryTotals {
  let debitCents = 0;
  let creditCents = 0;
  for (const l of lines) {
    debitCents += Number(l.debitCents) || 0;
    creditCents += Number(l.creditCents) || 0;
  }
  return {
    debitCents,
    creditCents,
    differenceCents: debitCents - creditCents,
    balanced: debitCents === creditCents,
  };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/// True for a "YYYY-MM-DD" string that names a real calendar day. Rejects
/// 2026-02-30 and 2026-13-01, which `new Date()` would silently roll over.
export function isValidDateOnly(s: string): boolean {
  if (!DATE_ONLY.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/// Every reason an entry can be refused, as readable messages. Empty array =
/// acceptable. The service runs this and refuses on ANY entry — it never
/// "fixes" a draft silently, because a ledger that corrects your arithmetic
/// without telling you is worse than one that rejects it.
export function validateEntryDraft(draft: DraftEntry, accounts: AccountFact[]): string[] {
  const errors: string[] = [];
  const byId = new Map(accounts.map((a) => [a.id, a]));

  if (!draft.entryDate || !isValidDateOnly(draft.entryDate)) {
    errors.push("Pick a date for this entry (YYYY-MM-DD).");
  }

  const lines = Array.isArray(draft.lines) ? draft.lines : [];
  if (lines.length === 0) {
    errors.push("An entry needs at least two lines — one debit and one credit.");
    return errors; // nothing else is meaningful without lines
  }
  if (lines.length < 2) {
    errors.push("An entry needs at least two lines — one debit and one credit.");
  }

  lines.forEach((l, i) => {
    const n = i + 1;
    const acct = byId.get(l.accountId);
    if (!l.accountId) {
      errors.push(`Line ${n}: choose an account.`);
    } else if (!acct) {
      errors.push(`Line ${n}: that account doesn't exist in this club's chart of accounts.`);
    } else if (!acct.active) {
      errors.push(`Line ${n}: "${acct.number} ${acct.name}" is inactive. Reactivate it or pick another account.`);
    }

    const d = l.debitCents;
    const c = l.creditCents;
    for (const [label, v] of [
      ["debit", d],
      ["credit", c],
    ] as const) {
      if (!Number.isFinite(v)) {
        errors.push(`Line ${n}: ${label} isn't a number.`);
      } else if (!Number.isInteger(v)) {
        errors.push(`Line ${n}: ${label} must be a whole number of cents.`);
      } else if (v < 0) {
        errors.push(`Line ${n}: ${label} can't be negative — a negative debit is a credit.`);
      }
    }

    // Both sides is the rule worth being strict about: it hides a netting
    // decision that belongs in two explicit lines.
    if (Number.isInteger(d) && Number.isInteger(c) && d > 0 && c > 0) {
      errors.push(`Line ${n}: a line can have a debit or a credit, not both. Split it into two lines.`);
    }
    if (Number.isInteger(d) && Number.isInteger(c) && d === 0 && c === 0) {
      errors.push(`Line ${n}: enter a debit or a credit.`);
    }
  });

  const totals = entryTotals(lines);
  if (totals.debitCents === 0 && totals.creditCents === 0) {
    errors.push("This entry is for $0.00. Enter the amounts.");
  } else if (!totals.balanced) {
    errors.push(
      `Debits and credits must match. Debits ${formatCents(totals.debitCents)}, credits ${formatCents(
        totals.creditCents,
      )} — off by ${formatCents(Math.abs(totals.differenceCents))}.`,
    );
  }

  return errors;
}

// ── Lock dates ─────────────────────────────────────────────────────────────

/// Entries dated ON or BEFORE `lockedThrough` are refused. Inclusive on
/// purpose: "locked through March 31" has to mean March 31 itself is closed,
/// or a month-end entry slips into a closed period.
export function isDateLocked(entryDate: string, lockedThrough: string | null | undefined): boolean {
  if (!lockedThrough) return false;
  if (!isValidDateOnly(entryDate) || !isValidDateOnly(lockedThrough)) return false;
  return entryDate <= lockedThrough; // ISO date strings compare lexicographically
}

/// The message a refused write returns. Named so the route, the UI and the
/// tests all say the same thing.
export function lockedMessage(entityName: string, lockedThrough: string): string {
  return `The books for ${entityName} are closed through ${lockedThrough}. An owner can move the lock date to post here.`;
}

// ── Intercompany ───────────────────────────────────────────────────────────

export type EntityNet = { legalEntityId: string | null; debitCents: number; creditCents: number; netCents: number };

/// Per-entity debit/credit totals. `netCents > 0` means that entity's lines
/// carry more debits than credits.
export function netByEntity(lines: DraftLine[]): EntityNet[] {
  const acc = new Map<string | null, { d: number; c: number }>();
  for (const l of lines) {
    const k = l.legalEntityId ?? null;
    const cur = acc.get(k) ?? { d: 0, c: 0 };
    cur.d += Number(l.debitCents) || 0;
    cur.c += Number(l.creditCents) || 0;
    acc.set(k, cur);
  }
  return [...acc.entries()].map(([legalEntityId, v]) => ({
    legalEntityId,
    debitCents: v.d,
    creditCents: v.c,
    netCents: v.d - v.c,
  }));
}

/// True when the entry's lines name more than one distinct legal entity.
/// A single entity — even `null` — is not intercompany.
export function spansMultipleEntities(lines: DraftLine[]): boolean {
  const seen = new Set(lines.map((l) => l.legalEntityId ?? null));
  return seen.size > 1;
}

/// The balancing Due To / Due From lines for an entry that spans entities.
///
/// THE RULE: each entity's own lines must balance, or that entity's books don't
/// stand alone. For every entity with a non-zero net:
///
///   net DEBIT  (debits > credits) → that entity received value, so it OWES
///                                 → credit 2500 Due To Related Entity
///   net CREDIT (credits > debits) → that entity gave value, so it IS OWED
///                                 → debit  1400 Due From Related Entity
///
/// The derived lines sum to zero by construction (the nets of a balanced entry
/// sum to zero), so the entry stays balanced. Returns [] when the entry touches
/// one entity, or when every entity already balances on its own.
///
/// `dueToAccountId` / `dueFromAccountId` are resolved by the caller from
/// systemKey, never by number — a club may have renumbered them.
export function deriveIntercompanyLines(
  lines: DraftLine[],
  opts: {
    dueToAccountId: string;
    dueFromAccountId: string;
    /// For the memo. Missing names degrade to "another entity" rather than
    /// failing — a readable memo is not worth refusing a correct entry over.
    entityNames?: Record<string, string>;
  },
): DraftLine[] {
  if (!spansMultipleEntities(lines)) return [];

  const nets = netByEntity(lines).filter((n) => n.netCents !== 0);
  if (nets.length === 0) return [];

  const nameOf = (id: string | null) => (id && opts.entityNames?.[id]) || "another entity";
  const counterpart = (self: string | null) => {
    const others = nets.filter((n) => n.legalEntityId !== self);
    return others.length === 1 ? nameOf(others[0].legalEntityId) : "related entities";
  };

  const out: DraftLine[] = [];
  // Stable order: by entity id, nulls last — so the same draft always produces
  // the same lines in the same order (tests, and a readable journal).
  const ordered = [...nets].sort((a, b) => {
    if (a.legalEntityId === b.legalEntityId) return 0;
    if (a.legalEntityId === null) return 1;
    if (b.legalEntityId === null) return -1;
    return a.legalEntityId < b.legalEntityId ? -1 : 1;
  });

  for (const n of ordered) {
    const amount = Math.abs(n.netCents);
    if (n.netCents > 0) {
      // More debits than credits → this entity owes the other.
      out.push({
        accountId: opts.dueToAccountId,
        debitCents: 0,
        creditCents: amount,
        legalEntityId: n.legalEntityId,
        memo: `Due to ${counterpart(n.legalEntityId)}`,
      });
    } else {
      // More credits than debits → this entity is owed.
      out.push({
        accountId: opts.dueFromAccountId,
        debitCents: amount,
        creditCents: 0,
        legalEntityId: n.legalEntityId,
        memo: `Due from ${counterpart(n.legalEntityId)}`,
      });
    }
  }
  return out;
}

// ── Void / reversal ────────────────────────────────────────────────────────

/// A posted entry is voided by a REVERSING entry, never a delete: every debit
/// becomes a credit and vice versa. The audit trail and every prior report stay
/// true, which is the whole point.
export function reverseLines(lines: DraftLine[]): DraftLine[] {
  return lines.map((l) => ({
    ...l,
    debitCents: l.creditCents,
    creditCents: l.debitCents,
  }));
}

/// The date a reversal posts on.
///
/// Normally the original's date, so the reversal lands in the same period and
/// the period nets to zero. But if that period is CLOSED, posting there would
/// change a closed period's numbers — so it posts `today` instead. This is the
/// standard accounting treatment and it is why a void can succeed on an entry
/// whose own date is locked.
export function reversalDate(originalDate: string, lockedThrough: string | null | undefined, today: string): string {
  if (!isDateLocked(originalDate, lockedThrough)) return originalDate;
  // The original's period is closed. If today is somehow also locked, the
  // caller must refuse — we return today and let the service check again.
  return today;
}

// ── Display helpers ───────────────────────────────────────────────────────

/// Cents → "$1,234.56". Negative renders as "-$1,234.56".
export function formatCents(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const s = (abs / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${neg ? "-" : ""}$${s}`;
}

/// A typed dollar amount → integer cents, or null when it isn't a number.
/// Rounds to the nearest cent: "10.005" is 1001, not 1000.5. Accepts "$1,234.56".
export function parseDollarsToCents(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined || input === "") return null;
  const s = String(input).replace(/[$,\s]/g, "");
  if (!/^-?\d*\.?\d*$/.test(s) || s === "" || s === "-" || s === ".") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/// Does increasing this account show as a debit? Drives the Chart of Accounts
/// tab's "increases with" column.
export function increasesWithDebit(type: AccountType | string, isContra = false): boolean {
  const base = type === "ASSET" || type === "EXPENSE";
  return isContra ? !base : base;
}
