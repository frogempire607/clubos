// Accounting Phase 2, task 3 — give every linked bank and card its own GL
// account.
//
// A club with two bank accounts and three cards cannot reconcile against a
// single "1000 Operating Checking" line: each statement needs its own ledger
// balance to tie out against. So each depository account gets a sub-account of
// 1000 and each card a sub-account of 2100, tied to the same legal entity as
// the bank account itself.
//
// ── IT GOES THROUGH lib/ledgerServer.createAccount ─────────────────────────
// Deliberately. Phase 1's rule is that one module writes gl_* tables, and
// account creation already handles number collisions, parent validation
// (same type, one level deep), sortOrder and the audit row. Re-implementing
// any of that here would be a second, slightly-different write path — exactly
// what Phase 1 set out to prevent. This module only decides WHICH account to
// ask for.
import { prisma } from "@/lib/prisma";
import { LedgerError, createAccount, type Actor } from "@/lib/ledgerServer";

/// Plaid's `type` for a credit card is "credit"; everything else we link
/// (checking, savings) is a depository asset. `subtype` is finer-grained
/// (checking/savings/credit card) but `type` is the one Plaid guarantees.
function isCard(type: string | null | undefined, subtype: string | null | undefined): boolean {
  const t = (type ?? "").toLowerCase();
  const s = (subtype ?? "").toLowerCase();
  return t === "credit" || s.includes("credit card");
}

const PARENTS = {
  bank: { number: "1000", type: "ASSET" as const, normalBalance: "DEBIT" as const },
  card: { number: "2100", type: "LIABILITY" as const, normalBalance: "CREDIT" as const },
};

/// A readable account name: "Operating Checking ••1234".
function accountName(a: { name: string | null; officialName: string | null; mask: string | null }): string {
  const base = (a.name || a.officialName || "Account").trim().slice(0, 100);
  return a.mask ? `${base} ••${a.mask}` : base;
}

