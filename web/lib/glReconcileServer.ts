// Accounting Phase 2, task 7 — bank and card reconciliation.
//
// The workflow every bookkeeper already knows: pick an account and a statement
// period, type the statement's ending balance, tick off the lines that cleared,
// and finish only when the difference is exactly $0.00.
//
// ── THE DIFFERENCE IS ALWAYS DERIVED ───────────────────────────────────────
// `statementEndingCents` is the only number the owner types. The cleared total
// is computed from the lines that point at this reconciliation, so the
// difference cannot drift from the ticks — there is no stored "cleared total"
// to go stale. `finish()` recomputes it server-side and refuses anything but
// zero, so the client cannot talk its way past the gate.
//
// ── FINISHING FREEZES THE CLEARED LINES ────────────────────────────────────
// Once FINISHED, lib/ledgerServer.voidEntry refuses to void an entry with a
// line cleared in it. Otherwise a reconciled month could silently stop tying
// out, which defeats the point of having reconciled it. Undo is the escape
// hatch and is audited — "who reopened a closed reconciliation" is exactly
// what an auditor asks.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isValidDateOnly, signedBalanceOf } from "@/lib/glReconcile";
import { LedgerError, type Actor } from "@/lib/ledgerServer";

const dateOnly = (s: string) => new Date(`${s}T00:00:00.000Z`);
const toDateStr = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);

async function writeAudit(
  tx: Prisma.TransactionClient,
  clubId: string,
  actor: Actor,
  objectId: string,
  action: "CREATE" | "UPDATE" | "VOID",
  note: string,
  before?: unknown,
  after?: unknown,
) {
  await tx.glAuditLog.create({
    data: {
      clubId,
      objectType: "ENTRY",
      objectId,
      action,
      actorUserId: actor.userId,
      actorName: actor.name,
      before: (before ?? null) as Prisma.InputJsonValue,
      after: (after ?? null) as Prisma.InputJsonValue,
      note,
    },
  });
}

export type ReconcileLine = {
  lineId: string;
  entryId: string;
  entryDate: string;
  memo: string | null;
  reference: string | null;
  debitCents: number;
  creditCents: number;
  /// Signed in the account's own normal direction — what the statement shows.
  signedCents: number;
  cleared: boolean;
  /// True when this line was cleared in a DIFFERENT, finished reconciliation
  /// — it is somebody else's settled work and must not be re-ticked here.
  lockedElsewhere: boolean;
};

export type ReconcileView = {
  id: string | null;
  accountId: string;
  accountNumber: string;
  accountName: string;
  normalBalance: string;
  periodStart: string;
  periodEnd: string;
  statementEndingCents: number;
  status: string;
  notes: string | null;
  /// Ledger balance of everything cleared up to and including this period.
  clearedBalanceCents: number;
  /// statementEnding − clearedBalance. Finish is allowed only at 0.
  differenceCents: number;
  /// Every posted line on this account in the period, plus anything older that
  /// has still never cleared — an uncleared cheque from two months ago belongs
  /// on this statement, which is the whole point of reconciling.
  lines: ReconcileLine[];
  finishedAt: string | null;
  undoneAt: string | null;
  openingClearedCents: number;
};

