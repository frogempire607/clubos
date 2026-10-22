// Accounting Phase 3 — closing and reopening a month.
//
// A close sets the lock date, through setLockDate in lib/ledgerServer.ts — the
// same function the lock-date setting uses, so there is one mechanism and one
// audit trail. There is no separate "closed" flag the ledger consults: two
// sources of truth for "can I post to January?" would eventually disagree, and
// the one that loses would be the one stopping the entry.
//
// The checklist rules are in lib/glClose.ts (pure, proven by
// scripts/gl-close-tests.ts). This module gathers the facts.
//
// Every query is scoped by clubId.

import { prisma } from "@/lib/prisma";
import { LedgerError, listLockDates, setLockDate, type Actor } from "@/lib/ledgerServer";
import { postPendingForClub } from "@/lib/glPostingServer";
import { depreciationOutstanding } from "@/lib/glAssetsServer";
import {
  type CloseFacts,
  evaluateChecklist,
  isValidMonthKey,
  lockDateForClose,
  closeWouldUnlock,
  monthLabel,
  periodEnd,
  periodStart,
  validateReopen,
} from "@/lib/glClose";

const ymd = (d: Date): string => d.toISOString().slice(0, 10);
const asDate = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

export type MonthCloseView = {
  monthKey: string;
  monthLabel: string;
  periodStart: string;
  periodEnd: string;
  legalEntityId: string;
  legalEntityName: string;
  status: "OPEN" | "CLOSED";
  lockedThrough: string | null;
  /// True when the lock date already covers this month, whether or not a close
  /// row exists — a club that set the lock by hand is in that position.
  lockedByDate: boolean;
  closedAt: string | null;
  closedByName: string | null;
  reopenedAt: string | null;
  reopenReason: string | null;
  facts: CloseFacts;
  checklist: ReturnType<typeof evaluateChecklist>;
  /// Set when closing this month would NOT move the lock forwards, because a
  /// later month is already closed. The close is still allowed (it records the
  /// month), but the warning says the lock is unchanged.
  lockUnchanged: boolean;
  /// The checklist AS RECORDED when the month was closed, if it has been. The
  /// live one above answers a different question; an auditor wants this one.
  snapshot: unknown;
};

async function entityOrThrow(clubId: string, legalEntityId: string) {
  const e = await prisma.legalEntity.findFirst({
    where: { id: legalEntityId, clubId },
    select: { id: true, name: true },
  });
  if (!e) throw new LedgerError("That entity doesn't exist in this club.", 404);
  return e;
}

/// Everything the checklist needs, gathered concurrently.
async function gatherFacts(
  clubId: string,
  legalEntityId: string,
  monthKey: string,
  actor: Actor,
  undepositedAcknowledged: boolean,
): Promise<CloseFacts> {
  const from = periodStart(monthKey);
  const to = periodEnd(monthKey);

  const [accounts, finished, sweep, uncategorized, undepositedAccount, depDue] = await Promise.all([
    // Bank and card accounts that can be reconciled at all.
    prisma.glAccount.findMany({
      where: { clubId, bankAccounts: { some: { connection: { deletedAt: null } } } },
      select: { id: true, number: true, name: true },
    }),
    prisma.glReconciliation.findMany({
      where: {
        clubId,
        status: "FINISHED",
        periodStart: { lte: asDate(from) },
        periodEnd: { gte: asDate(to) },
      },
      select: { accountId: true },
    }),
    // A DRY RUN of the real sweep. It writes nothing and reuses the one
    // definition of what posts, so this can never disagree with it.
    postPendingForClub(clubId, actor, { dryRun: true, limit: 2000 }),
    prisma.plaidTransaction.count({
      where: {
        clubId,
        date: { gte: asDate(from), lte: asDate(to) },
        categoryOverride: null,
        categorizedExpenseId: null,
        reviewedAt: null,
        markedAsTransfer: false,
        excludedFromTax: false,
        ...(legalEntityId ? { OR: [{ legalEntityId }, { legalEntityId: null }] } : {}),
      },
    }),
    prisma.glAccount.findFirst({
      where: { clubId, systemKey: "UNDEPOSITED_FUNDS" },
      select: { id: true },
    }),
    depreciationOutstanding(clubId, monthKey, legalEntityId),
  ]);

  const reconciledIds = new Set(finished.map((f) => f.accountId));
  const unreconciledAccounts = accounts
    .filter((a) => !reconciledIds.has(a.id))
    .map((a) => `${a.number} ${a.name}`);

  // Undeposited funds AT MONTH END, cumulative from the start of the books —
  // a period balance would say nothing about what is still sitting there.
  let undepositedCents = 0;
  if (undepositedAccount) {
    const agg = await prisma.glJournalLine.aggregate({
      where: {
        clubId,
        accountId: undepositedAccount.id,
        entry: { clubId, status: "POSTED", entryDate: { lte: asDate(to) } },
      },
      _sum: { debitCents: true, creditCents: true },
    });
    undepositedCents = (agg._sum.debitCents ?? 0) - (agg._sum.creditCents ?? 0);
  }

  // Only records dated in or before this month hold this month's close up. A
  // bare total would let a permanently-stuck record dated in March block
  // January's close forever.
  const waitingToPost = Object.entries(sweep.postedByMonth)
    .filter(([m]) => m <= monthKey)
    .reduce((sum, [, n]) => sum + n, 0);

  return {
    unreconciledAccounts,
    reconcilableCount: accounts.length,
    waitingToPost,
    uncategorizedBankRows: uncategorized,
    undepositedCents,
    undepositedAcknowledged,
    depreciationDue: depDue,
  };
}

