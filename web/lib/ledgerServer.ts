// Accounting Phase 1 — THE ONLY MODULE THAT WRITES A gl_* TABLE.
//
// Every route goes through here. No route touches gl_accounts,
// gl_journal_entries, gl_journal_lines, gl_entry_attachments, gl_lock_dates or
// gl_audit_logs directly — that is what makes "all writes go through ONE ledger
// service" true rather than aspirational, and it is why the balance rule cannot
// be bypassed by a new caller that forgot to check.
//
// The RULES live in the pure lib/ledger.ts so they are testable without a
// database (scripts/ledger-tests.ts, gated in the build). This module is the
// I/O: it loads what the rules need, runs them, refuses on any error, and
// writes the mutation plus its audit row in one transaction.
//
// ── WHY PLAIN `prisma` AND NOT `tenantPrisma` ───────────────────────────────
// The RLS tenant client (lib/tenantPrisma.ts) is still a pilot: exactly one
// route uses it, web/rls/README.md says "not yet applied to production", and
// getAppPrisma() THROWS when APP_DATABASE_URL is unset. Building the ledger on
// it would make the whole feature 500 in any environment where that variable
// isn't configured.
//
// So this module follows the approach the pilot route itself documents: the
// app-level clubId filter is the live constraint, kept "so behavior is
// identical with RLS on or off". Every table still has its RLS policy
// (migration 20261020000000_gl_ledger_core) and the athletix_app grants, so the
// day the app connects as that role, Postgres enforces the same boundary
// underneath — a swap of the import, nothing else.
//
// To make the app-level half structural rather than remembered: EVERY exported
// function takes `clubId` as its first argument, and every single where-clause
// in this file includes it. A query without it is a bug, and scripts/
// ledger-tests.ts greps this file to prove none exists.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  CHART_TEMPLATE,
  type AccountFact,
  type AccountType,
  type DraftEntry,
  type DraftLine,
  deriveIntercompanyLines,
  entryTotals,
  isDateLocked,
  isValidDateOnly,
  lockedMessage,
  netByEntity,
  reverseLines,
  reversalDate,
  spansMultipleEntities,
  templateSortOrder,
  validateEntryDraft,
} from "@/lib/ledger";

/// Who did it. Routes build this from the session; scripts pass a marker.
export type Actor = { userId: string | null; name: string | null };

/// Thrown for every refusal a caller should show the user as-is. The route maps
/// `status` straight onto the HTTP response, so a message here is a message the
/// owner reads — write them accordingly.
export class LedgerError extends Error {
  status: number;
  details: string[];
  constructor(message: string, status = 400, details: string[] = []) {
    super(message);
    this.name = "LedgerError";
    this.status = status;
    this.details = details;
  }
}

const dateOnly = (s: string) => new Date(`${s}T00:00:00.000Z`);
const toDateString = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);
/// "Today" in UTC. Date-only values in this app are stored at 00:00 UTC
/// (lib/datetime.ts documents the convention), so the lock-date comparison has
/// to be made in the same frame or a late-evening entry could read as the next
/// day and slip past a lock.
const todayUTC = () => new Date().toISOString().slice(0, 10);

// ── Audit ───────────────────────────────────────────────────────────────────

type AuditInput = {
  objectType: "ACCOUNT" | "ENTRY" | "LINE" | "LOCK_DATE";
  objectId: string;
  action: "CREATE" | "UPDATE" | "VOID";
  before?: unknown;
  after?: unknown;
  note?: string | null;
};

/// Append-only. Takes a transaction client so the audit row and the mutation it
/// describes commit together — an audit trail with gaps is worse than none,
/// because it is trusted.
async function writeAudit(
  tx: Prisma.TransactionClient,
  clubId: string,
  actor: Actor,
  input: AuditInput,
): Promise<void> {
  await tx.glAuditLog.create({
    data: {
      clubId,
      objectType: input.objectType,
      objectId: input.objectId,
      action: input.action,
      actorUserId: actor.userId,
      actorName: actor.name,
      before: (input.before ?? null) as Prisma.InputJsonValue,
      after: (input.after ?? null) as Prisma.InputJsonValue,
      note: input.note ?? null,
    },
  });
}

// ── Chart of accounts ───────────────────────────────────────────────────────

const ACCOUNT_SELECT = {
  id: true,
  number: true,
  name: true,
  type: true,
  subtype: true,
  normalBalance: true,
  isContra: true,
  parentId: true,
  active: true,
  isSystem: true,
  systemKey: true,
  description: true,
  sortOrder: true,
} as const;

export type AccountRow = {
  id: string;
  number: string;
  name: string;
  type: string;
  subtype: string | null;
  normalBalance: string;
  isContra: boolean;
  parentId: string | null;
  active: boolean;
  isSystem: boolean;
  systemKey: string | null;
  description: string | null;
  sortOrder: number;
  /// How many journal lines reference this account. Non-zero = undeletable.
  postingCount: number;
};