/// Load (or synthesise) the reconciliation workpaper for one account + period.
export async function loadReconciliation(
  clubId: string,
  accountId: string,
  periodStart: string,
  periodEnd: string,
): Promise<ReconcileView> {
  if (!isValidDateOnly(periodStart) || !isValidDateOnly(periodEnd)) {
    throw new LedgerError("Pick a statement period (YYYY-MM-DD).");
  }
  if (periodEnd < periodStart) throw new LedgerError("The statement period ends before it starts.");

  const account = await prisma.glAccount.findFirst({
    where: { id: accountId, clubId },
    select: { id: true, number: true, name: true, normalBalance: true },
  });
  if (!account) throw new LedgerError("That account doesn't exist in this club.", 404);

  const existing = await prisma.glReconciliation.findFirst({
    where: { clubId, accountId, periodEnd: dateOnly(periodEnd) },
    select: {
      id: true,
      periodStart: true,
      statementEndingCents: true,
      status: true,
      notes: true,
      finishedAt: true,
      undoneAt: true,
    },
  });

  // Lines in the period, plus every still-uncleared line from before it.
  const lines = await prisma.glJournalLine.findMany({
    where: {
      clubId,
      accountId,
      entry: { clubId, status: "POSTED" },
      OR: [
        { entry: { entryDate: { gte: dateOnly(periodStart), lte: dateOnly(periodEnd) } } },
        { clearedAt: null, entry: { entryDate: { lt: dateOnly(periodStart) } } },
      ],
    },
    select: {
      id: true,
      debitCents: true,
      creditCents: true,
      clearedAt: true,
      reconciliationId: true,
      entryId: true,
      entry: { select: { entryDate: true, memo: true, reference: true } },
      reconciliation: { select: { id: true, status: true } },
    },
    orderBy: [{ entry: { entryDate: "asc" } }, { lineNumber: "asc" }],
    take: 1000,
  });

  const shaped: ReconcileLine[] = lines.map((l) => {
    const inThis = existing ? l.reconciliationId === existing.id : false;
    const lockedElsewhere = !!l.reconciliation && l.reconciliation.status === "FINISHED" && !inThis;
    return {
      lineId: l.id,
      entryId: l.entryId,
      entryDate: toDateStr(l.entry.entryDate)!,
      memo: l.entry.memo,
      reference: l.entry.reference,
      debitCents: l.debitCents,
      creditCents: l.creditCents,
      signedCents: signedBalanceOf(account.normalBalance, l.debitCents, l.creditCents),
      cleared: !!l.clearedAt,
      lockedElsewhere,
    };
  });

  // Everything cleared in an EARLIER period is the opening balance this
  // statement builds on.
  const priorCleared = await prisma.glJournalLine.aggregate({
    where: {
      clubId,
      accountId,
      clearedAt: { not: null },
      entry: { clubId, status: "POSTED", entryDate: { lt: dateOnly(periodStart) } },
    },
    _sum: { debitCents: true, creditCents: true },
  });
  const openingClearedCents = signedBalanceOf(
    account.normalBalance,
    priorCleared._sum.debitCents ?? 0,
    priorCleared._sum.creditCents ?? 0,
  );

  const clearedInPeriod = shaped.filter((l) => l.cleared).reduce((sum, l) => sum + l.signedCents, 0);
  const clearedBalanceCents = openingClearedCents + clearedInPeriod;
  const statementEndingCents = existing?.statementEndingCents ?? 0;

  return {
    id: existing?.id ?? null,
    accountId: account.id,
    accountNumber: account.number,
    accountName: account.name,
    normalBalance: account.normalBalance,
    periodStart: existing ? toDateStr(existing.periodStart)! : periodStart,
    periodEnd,
    statementEndingCents,
    status: existing?.status ?? "OPEN",
    notes: existing?.notes ?? null,
    clearedBalanceCents,
    differenceCents: statementEndingCents - clearedBalanceCents,
    lines: shaped,
    finishedAt: existing?.finishedAt?.toISOString() ?? null,
    undoneAt: existing?.undoneAt?.toISOString() ?? null,
    openingClearedCents,
  };
}

/// Create or update the OPEN reconciliation for an account + period.
export async function upsertReconciliation(
  clubId: string,
  input: { accountId: string; periodStart: string; periodEnd: string; statementEndingCents: number; notes?: string | null },
  actor: Actor,
): Promise<ReconcileView> {
  if (!isValidDateOnly(input.periodStart) || !isValidDateOnly(input.periodEnd)) {
    throw new LedgerError("Pick a statement period (YYYY-MM-DD).");
  }
  const account = await prisma.glAccount.findFirst({ where: { id: input.accountId, clubId }, select: { id: true } });
  if (!account) throw new LedgerError("That account doesn't exist in this club.", 404);

  const existing = await prisma.glReconciliation.findFirst({
    where: { clubId, accountId: input.accountId, periodEnd: dateOnly(input.periodEnd) },
    select: { id: true, status: true },
  });

  if (existing?.status === "FINISHED") {
    throw new LedgerError("That statement is already reconciled. Undo it first if you need to change it.", 409);
  }

  if (existing) {
    await prisma.glReconciliation.updateMany({
      where: { id: existing.id, clubId },
      data: {
        periodStart: dateOnly(input.periodStart),
        statementEndingCents: input.statementEndingCents,
        notes: input.notes?.trim() || null,
      },
    });
  } else {
    await prisma.$transaction(async (tx) => {
      const created = await tx.glReconciliation.create({
        data: {
          clubId,
          accountId: input.accountId,
          periodStart: dateOnly(input.periodStart),
          periodEnd: dateOnly(input.periodEnd),
          statementEndingCents: input.statementEndingCents,
          notes: input.notes?.trim() || null,
          createdByUserId: actor.userId,
        },
        select: { id: true },
      });
      await writeAudit(tx, clubId, actor, created.id, "CREATE", `Started reconciling the statement ending ${input.periodEnd}.`);
    });
  }

  return loadReconciliation(clubId, input.accountId, input.periodStart, input.periodEnd);
}