export async function loadMonthClose(
  clubId: string,
  legalEntityId: string,
  monthKey: string,
  actor: Actor,
  opts?: { undepositedAcknowledged?: boolean },
): Promise<MonthCloseView> {
  if (!isValidMonthKey(monthKey)) throw new LedgerError("Pick a month (YYYY-MM).");
  const entity = await entityOrThrow(clubId, legalEntityId);

  const [row, locks, facts] = await Promise.all([
    prisma.glMonthClose.findFirst({
      where: { clubId, legalEntityId, periodMonth: asDate(periodStart(monthKey)) },
    }),
    listLockDates(clubId),
    gatherFacts(clubId, legalEntityId, monthKey, actor, opts?.undepositedAcknowledged === true),
  ]);

  const lock = locks.find((l) => l.legalEntityId === legalEntityId)?.lockedThrough ?? null;
  const closedBy = row?.closedByUserId
    ? await prisma.user.findFirst({
        where: { id: row.closedByUserId, clubId },
        select: { firstName: true, lastName: true },
      })
    : null;

  return {
    monthKey,
    monthLabel: monthLabel(monthKey),
    periodStart: periodStart(monthKey),
    periodEnd: periodEnd(monthKey),
    legalEntityId,
    legalEntityName: entity.name,
    status: row?.status === "CLOSED" ? "CLOSED" : "OPEN",
    lockedThrough: lock,
    lockedByDate: !!lock && lock >= periodEnd(monthKey),
    closedAt: row?.closedAt?.toISOString() ?? null,
    closedByName: closedBy ? `${closedBy.firstName ?? ""} ${closedBy.lastName ?? ""}`.trim() || null : null,
    reopenedAt: row?.reopenedAt?.toISOString() ?? null,
    reopenReason: row?.reopenReason ?? null,
    facts,
    checklist: evaluateChecklist(facts),
    lockUnchanged: closeWouldUnlock(monthKey, lock),
    snapshot: row?.checklist ?? null,
  };
}