/// Seed the template into a club that has no chart yet. Idempotent and
/// conservative:
///   · returns immediately if the club already has ANY account, so it can
///     never overwrite a renamed one or resurrect a deactivated one;
///   · matched on (clubId, number), which is a unique index, so a concurrent
///     double-call cannot duplicate the template — the second one's createMany
///     skips duplicates rather than erroring.
///
/// This is what gives "new eligible clubs get it automatically" without a cron
/// or a migration backfill: the accounts endpoint calls it on read. ELIGIBILITY
/// IS THE CALLER'S JOB — the route has already run the tier gate by the time it
/// gets here.
export async function ensureChartOfAccounts(clubId: string, actor: Actor): Promise<{ seeded: number }> {
  const existing = await prisma.glAccount.count({ where: { clubId } });
  if (existing > 0) return { seeded: 0 };

  const order = templateSortOrder();
  const result = await prisma.glAccount.createMany({
    data: CHART_TEMPLATE.map((row) => ({
      clubId,
      number: row.number,
      name: row.name,
      type: row.type,
      subtype: row.subtype ?? null,
      normalBalance: row.normalBalance,
      isContra: row.isContra ?? false,
      isSystem: row.isSystem ?? false,
      systemKey: row.systemKey ?? null,
      description: row.description ?? null,
      sortOrder: order.get(row.number) ?? 0,
      createdByUserId: actor.userId,
    })),
    skipDuplicates: true,
  });

  if (result.count > 0) {
    await prisma.glAuditLog.create({
      data: {
        clubId,
        objectType: "ACCOUNT",
        objectId: "chart",
        action: "CREATE",
        actorUserId: actor.userId,
        actorName: actor.name,
        after: { seeded: result.count, template: "sports-club" } as Prisma.InputJsonValue,
        note: `Seeded the sports-club chart of accounts (${result.count} accounts).`,
      },
    });
  }
  return { seeded: result.count };
}

/// Add any SYSTEM account the template has gained since a club was seeded.
///
/// `ensureChartOfAccounts` returns early the moment a club has any account —
/// deliberately, so it can never overwrite a renamed account or resurrect a
/// deactivated one. That also means a club seeded before a template change
/// never sees the new account, which is fine for ordinary accounts (the club
/// can add their own) and NOT fine for a system account: Phase 2's automatic
/// posting resolves those by `systemKey`, so a club missing one would fail to
/// post rather than post somewhere wrong.
///
/// So this is the additive half, and it is narrow on purpose:
///   · it only ever adds rows whose `systemKey` the club does not already have;
///   · it matches on systemKey, never on number or name, so a club that renamed
///     or renumbered an account still counts as having it;
///   · it never updates or reactivates anything that already exists.
///
/// First needed 2026-10-20, when 1020 Undeposited Funds was added to the
/// template after the first clubs had been seeded.
export async function ensureSystemAccounts(
  clubId: string,
  actor: Actor,
): Promise<{ added: { number: string; name: string; systemKey: string }[] }> {
  const wanted = CHART_TEMPLATE.filter((r) => r.isSystem && r.systemKey);
  if (wanted.length === 0) return { added: [] };

  const existing = await prisma.glAccount.findMany({
    where: { clubId },
    select: { number: true, systemKey: true },
  });
  if (existing.length === 0) return { added: [] }; // not seeded yet — that's ensureChartOfAccounts' job

  const haveKeys = new Set(existing.map((a) => a.systemKey).filter((k): k is string => !!k));
  const takenNumbers = new Set(existing.map((a) => a.number));
  const missing = wanted.filter((r) => !haveKeys.has(r.systemKey!));
  if (missing.length === 0) return { added: [] };

  const order = templateSortOrder();
  const added: { number: string; name: string; systemKey: string }[] = [];

  for (const row of missing) {
    // The template number is almost always free. If the club has already used
    // it for an account of their own, step forward to the next free number in
    // the same block rather than colliding or silently skipping — the account
    // has to exist, and its number is cosmetic next to its systemKey.
    let number = row.number;
    if (takenNumbers.has(number)) {
      const base = Number(row.number);
      let found: string | null = null;
      for (let n = base + 1; n < base + 30; n++) {
        if (!takenNumbers.has(String(n))) {
          found = String(n);
          break;
        }
      }
      if (!found) continue; // pathological; leave it for a human rather than guess wildly
      number = found;
    }
    takenNumbers.add(number);

    const created = await prisma.$transaction(async (tx) => {
      const acct = await tx.glAccount.create({
        data: {
          clubId,
          number,
          name: row.name,
          type: row.type,
          subtype: row.subtype ?? null,
          normalBalance: row.normalBalance,
          isContra: row.isContra ?? false,
          isSystem: true,
          systemKey: row.systemKey,
          description: row.description ?? null,
          sortOrder: order.get(row.number) ?? 0,
          createdByUserId: actor.userId,
        },
        select: { id: true, number: true, name: true, systemKey: true },
      });
      await writeAudit(tx, clubId, actor, {
        objectType: "ACCOUNT",
        objectId: acct.id,
        action: "CREATE",
        after: acct,
        note:
          `Added the ${acct.name} account, which the chart of accounts template gained after this club was set up.` +
          (number !== row.number ? ` Numbered ${number} because ${row.number} was already in use.` : ""),
      });
      return acct;
    });
    added.push({ number: created.number, name: created.name, systemKey: created.systemKey! });
  }

  return { added };
}

/// The chart, with each account's posting count so the UI can hide "delete" on
/// anything that has been used. One groupBy rather than a count per account.
export async function listAccounts(clubId: string, opts?: { includeInactive?: boolean }): Promise<AccountRow[]> {
  const accounts = await prisma.glAccount.findMany({
    where: { clubId, ...(opts?.includeInactive === false ? { active: true } : {}) },
    select: ACCOUNT_SELECT,
    orderBy: [{ type: "asc" }, { number: "asc" }],
  });
  const counts = await prisma.glJournalLine.groupBy({
    by: ["accountId"],
    where: { clubId },
    _count: { _all: true },
  });
  const countBy = new Map(counts.map((c) => [c.accountId, c._count._all]));
  return accounts.map((a) => ({ ...a, postingCount: countBy.get(a.id) ?? 0 }));
}

/// Accounts as the validator wants them. Cheaper than listAccounts — no counts.
async function accountFacts(clubId: string): Promise<AccountFact[]> {
  const rows = await prisma.glAccount.findMany({
    where: { clubId },
    select: { id: true, number: true, name: true, type: true, active: true, isSystem: true, systemKey: true },
  });
  return rows as AccountFact[];
}