/// Tick or untick lines. Refuses to touch a line cleared in a different
/// FINISHED reconciliation — that is settled work.
export async function setCleared(
  clubId: string,
  reconciliationId: string,
  lineIds: string[],
  cleared: boolean,
  _actor: Actor,
): Promise<ReconcileView> {
  const rec = await prisma.glReconciliation.findFirst({
    where: { id: reconciliationId, clubId },
    select: { id: true, accountId: true, status: true, periodStart: true, periodEnd: true },
  });
  if (!rec) throw new LedgerError("That reconciliation doesn't exist in this club.", 404);
  if (rec.status === "FINISHED") {
    throw new LedgerError("That statement is reconciled. Undo it before changing which lines cleared.", 409);
  }
  if (lineIds.length === 0) {
    return loadReconciliation(clubId, rec.accountId, toDateStr(rec.periodStart)!, toDateStr(rec.periodEnd)!);
  }

  // Only lines on this account, in this club, not frozen by another finished
  // reconciliation.
  const candidates = await prisma.glJournalLine.findMany({
    where: {
      id: { in: lineIds },
      clubId,
      accountId: rec.accountId,
      entry: { clubId, status: "POSTED" },
    },
    select: { id: true, reconciliationId: true, reconciliation: { select: { status: true } } },
  });
  const allowed = candidates
    .filter((c) => !(c.reconciliation?.status === "FINISHED" && c.reconciliationId !== rec.id))
    .map((c) => c.id);
  if (allowed.length === 0) {
    throw new LedgerError("None of those lines can be changed — they belong to a finished reconciliation.", 409);
  }

  await prisma.glJournalLine.updateMany({
    where: { id: { in: allowed }, clubId, accountId: rec.accountId },
    data: cleared ? { clearedAt: new Date(), reconciliationId: rec.id } : { clearedAt: null, reconciliationId: null },
  });

  return loadReconciliation(clubId, rec.accountId, toDateStr(rec.periodStart)!, toDateStr(rec.periodEnd)!);
}

/// Finish — allowed ONLY at a difference of exactly $0.00, recomputed here
/// rather than trusted from the client.
export async function finishReconciliation(
  clubId: string,
  reconciliationId: string,
  actor: Actor,
): Promise<ReconcileView> {
  const rec = await prisma.glReconciliation.findFirst({
    where: { id: reconciliationId, clubId },
    select: { id: true, accountId: true, status: true, periodStart: true, periodEnd: true },
  });
  if (!rec) throw new LedgerError("That reconciliation doesn't exist in this club.", 404);
  if (rec.status === "FINISHED") throw new LedgerError("That statement is already reconciled.", 409);

  const view = await loadReconciliation(clubId, rec.accountId, toDateStr(rec.periodStart)!, toDateStr(rec.periodEnd)!);
  if (view.differenceCents !== 0) {
    const off = Math.abs(view.differenceCents);
    throw new LedgerError(
      `This statement is out by $${(off / 100).toFixed(2)}. A reconciliation can only be finished at $0.00 — ` +
        "tick the lines that cleared, or check the statement balance you typed.",
      409,
    );
  }

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.glReconciliation.updateMany({
      where: { id: rec.id, clubId, status: "OPEN" },
      data: {
        status: "FINISHED",
        finishedAt: new Date(),
        finishedByUserId: actor.userId,
        ledgerEndingCents: view.clearedBalanceCents,
      },
    });
    if (claimed.count === 0) throw new LedgerError("That statement was just reconciled by someone else.", 409);
    await writeAudit(
      tx,
      clubId,
      actor,
      rec.id,
      "UPDATE",
      `Reconciled ${view.accountNumber} ${view.accountName} for the statement ending ${view.periodEnd} at $0.00. ` +
        `${view.lines.filter((l) => l.cleared).length} lines cleared.`,
      { status: "OPEN" },
      { status: "FINISHED", clearedBalanceCents: view.clearedBalanceCents },
    );
  });

  return loadReconciliation(clubId, rec.accountId, toDateStr(rec.periodStart)!, toDateStr(rec.periodEnd)!);
}