/// The next free number in a parent's block. 1000 → 1001, 1002, …;
/// 2100 → 2101, 2102, …. Stops at +98 so a pathological club can't spin.
function nextFreeNumber(parentNumber: string, taken: Set<string>): string | null {
  const base = Number(parentNumber);
  for (let n = base + 1; n < base + 99; n++) {
    const candidate = String(n);
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}

export type EnsureResult = {
  /// bankAccountId → gl account id, for every bank account that now has one.
  byBankAccount: Record<string, string>;
  created: { bankAccountId: string; number: string; name: string }[];
  /// Bank accounts that could NOT be given an account, and why. Surfaced
  /// rather than swallowed — a bank with no GL account silently stops posting.
  skipped: { bankAccountId: string; reason: string }[];
};

/// Make sure every one of the club's bank and card accounts has a GL account.
///
/// Additive and idempotent:
///   · a bank account that already has `glAccountId` is left completely alone,
///     including if the club renamed its GL account;
///   · nothing is ever renamed, re-parented or deleted here;
///   · a missing 1000 or 2100 parent is reported, not invented — those come
///     from the chart template, and a club without them has a deeper problem
///     than this function should paper over.
///
/// Safe to call on every Financials load; it does nothing once the club is set
/// up.
export async function ensureBankGlAccounts(clubId: string, actor: Actor): Promise<EnsureResult> {
  const out: EnsureResult = { byBankAccount: {}, created: [], skipped: [] };

  const bankAccounts = await prisma.bankAccount.findMany({
    where: { clubId, connection: { deletedAt: null } },
    select: {
      id: true,
      name: true,
      officialName: true,
      mask: true,
      type: true,
      subtype: true,
      legalEntityId: true,
      glAccountId: true,
    },
    orderBy: { createdAt: "asc" },
  });
  if (bankAccounts.length === 0) return out;

  const accounts = await prisma.glAccount.findMany({
    where: { clubId },
    select: { id: true, number: true, type: true, parentId: true },
  });
  if (accounts.length === 0) {
    // Not seeded yet — the accounts endpoint seeds on read, so this resolves
    // itself on the next load rather than needing an error here.
    for (const b of bankAccounts) out.skipped.push({ bankAccountId: b.id, reason: "chart of accounts not set up yet" });
    return out;
  }

  const byNumber = new Map(accounts.map((a) => [a.number, a]));
  const taken = new Set(accounts.map((a) => a.number));

  for (const b of bankAccounts) {
    if (b.glAccountId) {
      out.byBankAccount[b.id] = b.glAccountId;
      continue;
    }

    const parentSpec = isCard(b.type, b.subtype) ? PARENTS.card : PARENTS.bank;
    const parent = byNumber.get(parentSpec.number);
    if (!parent) {
      out.skipped.push({ bankAccountId: b.id, reason: `the chart has no ${parentSpec.number} account to nest under` });
      continue;
    }

    const number = nextFreeNumber(parentSpec.number, taken);
    if (!number) {
      out.skipped.push({ bankAccountId: b.id, reason: `no free account number under ${parentSpec.number}` });
      continue;
    }

    try {
      const created = await createAccount(
        clubId,
        {
          number,
          name: accountName(b),
          type: parentSpec.type,
          normalBalance: parentSpec.normalBalance,
          parentId: parent.id,
          description: isCard(b.type, b.subtype)
            ? "A linked credit card. Its statement reconciles against this account."
            : "A linked bank account. Its statement reconciles against this account.",
        },
        actor,
      );
      // Claim the number locally so a second account in the same pass doesn't
      // collide with it before the next read.
      taken.add(number);
      // updateMany + clubId so the write is tenant-scoped, not just the read.
      await prisma.bankAccount.updateMany({ where: { id: b.id, clubId }, data: { glAccountId: created.id } });
      out.byBankAccount[b.id] = created.id;
      out.created.push({ bankAccountId: b.id, number: created.number, name: created.name });
    } catch (err) {
      // One bank account failing must not stop the rest from being set up.
      const reason = err instanceof LedgerError ? err.message : "could not create the account";
      out.skipped.push({ bankAccountId: b.id, reason });
    }
  }

  return out;
}

/// bankAccountId → gl account id, plus a per-connection fallback for rows that
/// only know which bank they came from (expenses carry `plaidConnectionId`,
/// not a bank-account id).
export async function bankGlAccountMaps(clubId: string): Promise<{
  byBankAccount: Record<string, string>;
  /// Plaid `account_id` → gl account id. PlaidTransaction rows carry Plaid's
  /// own account id, not our BankAccount row id.
  byPlaidAccountId: Record<string, string>;
  byConnection: Record<string, string>;
  /// The first depository account's GL id — used as the default destination
  /// for a deposit or payout when the caller doesn't name one.
  defaultBankAccountId: string | null;
}> {
  const rows = await prisma.bankAccount.findMany({
    where: { clubId, connection: { deletedAt: null }, glAccountId: { not: null } },
    select: { id: true, accountId: true, plaidConnectionId: true, glAccountId: true, type: true, subtype: true },
    orderBy: { createdAt: "asc" },
  });

  const byBankAccount: Record<string, string> = {};
  const byPlaidAccountId: Record<string, string> = {};
  const byConnection: Record<string, string> = {};
  let defaultBankAccountId: string | null = null;

  for (const r of rows) {
    if (!r.glAccountId) continue;
    byBankAccount[r.id] = r.glAccountId;
    byPlaidAccountId[r.accountId] = r.glAccountId;
    // First account wins per connection — a connection with several accounts
    // needs the row's own account id to be precise, and this is only a
    // fallback for rows that don't carry one.
    if (!byConnection[r.plaidConnectionId]) byConnection[r.plaidConnectionId] = r.glAccountId;
    if (!defaultBankAccountId && !isCard(r.type, r.subtype)) defaultBankAccountId = r.glAccountId;
  }

  return { byBankAccount, byPlaidAccountId, byConnection, defaultBankAccountId };
}