const NUMBER_OK = /^[0-9][0-9.\-]{0,19}$/;

export async function createAccount(
  clubId: string,
  input: {
    number: string;
    name: string;
    type: string;
    subtype?: string | null;
    normalBalance?: string;
    isContra?: boolean;
    parentId?: string | null;
    description?: string | null;
  },
  actor: Actor,
): Promise<AccountRow> {
  const number = (input.number ?? "").trim();
  const name = (input.name ?? "").trim();
  if (!number || !NUMBER_OK.test(number)) {
    throw new LedgerError("Give the account a number that starts with a digit, e.g. 6310.");
  }
  if (!name) throw new LedgerError("Give the account a name.");
  if (!["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"].includes(input.type)) {
    throw new LedgerError("Pick a type: asset, liability, equity, income or expense.");
  }

  // Default the normal balance from the type when the caller doesn't say. A
  // contra account flips it — that is the whole meaning of contra.
  const base: "DEBIT" | "CREDIT" = input.type === "ASSET" || input.type === "EXPENSE" ? "DEBIT" : "CREDIT";
  const isContra = input.isContra === true;
  const normalBalance =
    input.normalBalance === "DEBIT" || input.normalBalance === "CREDIT"
      ? input.normalBalance
      : isContra
        ? base === "DEBIT"
          ? "CREDIT"
          : "DEBIT"
        : base;

  if (input.parentId) {
    const parent = await prisma.glAccount.findFirst({
      where: { id: input.parentId, clubId },
      select: { id: true, type: true },
    });
    if (!parent) throw new LedgerError("That parent account doesn't exist in this club.", 404);
    if (parent.type !== input.type) {
      throw new LedgerError("A sub-account has to be the same type as its parent.");
    }
  }

  const clash = await prisma.glAccount.findFirst({ where: { clubId, number }, select: { id: true } });
  if (clash) throw new LedgerError(`Account ${number} already exists. Pick another number.`, 409);

  // New accounts sort after everything in their section.
  const last = await prisma.glAccount.aggregate({
    where: { clubId, type: input.type },
    _max: { sortOrder: true },
  });

  return prisma.$transaction(async (tx) => {
    const created = await tx.glAccount.create({
      data: {
        clubId,
        number,
        name,
        type: input.type,
        subtype: input.subtype ?? null,
        normalBalance,
        isContra,
        parentId: input.parentId ?? null,
        description: input.description?.trim() || null,
        sortOrder: (last._max.sortOrder ?? 0) + 10,
        // A club-created account is never a system account — system accounts
        // exist because the posting engine resolves them by systemKey, and the
        // template owns that set.
        isSystem: false,
        systemKey: null,
        createdByUserId: actor.userId,
      },
      select: ACCOUNT_SELECT,
    });
    await writeAudit(tx, clubId, actor, {
      objectType: "ACCOUNT",
      objectId: created.id,
      action: "CREATE",
      after: created,
      note: `Added account ${created.number} ${created.name}.`,
    });
    return { ...created, postingCount: 0 };
  });
}

/// Rename, redescribe, re-parent, activate, deactivate.
///
/// A SYSTEM ACCOUNT CAN BE RENAMED BUT NEVER DEACTIVATED — Phase 2's automatic
/// posting resolves Stripe Clearing and Due To/From by systemKey, so losing one
/// would break posting silently. Number and type are not editable on any
/// account: both are referenced by prior postings and reports, and changing
/// either rewrites history.
export async function updateAccount(
  clubId: string,
  accountId: string,
  patch: { name?: string; description?: string | null; active?: boolean; parentId?: string | null },
  actor: Actor,
): Promise<AccountRow> {
  const before = await prisma.glAccount.findFirst({ where: { id: accountId, clubId }, select: ACCOUNT_SELECT });
  if (!before) throw new LedgerError("That account doesn't exist in this club.", 404);

  const data: Prisma.GlAccountUpdateInput = {};

  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new LedgerError("An account needs a name.");
    data.name = name;
  }
  if (patch.description !== undefined) data.description = patch.description?.trim() || null;

  if (patch.active !== undefined && patch.active !== before.active) {
    if (before.isSystem && patch.active === false) {
      throw new LedgerError(
        `"${before.number} ${before.name}" is a system account — automatic posting needs it, so it can be renamed but not deactivated.`,
      );
    }
    data.active = patch.active;
  }

  if (patch.parentId !== undefined) {
    if (patch.parentId === null) {
      data.parent = { disconnect: true };
    } else {
      if (patch.parentId === accountId) throw new LedgerError("An account can't be its own parent.");
      const parent = await prisma.glAccount.findFirst({
        where: { id: patch.parentId, clubId },
        select: { id: true, type: true, parentId: true },
      });
      if (!parent) throw new LedgerError("That parent account doesn't exist in this club.", 404);
      if (parent.type !== before.type) throw new LedgerError("A sub-account has to be the same type as its parent.");
      // One level of nesting. Deeper trees make every report's roll-up
      // ambiguous, and no club has asked for them.
      if (parent.parentId) throw new LedgerError("Sub-accounts can only go one level deep.");
      data.parent = { connect: { id: patch.parentId } };
    }
  }

  if (Object.keys(data).length === 0) {
    const n = await prisma.glJournalLine.count({ where: { clubId, accountId } });
    return { ...before, postingCount: n };
  }

  return prisma.$transaction(async (tx) => {
    // updateMany + clubId so the write itself is tenant-scoped, not just the
    // read above.
    const touched = await tx.glAccount.updateMany({ where: { id: accountId, clubId }, data });
    if (touched.count === 0) throw new LedgerError("That account doesn't exist in this club.", 404);
    const after = await tx.glAccount.findFirstOrThrow({ where: { id: accountId, clubId }, select: ACCOUNT_SELECT });
    await writeAudit(tx, clubId, actor, {
      objectType: "ACCOUNT",
      objectId: accountId,
      action: "UPDATE",
      before,
      after,
      note: `Edited account ${after.number} ${after.name}.`,
    });
    const n = await tx.glJournalLine.count({ where: { clubId, accountId } });
    return { ...after, postingCount: n };
  });
}