/// Reopen a finished reconciliation. Audited, and the reason is recorded —
/// this is the action that unfreezes cleared lines, so it should leave a trail.
/// The ticks are deliberately KEPT: reopening is usually to correct one line,
/// not to start over.
export async function undoReconciliation(
  clubId: string,
  reconciliationId: string,
  reason: string | null,
  actor: Actor,
): Promise<ReconcileView> {
  const rec = await prisma.glReconciliation.findFirst({
    where: { id: reconciliationId, clubId },
    select: { id: true, accountId: true, status: true, periodStart: true, periodEnd: true },
  });
  if (!rec) throw new LedgerError("That reconciliation doesn't exist in this club.", 404);
  if (rec.status !== "FINISHED") throw new LedgerError("That statement isn't reconciled, so there's nothing to undo.", 409);

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.glReconciliation.updateMany({
      where: { id: rec.id, clubId, status: "FINISHED" },
      data: { status: "OPEN", undoneAt: new Date(), undoneByUserId: actor.userId, undoReason: reason?.trim() || null },
    });
    if (claimed.count === 0) throw new LedgerError("That reconciliation changed just now. Try again.", 409);
    await writeAudit(
      tx,
      clubId,
      actor,
      rec.id,
      "UPDATE",
      `REOPENED the reconciliation for the statement ending ${toDateStr(rec.periodEnd)}. The cleared ticks were kept.` +
        (reason?.trim() ? ` Reason: ${reason.trim()}` : ""),
      { status: "FINISHED" },
      { status: "OPEN" },
    );
  });

  return loadReconciliation(clubId, rec.accountId, toDateStr(rec.periodStart)!, toDateStr(rec.periodEnd)!);
}

/// Accounts worth reconciling: the bank and card accounts (sub-accounts of
/// 1000 and 2100) plus 1050 Stripe Clearing, which is the one other account a
/// club genuinely ties out.
export async function reconcilableAccounts(clubId: string): Promise<
  { id: string; number: string; name: string; normalBalance: string; isCard: boolean }[]
> {
  const parents = await prisma.glAccount.findMany({
    where: { clubId, number: { in: ["1000", "2100"] } },
    select: { id: true, number: true },
  });
  const parentIds = parents.map((p) => p.id);
  const cardParentId = parents.find((p) => p.number === "2100")?.id ?? null;

  const rows = await prisma.glAccount.findMany({
    where: {
      clubId,
      active: true,
      OR: [
        { number: { in: ["1000", "1010", "2100"] } },
        { systemKey: "STRIPE_CLEARING" },
        ...(parentIds.length ? [{ parentId: { in: parentIds } }] : []),
      ],
    },
    select: { id: true, number: true, name: true, normalBalance: true, parentId: true },
    orderBy: { number: "asc" },
  });

  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    name: r.name,
    normalBalance: r.normalBalance,
    isCard: r.number === "2100" || (!!cardParentId && r.parentId === cardParentId),
  }));
}

/// Does this entry have a line frozen by a FINISHED reconciliation? Called by
/// lib/ledgerServer.voidEntry, which is where the freeze is enforced.
export async function finishedReconciliationBlocking(
  clubId: string,
  entryId: string,
): Promise<{ periodEnd: string; accountName: string } | null> {
  const line = await prisma.glJournalLine.findFirst({
    where: { clubId, entryId, reconciliation: { status: "FINISHED" } },
    select: { reconciliation: { select: { periodEnd: true } }, account: { select: { number: true, name: true } } },
  });
  if (!line?.reconciliation) return null;
  return {
    periodEnd: toDateStr(line.reconciliation.periodEnd)!,
    accountName: `${line.account.number} ${line.account.name}`,
  };
}
