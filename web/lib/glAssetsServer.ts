// Accounting Phase 3 — the fixed-asset register, written to the database.
//
// Depreciation and disposal entries go through createEntry from
// lib/ledgerServer.ts, like every other entry in this system: it is still the
// only module that writes a gl_* table, so the lock date, the balance check
// and the audit trail all apply here for free. The rules live in
// lib/glAssets.ts and are proven by scripts/gl-close-tests.ts.
//
// Every query is scoped by clubId.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { LedgerError, createEntry, type Actor } from "@/lib/ledgerServer";
import {
  type DisposalInput,
  type FixedAsset,
  depreciationDue,
  depreciationLines,
  depreciationSchedule,
  depreciationSourceId,
  disposalPlan,
  disposalSourceId,
  firstDepreciationMonth,
  lastDepreciationMonth,
  monthEnd,
  validateAsset,
  validateDisposal,
} from "@/lib/glAssets";

const ymd = (d: Date): string => d.toISOString().slice(0, 10);
const asDate = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

/// Where a gain or loss on disposal goes. The sports-club chart has no
/// dedicated gain/loss account, and adding one to CHART_TEMPLATE would not
/// reach a club already seeded (ensureSystemAccounts only tops up SYSTEM
/// accounts). So a gain goes to Other Income and a loss to Miscellaneous —
/// both real accounts in every seeded chart, both shown on screen before the
/// entry is posted, and a CPA can reclassify with a journal entry.
const GAIN_ACCOUNT_NUMBER = "4950";
const LOSS_ACCOUNT_NUMBER = "6900";

export type AssetRow = FixedAsset & {
  description: string | null;
  disposalProceedsCents: number | null;
  disposalEntryId: string | null;
  disposalNote: string | null;
  assetAccount: { number: string; name: string };
  accumDepAccount: { number: string; name: string };
  depExpenseAccount: { number: string; name: string };
  legalEntityName: string | null;
  /// Depreciation actually POSTED for this asset, read from the ledger rather
  /// than from a stored running total — the ledger is the fact, and a cached
  /// total is a second truth that drifts.
  accumulatedCents: number;
  bookValueCents: number;
  monthlyCents: number;
  firstMonth: string;
  lastMonth: string;
  postedMonths: string[];
};

function toAsset(r: {
  id: string;
  name: string;
  costCents: number;
  inServiceDate: Date;
  usefulLifeMonths: number;
  salvageValueCents: number;
  legalEntityId: string | null;
  assetAccountId: string;
  accumDepAccountId: string;
  depExpenseAccountId: string;
  status: string;
  disposedDate: Date | null;
}): FixedAsset {
  return {
    id: r.id,
    name: r.name,
    costCents: r.costCents,
    inServiceDate: ymd(r.inServiceDate),
    usefulLifeMonths: r.usefulLifeMonths,
    salvageValueCents: r.salvageValueCents,
    legalEntityId: r.legalEntityId,
    assetAccountId: r.assetAccountId,
    accumDepAccountId: r.accumDepAccountId,
    depExpenseAccountId: r.depExpenseAccountId,
    status: r.status === "DISPOSED" ? "DISPOSED" : "ACTIVE",
    disposedDate: r.disposedDate ? ymd(r.disposedDate) : null,
  };
}

/// Which months already have a DEPRECIATION entry, per asset. One query for
/// every asset rather than one per asset.
async function postedMonthsByAsset(clubId: string): Promise<Map<string, Set<string>>> {
  const rows = await prisma.glJournalEntry.findMany({
    where: { clubId, sourceType: "DEPRECIATION", status: "POSTED" },
    select: { sourceId: true },
  });
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.sourceId) continue;
    const i = r.sourceId.lastIndexOf(":");
    if (i <= 0) continue;
    const assetId = r.sourceId.slice(0, i);
    const monthKey = r.sourceId.slice(i + 1);
    const set = out.get(assetId) ?? new Set<string>();
    set.add(monthKey);
    out.set(assetId, set);
  }
  return out;
}

