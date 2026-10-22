// Accounting Phase 3 — the fixed-asset register and straight-line
// depreciation, as a PURE module.
//
// No prisma, no next, no clock. lib/glAssetsServer.ts reads and writes;
// everything decided here is a function of its arguments and proven by
// scripts/gl-close-tests.ts.
//
// ── Idempotency is STRUCTURAL, not a check somebody remembers ───────────────
// Depreciation posts through the Phase 1 ledger service with
//   sourceType "DEPRECIATION", sourceId "<assetId>:<YYYY-MM>"
// and gl_journal_entries has a unique index on (clubId, sourceType, sourceId).
// So "once per asset per month" is enforced by Postgres. Re-running a close,
// clicking the button twice, or two sessions racing all land on the same
// unique violation, which the caller treats as success. That is why there is
// no depreciation-schedule table: a table would be a second place for the
// truth to live, and it would drift.

import { formatCents } from "@/lib/ledger";

export type AssetStatus = "ACTIVE" | "DISPOSED";

export type FixedAsset = {
  id: string;
  name: string;
  costCents: number;
  /// Date-only `YYYY-MM-DD`.
  inServiceDate: string;
  usefulLifeMonths: number;
  salvageValueCents: number;
  legalEntityId: string | null;
  assetAccountId: string;
  accumDepAccountId: string;
  depExpenseAccountId: string;
  status: AssetStatus;
  disposedDate: string | null;
};

export type DraftAsset = {
  name: string;
  costCents: number;
  inServiceDate: string;
  usefulLifeMonths: number;
  salvageValueCents: number;
};

/// The depreciable amount: what the asset will lose over its life.
export function depreciableBaseCents(a: Pick<FixedAsset, "costCents" | "salvageValueCents">): number {
  return a.costCents - a.salvageValueCents;
}