/// Deleting an account is allowed ONLY while it has never been posted to. The
/// FK on gl_journal_lines.accountId is RESTRICT, so the database would refuse
/// anyway — this refuses first, with a message that says what to do instead.
export async function deleteAccount(clubId: string, accountId: string, actor: Actor): Promise<void> {
  const acct = await prisma.glAccount.findFirst({ where: { id: accountId, clubId }, select: ACCOUNT_SELECT });
  if (!acct) throw new LedgerError("That account doesn't exist in this club.", 404);
  if (acct.isSystem) {
    throw new LedgerError(`"${acct.number} ${acct.name}" is a system account and can't be deleted.`);
  }
  const used = await prisma.glJournalLine.count({ where: { clubId, accountId } });
  if (used > 0) {
    throw new LedgerError(
      `"${acct.number} ${acct.name}" has ${used} posting${used === 1 ? "" : "s"}, so it can't be deleted — deleting it would change past reports. Deactivate it instead and it stops appearing on new entries.`,
    );
  }
  const kids = await prisma.glAccount.count({ where: { clubId, parentId: accountId } });
  if (kids > 0) throw new LedgerError("Move or delete its sub-accounts first.");

  await prisma.$transaction(async (tx) => {
    const gone = await tx.glAccount.deleteMany({ where: { id: accountId, clubId } });
    if (gone.count === 0) throw new LedgerError("That account doesn't exist in this club.", 404);
    await writeAudit(tx, clubId, actor, {
      objectType: "ACCOUNT",
      objectId: accountId,
      action: "UPDATE",
      before: acct,
      after: null,
      note: `Deleted unused account ${acct.number} ${acct.name}.`,
    });
  });
}

// ── Lock dates ──────────────────────────────────────────────────────────────

export type LockDateRow = { legalEntityId: string; entityName: string; lockedThrough: string; note: string | null; updatedAt: string };