export async function listAssets(
  clubId: string,
  opts?: { legalEntityId?: string | null; includeDisposed?: boolean },
): Promise<AssetRow[]> {
  const rows = await prisma.glFixedAsset.findMany({
    where: {
      clubId,
      ...(opts?.legalEntityId ? { legalEntityId: opts.legalEntityId } : {}),
      ...(opts?.includeDisposed ? {} : { status: "ACTIVE" }),
    },
    include: {
      assetAccount: { select: { number: true, name: true } },
      accumDepAccount: { select: { number: true, name: true } },
      depExpenseAccount: { select: { number: true, name: true } },
      legalEntity: { select: { name: true } },
    },
    orderBy: [{ inServiceDate: "desc" }, { name: "asc" }],
  });

  const posted = await postedMonthsByAsset(clubId);

  return rows.map((r) => {
    const a = toAsset(r);
    const months = posted.get(r.id) ?? new Set<string>();
    const schedule = depreciationSchedule(a);
    const accumulatedCents = schedule
      .filter((s) => months.has(s.monthKey))
      .reduce((sum, s) => sum + s.amountCents, 0);
    return {
      ...a,
      description: r.description,
      disposalProceedsCents: r.disposalProceedsCents,
      disposalEntryId: r.disposalEntryId,
      disposalNote: r.disposalNote,
      assetAccount: r.assetAccount,
      accumDepAccount: r.accumDepAccount,
      depExpenseAccount: r.depExpenseAccount,
      legalEntityName: r.legalEntity?.name ?? null,
      accumulatedCents,
      bookValueCents: r.costCents - accumulatedCents,
      monthlyCents: schedule[0]?.amountCents ?? 0,
      firstMonth: firstDepreciationMonth(a),
      lastMonth: lastDepreciationMonth(a),
      postedMonths: [...months].sort(),
    };
  });
}

export type AssetInput = {
  name: string;
  description?: string | null;
  costCents: number;
  inServiceDate: string;
  usefulLifeMonths: number;
  salvageValueCents: number;
  legalEntityId: string | null;
  assetAccountId: string;
  accumDepAccountId: string;
  depExpenseAccountId: string;
};

async function assertAccounts(clubId: string, ids: string[]): Promise<void> {
  const unique = [...new Set(ids)];
  const found = await prisma.glAccount.findMany({
    where: { clubId, id: { in: unique } },
    select: { id: true, type: true, isContra: true, number: true },
  });
  if (found.length !== unique.length) {
    throw new LedgerError("One of those accounts doesn't exist in this club's chart.", 404);
  }
}

export async function createAsset(clubId: string, input: AssetInput, actor: Actor): Promise<string> {
  const errs = validateAsset(input);
  if (errs.length) throw new LedgerError(errs.join(" "));
  await assertAccounts(clubId, [input.assetAccountId, input.accumDepAccountId, input.depExpenseAccountId]);
  if (input.legalEntityId) {
    const e = await prisma.legalEntity.findFirst({
      where: { id: input.legalEntityId, clubId },
      select: { id: true },
    });
    if (!e) throw new LedgerError("That entity doesn't exist in this club.", 404);
  }
  const row = await prisma.glFixedAsset.create({
    data: {
      clubId,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      costCents: input.costCents,
      inServiceDate: asDate(input.inServiceDate),
      usefulLifeMonths: input.usefulLifeMonths,
      salvageValueCents: input.salvageValueCents,
      legalEntityId: input.legalEntityId,
      assetAccountId: input.assetAccountId,
      accumDepAccountId: input.accumDepAccountId,
      depExpenseAccountId: input.depExpenseAccountId,
      createdByUserId: actor.userId,
    },
    select: { id: true },
  });
  return row.id;
}

