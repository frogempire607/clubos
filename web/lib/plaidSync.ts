// Plaid `/transactions/sync` persistence layer. Replaces the old live-fetch
// path so the Bank tab can offer date-range filters wider than 30 days and
// so Money-Out matching (Phase 1C) has a real bank ledger to hang off.
//
// One entry point:
//   syncConnection(connectionId) — pull every page of updates since the last
//   cursor, upsert PlaidTransaction rows, advance the cursor, capture the
//   earliest-available date.
//
// Sync is idempotent. Plaid's dedup key is `transaction_id`; we mirror that
// as our `plaidTransactionId @unique`. Pending → posted transitions replace
// the row in place (Plaid emits the new transaction_id AND removes the old
// one; the "removed" pass drops the old row).

import type { PlaidApi } from "plaid";
import { Prisma, type PrismaClient } from "@prisma/client";

// Extract the least common denominator from Plaid's `Transaction` shape so we
// don't blow up if their SDK drops or reshapes a field.
type PlaidTxLike = {
  transaction_id: string;
  account_id: string;
  amount: number;
  iso_currency_code?: string | null;
  date: string; // YYYY-MM-DD
  name: string;
  merchant_name?: string | null;
  payment_channel?: string | null;
  category?: string[] | null;
  personal_finance_category?: { primary?: string | null; detailed?: string | null } | null;
  pending?: boolean;
};

export type SyncResult = {
  added: number;
  modified: number;
  removed: number;
  earliestDate: Date | null;
  cursor: string | null;
  // True when Plaid indicated there is more data to fetch; caller can
  // re-run to continue. syncConnection already loops until `has_more` is
  // false, so callers rarely need this.
  hasMore: boolean;
  error?: string;
};

const PAGE_SIZE = 500;
const MAX_PAGES = 40; // 20k transactions per sync run — plenty for a club

// Convert Plaid's YYYY-MM-DD to a Date at UTC midnight.
function parseDate(d: string): Date {
  return new Date(`${d}T00:00:00.000Z`);
}

function mapTx(src: PlaidTxLike, clubId: string, connectionId: string) {
  return {
    clubId,
    plaidConnectionId: connectionId,
    plaidTransactionId: src.transaction_id,
    accountId: src.account_id,
    amount: new Prisma.Decimal(src.amount),
    isoCurrencyCode: src.iso_currency_code ?? null,
    date: parseDate(src.date),
    name: src.name,
    merchantName: src.merchant_name ?? null,
    paymentChannel: src.payment_channel ?? null,
    category: src.category ? (src.category as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
    personalFinanceCategoryPrimary: src.personal_finance_category?.primary ?? null,
    personalFinanceCategoryDetailed: src.personal_finance_category?.detailed ?? null,
    pending: src.pending ?? false,
  };
}

/**
 * Pull every page of updates since the last cursor. Loops through Plaid's
 * `has_more` pagination up to MAX_PAGES. Idempotent — safe to re-run.
 *
 * On the first call for a connection (cursor is null), Plaid returns the
 * FULL account history, so we capture `earliestAvailableDate` here and never
 * overwrite it once set.
 */
export async function syncConnection(
  prisma: PrismaClient,
  plaidClient: PlaidApi,
  connectionId: string,
): Promise<SyncResult> {
  const connection = await prisma.plaidConnection.findFirst({
    where: { id: connectionId, deletedAt: null },
    select: { id: true, clubId: true, accessToken: true },
  });
  if (!connection) {
    return { added: 0, modified: 0, removed: 0, earliestDate: null, cursor: null, hasMore: false, error: "Connection not found" };
  }

  const state = await prisma.plaidSyncCursor.upsert({
    where: { plaidConnectionId: connection.id },
    create: {
      clubId: connection.clubId,
      plaidConnectionId: connection.id,
    },
    update: {},
  });

  let cursor: string | null = state.cursor;
  let earliestDate: Date | null = state.earliestAvailableDate;
  let added = 0;
  let modified = 0;
  let removed = 0;
  let hasMore = true;
  let pages = 0;

  try {
    while (hasMore && pages < MAX_PAGES) {
      pages += 1;
      const res = await plaidClient.transactionsSync({
        access_token: connection.accessToken,
        cursor: cursor ?? undefined,
        count: PAGE_SIZE,
      });
      const data = res.data;

      // Upsert added / modified in the same loop — both branches carry the
      // full transaction shape so the write is identical.
      for (const raw of data.added) {
        const row = mapTx(raw as PlaidTxLike, connection.clubId, connection.id);
        if (!earliestDate || row.date < earliestDate) earliestDate = row.date;
        await prisma.plaidTransaction.upsert({
          where: { plaidTransactionId: row.plaidTransactionId },
          create: { ...row, syncedAt: new Date() },
          update: { ...row, syncedAt: new Date() },
        });
        added += 1;
      }
      for (const raw of data.modified) {
        const row = mapTx(raw as PlaidTxLike, connection.clubId, connection.id);
        if (!earliestDate || row.date < earliestDate) earliestDate = row.date;
        await prisma.plaidTransaction.upsert({
          where: { plaidTransactionId: row.plaidTransactionId },
          create: { ...row, syncedAt: new Date() },
          update: { ...row, syncedAt: new Date() },
        });
        modified += 1;
      }
      // Removed transactions: Plaid tells us the id is gone (usually a
      // pending → posted swap). We drop the row; if it was matched to an
      // expense, we null the back-reference and leave the expense.
      if (data.removed.length) {
        const ids = data.removed.map((r) => r.transaction_id).filter(Boolean) as string[];
        if (ids.length) {
          await prisma.expense.updateMany({
            where: { clubId: connection.clubId, matchedPlaidTransactionId: { in: ids } },
            data: { matchedPlaidTransactionId: null },
          });
          const r = await prisma.plaidTransaction.deleteMany({
            where: { clubId: connection.clubId, plaidTransactionId: { in: ids } },
          });
          removed += r.count;
        }
      }

      cursor = data.next_cursor;
      hasMore = data.has_more;
    }

    await prisma.plaidSyncCursor.update({
      where: { plaidConnectionId: connection.id },
      data: {
        cursor,
        earliestAvailableDate: earliestDate,
        lastSyncedAt: new Date(),
        lastSyncError: null,
      },
    });

    return { added, modified, removed, earliestDate, cursor, hasMore };
  } catch (err) {
    const msg = (err as Error).message || "Sync failed";
    await prisma.plaidSyncCursor.update({
      where: { plaidConnectionId: connection.id },
      data: { lastSyncError: msg, lastSyncedAt: new Date() },
    });
    return {
      added,
      modified,
      removed,
      earliestDate,
      cursor,
      hasMore: false,
      error: msg,
    };
  }
}