export async function listLockDates(clubId: string): Promise<LockDateRow[]> {
  const rows = await prisma.glLockDate.findMany({
    where: { clubId },
    select: {
      legalEntityId: true,
      lockedThrough: true,
      note: true,
      updatedAt: true,
      legalEntity: { select: { name: true } },
    },
    orderBy: { legalEntityId: "asc" },
  });
  return rows.map((r) => ({
    legalEntityId: r.legalEntityId,
    entityName: r.legalEntity?.name ?? "Entity",
    lockedThrough: toDateString(r.lockedThrough)!,
    note: r.note,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/// legalEntityId → "YYYY-MM-DD". Loaded once per write and consulted for every
/// entity an entry touches.
async function lockMap(clubId: string): Promise<Map<string, string>> {
  const rows = await prisma.glLockDate.findMany({ where: { clubId }, select: { legalEntityId: true, lockedThrough: true } });
  return new Map(rows.map((r) => [r.legalEntityId, toDateString(r.lockedThrough)!]));
}

/// OWNER ONLY — the route enforces that with requireOwnerLive before calling.
/// Every change is audited, including moving a lock backwards (which re-opens a
/// closed period and is exactly the kind of thing an auditor asks about).
/// `lockedThrough: null` removes the lock entirely.
export async function setLockDate(
  clubId: string,
  legalEntityId: string,
  lockedThrough: string | null,
  note: string | null,
  actor: Actor,
): Promise<LockDateRow[]> {
  const entity = await prisma.legalEntity.findFirst({
    where: { id: legalEntityId, clubId },
    select: { id: true, name: true },
  });
  if (!entity) throw new LedgerError("That entity doesn't exist in this club.", 404);
  if (lockedThrough !== null && !isValidDateOnly(lockedThrough)) {
    throw new LedgerError("Pick a lock date (YYYY-MM-DD).");
  }

  const before = await prisma.glLockDate.findFirst({
    where: { clubId, legalEntityId },
    select: { lockedThrough: true, note: true },
  });

  await prisma.$transaction(async (tx) => {
    if (lockedThrough === null) {
      await tx.glLockDate.deleteMany({ where: { clubId, legalEntityId } });
    } else if (before) {
      await tx.glLockDate.updateMany({
        where: { clubId, legalEntityId },
        data: { lockedThrough: dateOnly(lockedThrough), note: note?.trim() || null, updatedByUserId: actor.userId },
      });
    } else {
      await tx.glLockDate.create({
        data: {
          clubId,
          legalEntityId,
          lockedThrough: dateOnly(lockedThrough),
          note: note?.trim() || null,
          updatedByUserId: actor.userId,
        },
      });
    }
    const beforeStr = before ? toDateString(before.lockedThrough) : null;
    const movedBack = beforeStr && lockedThrough && lockedThrough < beforeStr;
    await writeAudit(tx, clubId, actor, {
      objectType: "LOCK_DATE",
      objectId: legalEntityId,
      action: before ? "UPDATE" : "CREATE",
      before: before ? { lockedThrough: beforeStr, note: before.note } : null,
      after: lockedThrough === null ? null : { lockedThrough, note: note?.trim() || null },
      note:
        lockedThrough === null
          ? `Removed the lock date for ${entity.name} — its books are open.`
          : `${entity.name} locked through ${lockedThrough}.${movedBack ? " This REOPENED a closed period." : ""}`,
    });
  });

  return listLockDates(clubId);
}

// ── Journal entries ─────────────────────────────────────────────────────────

export type EntryLineRow = {
  id: string;
  accountId: string;
  accountNumber: string;
  accountName: string;
  debitCents: number;
  creditCents: number;
  legalEntityId: string | null;
  entityName: string | null;
  program: string | null;
  memo: string | null;
  memberId: string | null;
  lineNumber: number;
};

export type EntryRow = {
  id: string;
  entryDate: string;
  memo: string | null;
  reference: string | null;
  legalEntityId: string | null;
  entityName: string | null;
  sourceType: string;
  sourceId: string | null;
  status: string;
  isIntercompany: boolean;
  reversesEntryId: string | null;
  voidedByEntryId: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
  debitCents: number;
  creditCents: number;
  lines: EntryLineRow[];
  attachments: { id: string; fileId: string; fileName: string; mimeType: string; sizeBytes: number; url: string }[];
};

const ENTRY_INCLUDE = {
  legalEntity: { select: { name: true } },
  lines: {
    orderBy: { lineNumber: "asc" as const },
    select: {
      id: true,
      accountId: true,
      debitCents: true,
      creditCents: true,
      legalEntityId: true,
      program: true,
      memo: true,
      memberId: true,
      lineNumber: true,
      account: { select: { number: true, name: true } },
      legalEntity: { select: { name: true } },
    },
  },
  attachments: {
    orderBy: { createdAt: "asc" as const },
    select: { id: true, fileId: true, fileName: true, mimeType: true, sizeBytes: true },
  },
} as const;

type RawEntry = Prisma.GlJournalEntryGetPayload<{ include: typeof ENTRY_INCLUDE }>;

function shapeEntry(e: RawEntry): EntryRow {
  const lines: EntryLineRow[] = e.lines.map((l) => ({
    id: l.id,
    accountId: l.accountId,
    accountNumber: l.account.number,
    accountName: l.account.name,
    debitCents: l.debitCents,
    creditCents: l.creditCents,
    legalEntityId: l.legalEntityId,
    entityName: l.legalEntity?.name ?? null,
    program: l.program,
    memo: l.memo,
    memberId: l.memberId,
    lineNumber: l.lineNumber,
  }));
  const totals = entryTotals(lines);
  return {
    id: e.id,
    entryDate: toDateString(e.entryDate)!,
    memo: e.memo,
    reference: e.reference,
    legalEntityId: e.legalEntityId,
    entityName: e.legalEntity?.name ?? null,
    sourceType: e.sourceType,
    sourceId: e.sourceId,
    status: e.status,
    isIntercompany: e.isIntercompany,
    reversesEntryId: e.reversesEntryId,
    voidedByEntryId: e.voidedByEntryId,
    voidedAt: e.voidedAt?.toISOString() ?? null,
    voidReason: e.voidReason,
    createdAt: e.createdAt.toISOString(),
    debitCents: totals.debitCents,
    creditCents: totals.creditCents,
    lines,
    // Served through the EXISTING club-scoped authenticated gate. No new
    // storage route, and no public URL for an accounting document.
    attachments: e.attachments.map((a) => ({ ...a, url: `/api/files/${a.fileId}` })),
  };
}

export async function listEntries(
  clubId: string,
  filters?: {
    from?: string;
    to?: string;
    legalEntityId?: string;
    accountId?: string;
    status?: string;
    q?: string;
    take?: number;
    skip?: number;
  },
): Promise<{ entries: EntryRow[]; total: number }> {
  const where: Prisma.GlJournalEntryWhereInput = { clubId };
  if (filters?.from && isValidDateOnly(filters.from)) where.entryDate = { gte: dateOnly(filters.from) };
  if (filters?.to && isValidDateOnly(filters.to)) {
    where.entryDate = { ...(where.entryDate as object), lte: dateOnly(filters.to) };
  }
  if (filters?.legalEntityId) where.legalEntityId = filters.legalEntityId;
  if (filters?.status && filters.status !== "ALL") where.status = filters.status;
  // An account filter matches on the LINES, which is how an owner thinks about
  // it ("show me everything that hit 6000 Rent").
  if (filters?.accountId) where.lines = { some: { accountId: filters.accountId, clubId } };
  if (filters?.q?.trim()) {
    const q = filters.q.trim();
    where.OR = [
      { memo: { contains: q, mode: "insensitive" } },
      { reference: { contains: q, mode: "insensitive" } },
      { lines: { some: { clubId, memo: { contains: q, mode: "insensitive" } } } },
    ];
  }

  const take = Math.min(Math.max(filters?.take ?? 50, 1), 200);
  const [entries, total] = await Promise.all([
    prisma.glJournalEntry.findMany({
      where,
      include: ENTRY_INCLUDE,
      orderBy: [{ entryDate: "desc" }, { createdAt: "desc" }],
      take,
      skip: Math.max(filters?.skip ?? 0, 0),
    }),
    prisma.glJournalEntry.count({ where }),
  ]);
  return { entries: entries.map(shapeEntry), total };
}

export async function getEntry(clubId: string, entryId: string): Promise<EntryRow> {
  const e = await prisma.glJournalEntry.findFirst({ where: { id: entryId, clubId }, include: ENTRY_INCLUDE });
  if (!e) throw new LedgerError("That entry doesn't exist in this club.", 404);
  return shapeEntry(e);
}

/// Validate the entities named on an entry, and refuse any that aren't this
/// club's. Belt and braces with the FK: catching it here gives a readable
/// message instead of a constraint violation, and it is the check that stops a
/// hand-crafted request from referencing another club's entity id.
async function resolveEntities(clubId: string, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (wanted.length === 0) return new Map();
  const rows = await prisma.legalEntity.findMany({
    where: { clubId, id: { in: wanted } },
    select: { id: true, name: true },
  });
  if (rows.length !== wanted.length) {
    const found = new Set(rows.map((r) => r.id));
    const missing = wanted.filter((w) => !found.has(w));
    throw new LedgerError(
      `${missing.length === 1 ? "An entity" : "Some entities"} on this entry don't belong to this club.`,
      400,
    );
  }
  return new Map(rows.map((r) => [r.id, r.name]));
}

/// THE WRITE PATH for a journal entry. In order:
///   1. resolve accounts and entities (refusing anything cross-club)
///   2. run the pure validator — refuse on ANY error
///   3. check the lock date for every entity the entry touches
///   4. add intercompany Due To/From lines if it spans entities
///   5. RE-CHECK the balance after step 4
///   6. write entry + lines + audit in one transaction
///
/// Step 5 is not paranoia: step 4 adds lines, and a bug there would produce an
/// unbalanced entry that passed step 2. The ledger's one invariant gets checked
/// against what is actually about to be written.
export async function createEntry(clubId: string, draft: DraftEntry, actor: Actor): Promise<EntryRow> {
  const accounts = await accountFacts(clubId);
  if (accounts.length === 0) {
    throw new LedgerError("This club has no chart of accounts yet. Open the Chart of Accounts tab to set it up.", 409);
  }

  const errors = validateEntryDraft(draft, accounts);
  if (errors.length > 0) {
    throw new LedgerError(errors[0], 400, errors);
  }

  const entityNames = await resolveEntities(clubId, [draft.legalEntityId, ...draft.lines.map((l) => l.legalEntityId)]);

  // ── 3. lock dates, per entity touched ────────────────────────────────────
  const locks = await lockMap(clubId);
  const touched = [...new Set(draft.lines.map((l) => l.legalEntityId ?? draft.legalEntityId ?? null))];
  for (const entityId of touched) {
    if (!entityId) continue;
    const locked = locks.get(entityId);
    if (isDateLocked(draft.entryDate, locked)) {
      throw new LedgerError(lockedMessage(entityNames.get(entityId) ?? "this entity", locked!), 409);
    }
  }

  // ── 4. intercompany ──────────────────────────────────────────────────────
  // Lines inherit the entry's entity when they don't name one, so an entry
  // where the owner set the entity once at the top is NOT accidentally
  // intercompany against a pile of nulls.
  const normalized: DraftLine[] = draft.lines.map((l, i) => ({
    ...l,
    legalEntityId: l.legalEntityId ?? draft.legalEntityId ?? null,
    lineNumber: i,
  })) as DraftLine[];

  let finalLines = normalized;
  let isIntercompany = false;
  if (spansMultipleEntities(normalized)) {
    const sys = await prisma.glAccount.findMany({
      where: { clubId, systemKey: { in: ["DUE_TO", "DUE_FROM"] } },
      select: { id: true, systemKey: true, active: true, number: true, name: true },
    });
    const dueTo = sys.find((s) => s.systemKey === "DUE_TO");
    const dueFrom = sys.find((s) => s.systemKey === "DUE_FROM");
    if (!dueTo || !dueFrom) {
      throw new LedgerError(
        "This entry covers two entities, which needs the Due To / Due From accounts. They're missing from this club's chart of accounts.",
        409,
      );
    }
    const derived = deriveIntercompanyLines(normalized, {
      dueToAccountId: dueTo.id,
      dueFromAccountId: dueFrom.id,
      entityNames: Object.fromEntries(entityNames),
    });
    if (derived.length > 0) {
      finalLines = [...normalized, ...derived.map((d, i) => ({ ...d, lineNumber: normalized.length + i }))];
      isIntercompany = true;
    }
  }

  // ── 5. re-check against what is actually being written ───────────────────
  const totals = entryTotals(finalLines);
  if (!totals.balanced) {
    throw new LedgerError(
      "This entry doesn't balance after the related-entity lines were worked out. Nothing was saved — please report this.",
      500,
    );
  }
  // Each entity must now stand alone, which is the point of the derived lines.
  if (isIntercompany) {
    for (const n of netByEntity(finalLines)) {
      if (n.netCents !== 0) {
        throw new LedgerError(
          "One of the entities on this entry still doesn't balance. Nothing was saved — please report this.",
          500,
        );
      }
    }
  }

  // ── 6. write ─────────────────────────────────────────────────────────────
  const created = await prisma.$transaction(async (tx) => {
    const entry = await tx.glJournalEntry.create({
      data: {
        clubId,
        entryDate: dateOnly(draft.entryDate),
        memo: draft.memo?.trim() || null,
        legalEntityId: draft.legalEntityId ?? null,
        sourceType: draft.sourceType ?? "MANUAL",
        sourceId: draft.sourceId ?? null,
        status: "POSTED",
        reference: draft.reference?.trim() || null,
        isIntercompany,
        createdByUserId: actor.userId,
        lines: {
          create: finalLines.map((l, i) => ({
            clubId,
            accountId: l.accountId,
            debitCents: l.debitCents,
            creditCents: l.creditCents,
            legalEntityId: l.legalEntityId ?? null,
            program: l.program?.trim() || null,
            memo: l.memo?.trim() || null,
            memberId: l.memberId ?? null,
            lineNumber: i,
          })),
        },
      },
      include: ENTRY_INCLUDE,
    });
    await writeAudit(tx, clubId, actor, {
      objectType: "ENTRY",
      objectId: entry.id,
      action: "CREATE",
      after: {
        entryDate: draft.entryDate,
        memo: entry.memo,
        reference: entry.reference,
        isIntercompany,
        debitCents: totals.debitCents,
        lines: finalLines.map((l) => ({
          accountId: l.accountId,
          debitCents: l.debitCents,
          creditCents: l.creditCents,
          legalEntityId: l.legalEntityId ?? null,
        })),
      },
      note: `Posted a journal entry for ${(totals.debitCents / 100).toFixed(2)}${isIntercompany ? " (across two entities)" : ""}.`,
    });
    return entry;
  });

  return shapeEntry(created);
}

/// Void by REVERSAL, never by delete. Creates a mirror-image entry, cross-links
/// the pair, and flips the original to VOID. Both rows keep every line, so the
/// audit trail and every report run before today stay true.
///
/// The reversal posts on the original's date so the period nets to zero —
/// unless that period is closed, in which case it posts today (the standard
/// treatment, and why voiding an entry in a closed period can still succeed).
export async function voidEntry(clubId: string, entryId: string, reason: string | null, actor: Actor): Promise<{ voided: EntryRow; reversal: EntryRow }> {
  const original = await prisma.glJournalEntry.findFirst({ where: { id: entryId, clubId }, include: ENTRY_INCLUDE });
  if (!original) throw new LedgerError("That entry doesn't exist in this club.", 404);
  if (original.status === "VOID") throw new LedgerError("That entry has already been voided.", 409);
  if (original.reversesEntryId) {
    throw new LedgerError("That entry is itself a reversal. Voiding it would undo a correction — post a fresh entry instead.");
  }

  const locks = await lockMap(clubId);
  const entityIds = [...new Set(original.lines.map((l) => l.legalEntityId).filter((x): x is string => !!x))];
  const entityNames = new Map(
    original.lines.filter((l) => l.legalEntityId).map((l) => [l.legalEntityId!, l.legalEntity?.name ?? "this entity"]),
  );

  const origDate = toDateString(original.entryDate)!;
  const today = todayUTC();

  // The reversal has to land somewhere open. Compute its date per entity and
  // take the latest — one date for one entry.
  let targetDate = origDate;
  for (const id of entityIds) {
    const d = reversalDate(origDate, locks.get(id), today);
    if (d > targetDate) targetDate = d;
  }
  // If the chosen date is STILL locked for any entity, refuse. This is the
  // genuine dead end: the owner has to move the lock date.
  for (const id of entityIds) {
    const locked = locks.get(id);
    if (isDateLocked(targetDate, locked)) {
      throw new LedgerError(
        `${lockedMessage(entityNames.get(id) ?? "this entity", locked!)} The reversing entry has nowhere open to post.`,
        409,
      );
    }
  }

  const reversed = reverseLines(
    original.lines.map((l) => ({
      accountId: l.accountId,
      debitCents: l.debitCents,
      creditCents: l.creditCents,
      legalEntityId: l.legalEntityId,
      program: l.program,
      memo: l.memo,
      memberId: l.memberId,
    })),
  );

  const result = await prisma.$transaction(async (tx) => {
    // Claim the original FIRST with a conditional update, so two simultaneous
    // void clicks can't both mint a reversal. The second finds 0 rows.
    const claimed = await tx.glJournalEntry.updateMany({
      where: { id: entryId, clubId, status: "POSTED" },
      data: {
        status: "VOID",
        voidedAt: new Date(),
        voidReason: reason?.trim() || null,
        voidedByUserId: actor.userId,
      },
    });
    if (claimed.count === 0) throw new LedgerError("That entry has already been voided.", 409);

    const reversal = await tx.glJournalEntry.create({
      data: {
        clubId,
        entryDate: dateOnly(targetDate),
        memo: `Reversal of ${origDate} entry${original.memo ? `: ${original.memo}` : ""}`.slice(0, 500),
        legalEntityId: original.legalEntityId,
        sourceType: "REVERSAL",
        // Deliberately null, not the original's id: sourceId participates in
        // the (clubId, sourceType, sourceId) unique index, and a reversal is
        // identified by reversesEntryId instead.
        sourceId: null,
        status: "POSTED",
        reference: original.reference,
        isIntercompany: original.isIntercompany,
        reversesEntryId: original.id,
        createdByUserId: actor.userId,
        lines: {
          create: reversed.map((l, i) => ({
            clubId,
            accountId: l.accountId,
            debitCents: l.debitCents,
            creditCents: l.creditCents,
            legalEntityId: l.legalEntityId ?? null,
            program: l.program ?? null,
            memo: l.memo ?? null,
            memberId: l.memberId ?? null,
            lineNumber: i,
          })),
        },
      },
      include: ENTRY_INCLUDE,
    });

    await tx.glJournalEntry.updateMany({
      where: { id: entryId, clubId },
      data: { voidedByEntryId: reversal.id },
    });

    await writeAudit(tx, clubId, actor, {
      objectType: "ENTRY",
      objectId: entryId,
      action: "VOID",
      before: { status: original.status, entryDate: origDate },
      after: { status: "VOID", reversalEntryId: reversal.id, reversalDate: targetDate },
      note:
        `Voided the ${origDate} entry with a reversing entry dated ${targetDate}.` +
        (targetDate !== origDate ? " It posted today because the original period is closed." : "") +
        (reason?.trim() ? ` Reason: ${reason.trim()}` : ""),
    });

    const voided = await tx.glJournalEntry.findFirstOrThrow({ where: { id: entryId, clubId }, include: ENTRY_INCLUDE });
    return { voided, reversal };
  });

  return { voided: shapeEntry(result.voided), reversal: shapeEntry(result.reversal) };
}

// ── Attachments ─────────────────────────────────────────────────────────────

/// Records a file already stored by the caller (which uses lib/storage.ts
/// putObject + an UploadedFile row, exactly as lib/receiptsServer.ts does).
/// Verifies the UploadedFile belongs to this club — otherwise an attachment
/// could point at another club's file id and /api/files would be the only thing
/// standing in the way.
export async function addAttachment(
  clubId: string,
  entryId: string,
  file: { fileId: string; fileName: string; mimeType: string; sizeBytes: number },
  actor: Actor,
): Promise<EntryRow> {
  const entry = await prisma.glJournalEntry.findFirst({ where: { id: entryId, clubId }, select: { id: true } });
  if (!entry) throw new LedgerError("That entry doesn't exist in this club.", 404);
  const stored = await prisma.uploadedFile.findFirst({ where: { id: file.fileId, clubId }, select: { id: true } });
  if (!stored) throw new LedgerError("That file doesn't belong to this club.", 400);

  await prisma.$transaction(async (tx) => {
    const created = await tx.glEntryAttachment.create({
      data: {
        clubId,
        entryId,
        fileId: file.fileId,
        fileName: file.fileName.slice(0, 200),
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        uploadedByUserId: actor.userId,
      },
      select: { id: true, fileName: true },
    });
    await writeAudit(tx, clubId, actor, {
      objectType: "ENTRY",
      objectId: entryId,
      action: "UPDATE",
      after: { attachmentId: created.id, fileName: created.fileName },
      note: `Attached "${created.fileName}" to the entry.`,
    });
  });
  return getEntry(clubId, entryId);
}

export async function removeAttachment(clubId: string, entryId: string, attachmentId: string, actor: Actor): Promise<EntryRow> {
  const att = await prisma.glEntryAttachment.findFirst({
    where: { id: attachmentId, clubId, entryId },
    select: { id: true, fileName: true, fileId: true },
  });
  if (!att) throw new LedgerError("That attachment doesn't exist on this entry.", 404);

  await prisma.$transaction(async (tx) => {
    await tx.glEntryAttachment.deleteMany({ where: { id: attachmentId, clubId, entryId } });
    await writeAudit(tx, clubId, actor, {
      objectType: "ENTRY",
      objectId: entryId,
      action: "UPDATE",
      before: { attachmentId: att.id, fileName: att.fileName },
      after: null,
      // The UploadedFile row and the stored bytes are deliberately left alone:
      // the same discipline as every other delete path here. Detaching a
      // document is not a reason to destroy it.
      note: `Removed "${att.fileName}" from the entry. The file itself was kept.`,
    });
  });
  return getEntry(clubId, entryId);
}

// ── Audit trail ─────────────────────────────────────────────────────────────

export async function listAudit(
  clubId: string,
  filters?: { objectType?: string; objectId?: string; take?: number },
): Promise<
  {
    id: string;
    objectType: string;
    objectId: string;
    action: string;
    actorName: string | null;
    note: string | null;
    before: unknown;
    after: unknown;
    createdAt: string;
  }[]
> {
  const rows = await prisma.glAuditLog.findMany({
    where: {
      clubId,
      ...(filters?.objectType ? { objectType: filters.objectType } : {}),
      ...(filters?.objectId ? { objectId: filters.objectId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(filters?.take ?? 100, 1), 500),
  });
  return rows.map((r) => ({
    id: r.id,
    objectType: r.objectType,
    objectId: r.objectId,
    action: r.action,
    actorName: r.actorName,
    note: r.note,
    before: r.before,
    after: r.after,
    createdAt: r.createdAt.toISOString(),
  }));
}

// ── Trial-balance-ish summary (Phase 1 read-only convenience) ──────────────

/// Per-account debit/credit totals over a date range. NOT the Phase 3 trial
/// balance report — no cash/accrual toggle, no entity/program grouping, no
/// export. It exists so the Chart of Accounts tab can show a balance beside
/// each account, which is what makes a seeded chart feel real instead of empty.
///
/// VOID entries are excluded; their reversals are included, so a voided entry
/// and its reversal net to zero exactly as they should.
export async function accountBalances(
  clubId: string,
  opts?: { from?: string; to?: string; legalEntityId?: string },
): Promise<Map<string, { debitCents: number; creditCents: number }>> {
  const where: Prisma.GlJournalLineWhereInput = {
    clubId,
    entry: {
      clubId,
      status: "POSTED",
      ...(opts?.from && isValidDateOnly(opts.from) ? { entryDate: { gte: dateOnly(opts.from) } } : {}),
      ...(opts?.to && isValidDateOnly(opts.to) ? { entryDate: { lte: dateOnly(opts.to) } } : {}),
    },
    ...(opts?.legalEntityId ? { legalEntityId: opts.legalEntityId } : {}),
  };
  const rows = await prisma.glJournalLine.groupBy({
    by: ["accountId"],
    where,
    _sum: { debitCents: true, creditCents: true },
  });
  return new Map(
    rows.map((r) => [r.accountId, { debitCents: r._sum.debitCents ?? 0, creditCents: r._sum.creditCents ?? 0 }]),
  );
}

/// Signed balance in the account's own normal direction: positive means "more
/// of what this account normally holds". A debit-normal account with 500 debits
/// and 200 credits reads +300; the same numbers on a credit-normal account read
/// -300. Saves every caller from re-deriving the sign and getting it wrong.
export function signedBalanceCents(
  normalBalance: string,
  totals: { debitCents: number; creditCents: number } | undefined,
): number {
  if (!totals) return 0;
  return normalBalance === "DEBIT" ? totals.debitCents - totals.creditCents : totals.creditCents - totals.debitCents;
}

export type { AccountType };