/// Editing an asset AFTER depreciation has posted is refused for the four
/// fields that define the schedule.
///
/// Recomputing a schedule under already-posted months is how a register starts
/// disagreeing with the ledger: the posted months stay as they were, the
/// remaining ones change, and the total no longer equals cost minus salvage.
/// The honest fix for a wrong cost is to dispose of the asset and re-enter it,
/// or to post a correcting journal entry — both of which leave a trail.
export async function updateAsset(
  clubId: string,
  id: string,
  input: Partial<AssetInput>,
): Promise<void> {
  const existing = await prisma.glFixedAsset.findFirst({ where: { id, clubId } });
  if (!existing) throw new LedgerError("That asset doesn't exist.", 404);

  const postedCount = await prisma.glJournalEntry.count({
    where: { clubId, sourceType: "DEPRECIATION", sourceId: { startsWith: `${id}:` } },
  });

  const schedulingFields: (keyof AssetInput)[] = [
    "costCents",
    "inServiceDate",
    "usefulLifeMonths",
    "salvageValueCents",
  ];
  const changingSchedule = schedulingFields.filter((f) => {
    if (input[f] === undefined) return false;
    if (f === "inServiceDate") return input.inServiceDate !== ymd(existing.inServiceDate);
    return input[f] !== existing[f as "costCents" | "usefulLifeMonths" | "salvageValueCents"];
  });

  if (changingSchedule.length && postedCount > 0) {
    throw new LedgerError(
      `${postedCount} ${postedCount === 1 ? "month" : "months"} of depreciation has already been posted for this asset, so its cost, in-service date, life and salvage value are fixed. Change them and the posted months would no longer add up to cost less salvage. Dispose of it and re-enter it, or post a correcting journal entry.`,
      409,
    );
  }

  const next = {
    ...existing,
    ...input,
    inServiceDate: input.inServiceDate ?? ymd(existing.inServiceDate),
  };
  const errs = validateAsset({
    name: next.name,
    costCents: next.costCents,
    inServiceDate: next.inServiceDate,
    usefulLifeMonths: next.usefulLifeMonths,
    salvageValueCents: next.salvageValueCents,
  });
  if (errs.length) throw new LedgerError(errs.join(" "));

  if (input.assetAccountId || input.accumDepAccountId || input.depExpenseAccountId) {
    await assertAccounts(
      clubId,
      [
        input.assetAccountId ?? existing.assetAccountId,
        input.accumDepAccountId ?? existing.accumDepAccountId,
        input.depExpenseAccountId ?? existing.depExpenseAccountId,
      ],
    );
  }

  await prisma.glFixedAsset.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
      ...(input.costCents !== undefined ? { costCents: input.costCents } : {}),
      ...(input.inServiceDate !== undefined ? { inServiceDate: asDate(input.inServiceDate) } : {}),
      ...(input.usefulLifeMonths !== undefined ? { usefulLifeMonths: input.usefulLifeMonths } : {}),
      ...(input.salvageValueCents !== undefined ? { salvageValueCents: input.salvageValueCents } : {}),
      ...(input.legalEntityId !== undefined ? { legalEntityId: input.legalEntityId } : {}),
      ...(input.assetAccountId ? { assetAccountId: input.assetAccountId } : {}),
      ...(input.accumDepAccountId ? { accumDepAccountId: input.accumDepAccountId } : {}),
      ...(input.depExpenseAccountId ? { depExpenseAccountId: input.depExpenseAccountId } : {}),
    },
  });
}

/// Deleting an asset is only allowed while it has posted nothing. Once it has,
/// the register has to keep explaining entries that exist on the ledger.
export async function deleteAsset(clubId: string, id: string): Promise<void> {
  const existing = await prisma.glFixedAsset.findFirst({ where: { id, clubId }, select: { id: true } });
  if (!existing) throw new LedgerError("That asset doesn't exist.", 404);
  const postedCount = await prisma.glJournalEntry.count({
    where: { clubId, sourceType: { in: ["DEPRECIATION", "ASSET_DISPOSAL"] }, sourceId: { startsWith: `${id}:` } },
  });
  if (postedCount > 0) {
    throw new LedgerError(
      "This asset has entries on the ledger, so it can't be deleted — the books would be left explaining nothing. Dispose of it instead.",
      409,
    );
  }
  await prisma.glFixedAsset.delete({ where: { id } });
}

export type DepreciationResult = {
  posted: number;
  alreadyPosted: number;
  totalCents: number;
  errors: { assetId: string; monthKey: string; error: string }[];
  months: { assetId: string; assetName: string; monthKey: string; amountCents: number }[];
};

