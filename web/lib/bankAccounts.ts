// Bank accounts and the legal entity whose books each belongs to (2026-10-14).
//
// A bank CONNECTION is one login at one bank; it can hold several ACCOUNTS
// (checking, savings, a card). Each account belongs to at most one legal
// entity, and an entity can have any number of accounts — "two banks for the
// LLC" and "the Foundation's own bank" are both just accounts → entity.
//
// Every bank row (PlaidTransaction) carries its account's entity in
// legalEntityId, so the entity filter on Financials, the Tax Summary and the
// reports can never mix the Foundation's money into the LLC's. Moving an
// account to another entity re-stamps its rows (paid or not — a bank row has
// no "paid" lock; reports simply read the new owner).
//
// A MANUAL connection is an account kept by hand (a closed account, a card
// that isn't linked to Plaid): it is never synced, and its rows come only
// from imports.
import crypto from "crypto";
import { prisma } from "@/lib/prisma";

export type PlaidAccountLike = {
  account_id: string;
  name?: string | null;
  official_name?: string | null;
  mask?: string | null;
  type?: string | null;
  subtype?: string | null;
};

export const MANUAL_ACCOUNT_ID = "manual";

/** Make sure every account Plaid reports has its row (names refreshed; entity never touched). */
export async function ensureBankAccounts(clubId: string, connectionId: string, accounts: readonly PlaidAccountLike[]): Promise<void> {
  for (const a of accounts) {
    if (!a.account_id) continue;
    const data = {
      name: a.name ?? null, officialName: a.official_name ?? null, mask: a.mask ?? null,
      type: a.type ?? null, subtype: a.subtype ?? null,
    };
    await prisma.bankAccount.upsert({
      where: { plaidConnectionId_accountId: { plaidConnectionId: connectionId, accountId: a.account_id } },
      create: { clubId, plaidConnectionId: connectionId, accountId: a.account_id, ...data },
      update: data,
    });
  }
}

/** "<connectionId>|<accountId>" → legalEntityId (null = not assigned). */
export async function accountEntityMap(clubId: string, connectionIds?: readonly string[]): Promise<Map<string, string | null>> {
  const rows = await prisma.bankAccount.findMany({
    where: { clubId, ...(connectionIds ? { plaidConnectionId: { in: [...connectionIds] } } : {}) },
    select: { plaidConnectionId: true, accountId: true, legalEntityId: true },
  });
  return new Map(rows.map((r) => [`${r.plaidConnectionId}|${r.accountId}`, r.legalEntityId]));
}

/** Put an account on an entity's books (or none) and re-stamp its bank rows. */
export async function assignAccountEntity(clubId: string, bankAccountId: string, legalEntityId: string | null): Promise<{ ok: true; moved: number } | { ok: false; error: string }> {
  const acct = await prisma.bankAccount.findFirst({ where: { id: bankAccountId, clubId }, select: { id: true, plaidConnectionId: true, accountId: true } });
  if (!acct) return { ok: false, error: "Bank account not found." };
  if (legalEntityId) {
    const ent = await prisma.legalEntity.findFirst({ where: { id: legalEntityId, clubId }, select: { id: true } });
    if (!ent) return { ok: false, error: "Entity not found." };
  }
  await prisma.bankAccount.update({ where: { id: acct.id }, data: { legalEntityId } });
  const moved = await prisma.plaidTransaction.updateMany({
    where: { clubId, plaidConnectionId: acct.plaidConnectionId, accountId: acct.accountId },
    data: { legalEntityId },
  });
  // Receipts matched to this account's rows follow their row.
  const rowIds = await prisma.plaidTransaction.findMany({
    where: { clubId, plaidConnectionId: acct.plaidConnectionId, accountId: acct.accountId },
    select: { id: true },
  });
  if (rowIds.length) {
    await prisma.receipt.updateMany({ where: { clubId, plaidTransactionId: { in: rowIds.map((r) => r.id) } }, data: { legalEntityId } });
  }
  return { ok: true, moved: moved.count };
}

/** An account kept by hand: its own MANUAL connection + one account row. */
export async function createManualAccount(clubId: string, args: { name: string; legalEntityId: string | null; mask?: string | null; type?: string | null }) {
  if (args.legalEntityId) {
    const ent = await prisma.legalEntity.findFirst({ where: { id: args.legalEntityId, clubId }, select: { id: true } });
    if (!ent) throw new Error("Entity not found.");
  }
  const conn = await prisma.plaidConnection.create({
    data: {
      clubId, kind: "MANUAL", label: args.name, institutionName: null,
      // Never used: MANUAL connections are skipped by every Plaid call.
      accessToken: "", itemId: `manual:${crypto.randomBytes(12).toString("hex")}`,
    },
  });
  return prisma.bankAccount.create({
    data: {
      clubId, plaidConnectionId: conn.id, accountId: MANUAL_ACCOUNT_ID, name: args.name,
      mask: args.mask ?? null, type: args.type ?? "other", legalEntityId: args.legalEntityId,
    },
  });
}

export type BankAccountView = {
  id: string;
  connectionId: string;
  connectionLabel: string;
  institution: string | null;
  kind: "PLAID" | "MANUAL";
  name: string;
  mask: string | null;
  type: string | null;
  legalEntityId: string | null;
  rowCount: number;
  firstDate: string | null;
  lastDate: string | null;
};

/** Every account the club has, with its entity and how much history it holds. */
export async function listBankAccounts(clubId: string): Promise<BankAccountView[]> {
  const accounts = await prisma.bankAccount.findMany({
    where: { clubId, connection: { deletedAt: null } },
    include: { connection: { select: { id: true, label: true, institutionName: true, kind: true } } },
    orderBy: [{ createdAt: "asc" }],
  });
  // Per-account row counts and date span. A club's bank history is a few
  // thousand rows at most, so one narrow read beats a groupBy here.
  const rows = await prisma.plaidTransaction.findMany({
    where: { clubId },
    select: { plaidConnectionId: true, accountId: true, date: true },
  });
  const statOf = new Map<string, { n: number; min: Date; max: Date }>();
  for (const r of rows) {
    const k = `${r.plaidConnectionId}|${r.accountId}`;
    const s0 = statOf.get(k);
    if (!s0) statOf.set(k, { n: 1, min: r.date, max: r.date });
    else { s0.n += 1; if (r.date < s0.min) s0.min = r.date; if (r.date > s0.max) s0.max = r.date; }
  }
  return accounts.map((a) => {
    const st = statOf.get(`${a.plaidConnectionId}|${a.accountId}`);
    const label = a.connection.label || a.connection.institutionName || "Bank";
    return {
      id: a.id,
      connectionId: a.plaidConnectionId,
      connectionLabel: label,
      institution: a.connection.institutionName,
      kind: a.connection.kind === "MANUAL" ? "MANUAL" : "PLAID",
      name: a.name || a.officialName || (a.connection.kind === "MANUAL" ? label : "Account"),
      mask: a.mask,
      type: a.subtype || a.type,
      legalEntityId: a.legalEntityId,
      rowCount: st?.n ?? 0,
      firstDate: st ? st.min.toISOString().slice(0, 10) : null,
      lastDate: st ? st.max.toISOString().slice(0, 10) : null,
    };
  });
}

/** Where-clause for bank rows of one entity ("all" / empty = no filter; "none" = not assigned). */
export function bankEntityWhere(entity: string | null | undefined): { legalEntityId?: string | null } {
  if (!entity || entity === "all") return {};
  if (entity === "none") return { legalEntityId: null };
  return { legalEntityId: entity };
}