export function validateAsset(a: DraftAsset): string[] {
  const errs: string[] = [];
  if (!a.name.trim()) errs.push("Give the asset a name.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.inServiceDate)) errs.push("Pick the date it was placed in service (YYYY-MM-DD).");
  if (!Number.isInteger(a.costCents) || a.costCents <= 0) errs.push("Cost must be more than zero.");
  if (!Number.isInteger(a.usefulLifeMonths) || a.usefulLifeMonths <= 0) {
    errs.push("Useful life must be at least one month.");
  }
  if (a.usefulLifeMonths > 1200) errs.push("Useful life over 100 years is almost certainly a typo.");
  if (!Number.isInteger(a.salvageValueCents) || a.salvageValueCents < 0) {
    errs.push("Salvage value can't be negative.");
  }
  if (a.salvageValueCents > a.costCents) {
    errs.push("Salvage value can't be more than the asset cost — it would depreciate upwards.");
  }
  return errs;
}

/// The first month depreciation is taken: the month the asset was placed in
/// service, in full.
///
/// A convention has to be picked, and this is the one small clubs and their
/// CPAs expect. The alternatives (mid-month, half-year) are tax conventions
/// that belong on the return, not in the books — and the CPA adjusts them
/// there. Stated on screen so nobody has to guess which one this is.
export function firstDepreciationMonth(a: Pick<FixedAsset, "inServiceDate">): string {
  return a.inServiceDate.slice(0, 7);
}

export function addMonths(monthKey: string, n: number): string {
  const [y, m] = monthKey.split("-").map(Number);
  if (!y || !m) return monthKey;
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

/// The last month depreciation is taken.
export function lastDepreciationMonth(a: Pick<FixedAsset, "inServiceDate" | "usefulLifeMonths">): string {
  return addMonths(firstDepreciationMonth(a), a.usefulLifeMonths - 1);
}

export type ScheduleRow = { monthKey: string; amountCents: number; accumulatedCents: number };

/// The whole straight-line schedule, month by month.
///
/// ROUNDING: the monthly charge is the depreciable base divided by the life,
/// truncated to whole cents, and the FINAL month absorbs the remainder. So the
/// schedule's total is exactly cost minus salvage — never a cent over, which
/// would depreciate the asset past its salvage value, and never a cent under,
/// which would leave a stub balance on the books forever. For $1,000 over 3
/// months that is 333, 333, 334.
export function depreciationSchedule(
  a: Pick<FixedAsset, "costCents" | "salvageValueCents" | "usefulLifeMonths" | "inServiceDate">,
): ScheduleRow[] {
  const base = depreciableBaseCents(a);
  const months = a.usefulLifeMonths;
  if (base <= 0 || months <= 0) return [];
  const per = Math.floor(base / months);
  const rows: ScheduleRow[] = [];
  let accumulated = 0;
  let monthKey = firstDepreciationMonth(a);
  for (let i = 0; i < months; i += 1) {
    const amountCents = i === months - 1 ? base - accumulated : per;
    accumulated += amountCents;
    rows.push({ monthKey, amountCents, accumulatedCents: accumulated });
    monthKey = addMonths(monthKey, 1);
  }
  return rows;
}

/// The sourceId that makes "once per asset per month" structural. Read the
/// module header before changing this: the format IS the idempotency key, and
/// changing it would let every month post a second time.
export function depreciationSourceId(assetId: string, monthKey: string): string {
  return `${assetId}:${monthKey}`;
}

export function parseDepreciationSourceId(sourceId: string): { assetId: string; monthKey: string } | null {
  const i = sourceId.lastIndexOf(":");
  if (i <= 0) return null;
  const monthKey = sourceId.slice(i + 1);
  if (!/^\d{4}-\d{2}$/.test(monthKey)) return null;
  return { assetId: sourceId.slice(0, i), monthKey };
}

export type DepreciationDue = {
  assetId: string;
  monthKey: string;
  amountCents: number;
  sourceId: string;
  /// The last day of the month, which is the entry date. Depreciation for a
  /// month belongs to that month, not to the day somebody pressed the button.
  entryDate: string;
};

export function monthEnd(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  if (!y || !m) return `${monthKey}-01`;
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/// Every month of depreciation up to and including `throughMonth` that has not
/// already been posted.
///
/// `postedMonths` comes from the ledger itself — the months that already have
/// a DEPRECIATION entry for this asset — so this never needs a schedule table
/// to know where it got to. A DISPOSED asset takes nothing after its disposal
/// month: the disposal entry already removed the asset and its accumulated
/// depreciation from the books.
export function depreciationDue(
  a: FixedAsset,
  throughMonth: string,
  postedMonths: Set<string>,
): DepreciationDue[] {
  if (a.status === "DISPOSED" && a.disposedDate && a.disposedDate.slice(0, 7) < throughMonth) {
    throughMonth = a.disposedDate.slice(0, 7);
  }
  const out: DepreciationDue[] = [];
  for (const row of depreciationSchedule(a)) {
    if (row.monthKey > throughMonth) break;
    if (postedMonths.has(row.monthKey)) continue;
    if (row.amountCents === 0) continue;
    out.push({
      assetId: a.id,
      monthKey: row.monthKey,
      amountCents: row.amountCents,
      sourceId: depreciationSourceId(a.id, row.monthKey),
      entryDate: monthEnd(row.monthKey),
    });
  }
  return out;
}

export type DraftLine = {
  accountId: string;
  debitCents: number;
  creditCents: number;
  legalEntityId?: string | null;
  memo?: string | null;
};

/// One month of depreciation: expense up, accumulated depreciation up.
export function depreciationLines(a: FixedAsset, amountCents: number): DraftLine[] {
  return [
    {
      accountId: a.depExpenseAccountId,
      debitCents: amountCents,
      creditCents: 0,
      legalEntityId: a.legalEntityId ?? null,
      memo: a.name,
    },
    {
      accountId: a.accumDepAccountId,
      debitCents: 0,
      creditCents: amountCents,
      legalEntityId: a.legalEntityId ?? null,
      memo: a.name,
    },
  ];
}

// ── Disposal ────────────────────────────────────────────────────────────────

export type DisposalInput = {
  /// Date-only. Must not precede the in-service date.
  disposedDate: string;
  /// What was received. Zero for a scrapped asset.
  proceedsCents: number;
  /// Where the proceeds landed — a bank or undeposited-funds GL account.
  /// Omitted when proceeds are zero.
  proceedsAccountId: string | null;
  /// Where a gain goes (income) and where a loss goes (expense).
  gainAccountId: string;
  lossAccountId: string;
  note?: string | null;
};

export type DisposalPlan = {
  lines: DraftLine[];
  /// Positive = gain, negative = loss, zero = sold at exactly book value.
  gainLossCents: number;
  bookValueCents: number;
  accumulatedCents: number;
};

export function validateDisposal(
  a: FixedAsset,
  input: DisposalInput,
  accumulatedCents: number,
): string[] {
  const errs: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.disposedDate)) errs.push("Pick the disposal date (YYYY-MM-DD).");
  else if (input.disposedDate < a.inServiceDate) {
    errs.push("An asset can't be disposed of before it was placed in service.");
  }
  if (a.status === "DISPOSED") errs.push("This asset has already been disposed of.");
  if (!Number.isInteger(input.proceedsCents) || input.proceedsCents < 0) {
    errs.push("Proceeds can't be negative. Record a cost of disposal as an expense instead.");
  }
  if (input.proceedsCents > 0 && !input.proceedsAccountId) {
    errs.push("Say which account the money went into.");
  }
  if (accumulatedCents > depreciableBaseCents(a)) {
    // Not reachable through the schedule, but a hand-written entry to 1590
    // could do it, and the resulting disposal would be nonsense.
    errs.push(
      `More depreciation has been posted for this asset (${formatCents(accumulatedCents)}) than it can take (${formatCents(depreciableBaseCents(a))}). Fix the ledger before disposing of it.`,
    );
  }
  return errs;
}

/// The disposal entry: take the asset off the books at cost, take its
/// accumulated depreciation off with it, bring in whatever was received, and
/// put the difference to a gain or a loss. It balances by construction —
/// `gainLossCents` IS the plug, so there is nothing left to round.
export function disposalPlan(
  a: FixedAsset,
  input: DisposalInput,
  accumulatedCents: number,
): DisposalPlan {
  const bookValueCents = a.costCents - accumulatedCents;
  const gainLossCents = input.proceedsCents - bookValueCents;
  const entity = a.legalEntityId ?? null;
  const lines: DraftLine[] = [];

  if (accumulatedCents > 0) {
    // Accumulated depreciation is a CREDIT-balance contra asset, so removing
    // it is a debit.
    lines.push({
      accountId: a.accumDepAccountId,
      debitCents: accumulatedCents,
      creditCents: 0,
      legalEntityId: entity,
      memo: `Accumulated depreciation removed — ${a.name}`,
    });
  }
  if (input.proceedsCents > 0 && input.proceedsAccountId) {
    lines.push({
      accountId: input.proceedsAccountId,
      debitCents: input.proceedsCents,
      creditCents: 0,
      legalEntityId: entity,
      memo: `Proceeds from disposal — ${a.name}`,
    });
  }
  lines.push({
    accountId: a.assetAccountId,
    debitCents: 0,
    creditCents: a.costCents,
    legalEntityId: entity,
    memo: `Asset removed at cost — ${a.name}`,
  });
  if (gainLossCents > 0) {
    lines.push({
      accountId: input.gainAccountId,
      debitCents: 0,
      creditCents: gainLossCents,
      legalEntityId: entity,
      memo: `Gain on disposal — ${a.name}`,
    });
  } else if (gainLossCents < 0) {
    lines.push({
      accountId: input.lossAccountId,
      debitCents: -gainLossCents,
      creditCents: 0,
      legalEntityId: entity,
      memo: `Loss on disposal — ${a.name}`,
    });
  }
  return { lines, gainLossCents, bookValueCents, accumulatedCents };
}

export function disposalSourceId(assetId: string): string {
  return `${assetId}:disposal`;
}