/// Post every month of depreciation due up to and including `throughMonth`.
///
/// Idempotent by construction: the sourceId is `<assetId>:<YYYY-MM>` and
/// gl_journal_entries is unique on (clubId, sourceType, sourceId), so a second
/// run raises P2002 — which is counted as alreadyPosted, not as an error. That
/// is what makes "a depreciation re-run posts nothing new" a property of the
/// database rather than of this function remembering to check.
export async function postDepreciation(
  clubId: string,
  opts: { throughMonth: string; legalEntityId?: string | null; assetId?: string | null },
  actor: Actor,
): Promise<DepreciationResult> {
  const assets = await listAssets(clubId, {
    legalEntityId: opts.legalEntityId ?? null,
    includeDisposed: true,
  });
  const result: DepreciationResult = {
    posted: 0,
    alreadyPosted: 0,
    totalCents: 0,
    errors: [],
    months: [],
  };

  for (const a of assets) {
    if (opts.assetId && a.id !== opts.assetId) continue;
    const due = depreciationDue(a, opts.throughMonth, new Set(a.postedMonths));
    for (const d of due) {
      try {
        await createEntry(
          clubId,
          {
            entryDate: d.entryDate,
            memo: `Depreciation — ${a.name}`,
            reference: null,
            legalEntityId: a.legalEntityId,
            sourceType: "DEPRECIATION",
            sourceId: d.sourceId,
            lines: depreciationLines(a, d.amountCents),
          },
          actor,
        );
        result.posted += 1;
        result.totalCents += d.amountCents;
        result.months.push({
          assetId: a.id,
          assetName: a.name,
          monthKey: d.monthKey,
          amountCents: d.amountCents,
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          // Two runs at once. Losing that race is a success.
          result.alreadyPosted += 1;
          continue;
        }
        // A locked month is information, not a crash: one asset must not stop
        // the rest. This is how a club that closed January still gets
        // February's depreciation posted.
        result.errors.push({
          assetId: a.id,
          monthKey: d.monthKey,
          error: err instanceof LedgerError ? err.message : "could not post",
        });
      }
    }
  }
  return result;
}

/// How many months of depreciation are outstanding on or before `throughMonth`
/// — the month-close checklist's fifth item.
export async function depreciationOutstanding(
  clubId: string,
  throughMonth: string,
  legalEntityId?: string | null,
): Promise<number> {
  const assets = await listAssets(clubId, { legalEntityId: legalEntityId ?? null, includeDisposed: true });
  let n = 0;
  for (const a of assets) n += depreciationDue(a, throughMonth, new Set(a.postedMonths)).length;
  return n;
}

export type DisposalRequest = {
  disposedDate: string;
  proceedsCents: number;
  proceedsAccountId: string | null;
  note?: string | null;
};

export async function disposeAsset(
  clubId: string,
  id: string,
  req: DisposalRequest,
  actor: Actor,
): Promise<{ entryId: string; gainLossCents: number }> {
  const [asset] = await listAssets(clubId, { includeDisposed: true }).then((rows) =>
    rows.filter((r) => r.id === id),
  );
  if (!asset) throw new LedgerError("That asset doesn't exist.", 404);

  const [gain, loss] = await Promise.all([
    prisma.glAccount.findFirst({
      where: { clubId, number: GAIN_ACCOUNT_NUMBER },
      select: { id: true, name: true },
    }),
    prisma.glAccount.findFirst({
      where: { clubId, number: LOSS_ACCOUNT_NUMBER },
      select: { id: true, name: true },
    }),
  ]);
  if (!gain || !loss) {
    throw new LedgerError(
      `A disposal needs accounts ${GAIN_ACCOUNT_NUMBER} and ${LOSS_ACCOUNT_NUMBER} for the gain or loss. Seed the chart of accounts, or add them, and try again.`,
      409,
    );
  }
  if (req.proceedsAccountId) await assertAccounts(clubId, [req.proceedsAccountId]);

  const input: DisposalInput = {
    disposedDate: req.disposedDate,
    proceedsCents: req.proceedsCents,
    proceedsAccountId: req.proceedsAccountId,
    gainAccountId: gain.id,
    lossAccountId: loss.id,
    note: req.note ?? null,
  };
  const errs = validateDisposal(asset, input, asset.accumulatedCents);
  if (errs.length) throw new LedgerError(errs.join(" "));

  const plan = disposalPlan(asset, input, asset.accumulatedCents);
  const entry = await createEntry(
    clubId,
    {
      entryDate: req.disposedDate,
      memo: `Disposal — ${asset.name}${req.note ? ` · ${req.note}` : ""}`,
      reference: null,
      legalEntityId: asset.legalEntityId,
      sourceType: "ASSET_DISPOSAL",
      sourceId: disposalSourceId(asset.id),
      lines: plan.lines,
    },
    actor,
  );

  await prisma.glFixedAsset.update({
    where: { id },
    data: {
      status: "DISPOSED",
      disposedDate: asDate(req.disposedDate),
      disposalProceedsCents: req.proceedsCents,
      disposalEntryId: entry.id,
      disposalNote: req.note?.trim() || null,
    },
  });
  return { entryId: entry.id, gainLossCents: plan.gainLossCents };
}

export { monthEnd };