/// Close a month: record the snapshot, then raise the lock date.
///
/// The checklist is re-evaluated HERE, server-side, from facts gathered now —
/// never trusted from the request. The button on screen can be stale, and
/// "ready" is a claim about the books, not about the page.
export async function closeMonth(
  clubId: string,
  legalEntityId: string,
  monthKey: string,
  actor: Actor,
  opts?: { undepositedAcknowledged?: boolean; note?: string | null },
): Promise<MonthCloseView> {
  if (!isValidMonthKey(monthKey)) throw new LedgerError("Pick a month (YYYY-MM).");
  await entityOrThrow(clubId, legalEntityId);

  const view = await loadMonthClose(clubId, legalEntityId, monthKey, actor, {
    undepositedAcknowledged: opts?.undepositedAcknowledged,
  });
  if (view.status === "CLOSED") throw new LedgerError("That month is already closed.", 409);
  if (!view.checklist.ready) {
    throw new LedgerError(
      `This month isn't ready to close: ${view.checklist.blockers.join("; ")}.`,
      409,
    );
  }

  const locks = await listLockDates(clubId);
  const currentLock = locks.find((l) => l.legalEntityId === legalEntityId)?.lockedThrough ?? null;
  const nextLock = lockDateForClose(monthKey, currentLock);

  await prisma.glMonthClose.upsert({
    where: {
      clubId_legalEntityId_periodMonth: {
        clubId,
        legalEntityId,
        periodMonth: asDate(periodStart(monthKey)),
      },
    },
    create: {
      clubId,
      legalEntityId,
      periodMonth: asDate(periodStart(monthKey)),
      status: "CLOSED",
      checklist: view.checklist as unknown as object,
      // What to put BACK on a reopen. Stored before the lock moves, because
      // after it moves this is unknowable — and a club that closed December
      // then January must get December's lock back when January reopens, not
      // an unlocked year.
      lockDateBefore: currentLock ? asDate(currentLock) : null,
      closedAt: new Date(),
      closedByUserId: actor.userId,
      reopenedAt: null,
      reopenedByUserId: null,
      reopenReason: null,
    },
    update: {
      status: "CLOSED",
      checklist: view.checklist as unknown as object,
      lockDateBefore: currentLock ? asDate(currentLock) : null,
      closedAt: new Date(),
      closedByUserId: actor.userId,
      reopenedAt: null,
      reopenedByUserId: null,
      reopenReason: null,
    },
  });

  await setLockDate(
    clubId,
    legalEntityId,
    nextLock,
    opts?.note?.trim() || `${monthLabel(monthKey)} closed`,
    actor,
  );

  return loadMonthClose(clubId, legalEntityId, monthKey, actor);
}

/// Reopen a month. Owner-only (enforced in the route), reason required, and
/// the lock date goes back to whatever it was before the close — not to null.
export async function reopenMonth(
  clubId: string,
  legalEntityId: string,
  monthKey: string,
  reason: string,
  actor: Actor,
): Promise<MonthCloseView> {
  if (!isValidMonthKey(monthKey)) throw new LedgerError("Pick a month (YYYY-MM).");
  await entityOrThrow(clubId, legalEntityId);
  const check = validateReopen(reason);
  if (!check.ok) throw new LedgerError(check.reason ?? "A reason is required.");

  const row = await prisma.glMonthClose.findFirst({
    where: { clubId, legalEntityId, periodMonth: asDate(periodStart(monthKey)) },
  });
  if (!row || row.status !== "CLOSED") throw new LedgerError("That month isn't closed.", 409);

  await prisma.glMonthClose.update({
    where: { id: row.id },
    data: {
      status: "OPEN",
      reopenedAt: new Date(),
      reopenedByUserId: actor.userId,
      reopenReason: reason.trim(),
    },
  });

  // setLockDate writes its own audit row, so the reopen is in the ledger's
  // audit trail as well as on the close row.
  await setLockDate(
    clubId,
    legalEntityId,
    row.lockDateBefore ? ymd(row.lockDateBefore) : null,
    `${monthLabel(monthKey)} reopened: ${reason.trim()}`,
    actor,
  );

  return loadMonthClose(clubId, legalEntityId, monthKey, actor);
}

/// Every month that has a close row, newest first — the history strip.
export async function listCloses(clubId: string, legalEntityId?: string | null) {
  const rows = await prisma.glMonthClose.findMany({
    where: { clubId, ...(legalEntityId ? { legalEntityId } : {}) },
    include: { legalEntity: { select: { name: true } } },
    orderBy: [{ periodMonth: "desc" }],
    take: 60,
  });
  return rows.map((r) => ({
    id: r.id,
    monthKey: ymd(r.periodMonth).slice(0, 7),
    monthLabel: monthLabel(ymd(r.periodMonth).slice(0, 7)),
    legalEntityId: r.legalEntityId,
    legalEntityName: r.legalEntity?.name ?? null,
    status: r.status,
    closedAt: r.closedAt?.toISOString() ?? null,
    reopenedAt: r.reopenedAt?.toISOString() ?? null,
    reopenReason: r.reopenReason,
    checklist: r.checklist,
  }));
}
