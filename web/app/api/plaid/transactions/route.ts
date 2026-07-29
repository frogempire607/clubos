import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { plaidClient } from "@/lib/plaid";
import { prisma } from "@/lib/prisma";
import { getTierFeatures } from "@/lib/tier";
import { suggestExpenseCategory } from "@/lib/categoryMatcher";
import type { Prisma } from "@prisma/client";

// GET /api/plaid/transactions?connectionId=&range=&from=&to=&page=&pageSize=&reviewed=
//   - `connectionId`: scope to one bank; empty means every active bank.
//   - `range`: one of `30 | 60 | 90 | ytd | year | all | custom`. Defaults to `30`.
//     `custom` requires `from` and `to` (YYYY-MM-DD).
//   - `page` / `pageSize`: pagination (server-side). pageSize capped at 500.
//   - `reviewed`: `all | needs_review | reviewed`. Defaults to `all`.
//
// Reads from the persisted `PlaidTransaction` table (populated by
// /api/plaid/sync). Live balances still come from Plaid — they don't have
// a persistence story yet.
//
// Response shape stays back-compat with the pre-persistence version so the
// existing Bank tab keeps working: `{ connected, accounts[], transactions[],
// connections[], earliestAvailableDate, activeConnectionId }`.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const club = await prisma.club.findUnique({ where: { id: session.user.clubId } });
  const features = getTierFeatures(club?.tier ?? "growth");
  if (!features.plaid) {
    return NextResponse.json(
      {
        error: "Bank integration requires a Pro plan or higher.",
        code: "UPGRADE_REQUIRED",
        upgradeRequired: "pro",
      },
      { status: 403 },
    );
  }

  const url = new URL(req.url);
  const filterConnectionId = url.searchParams.get("connectionId");
  const range = (url.searchParams.get("range") || "30").toLowerCase();
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");
  const page = Math.max(1, Number(url.searchParams.get("page") || "1"));
  const pageSize = Math.min(500, Math.max(10, Number(url.searchParams.get("pageSize") || "50")));
  const reviewed = url.searchParams.get("reviewed") || "all";

  const allConnections = await prisma.plaidConnection.findMany({
    where: { clubId: session.user.clubId, deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      label: true,
      institutionName: true,
      accessToken: true,
      syncCursor: {
        select: {
          cursor: true,
          earliestAvailableDate: true,
          lastSyncedAt: true,
          lastSyncError: true,
        },
      },
    },
  });

  const activeConnections = filterConnectionId
    ? allConnections.filter((c) => c.id === filterConnectionId)
    : allConnections;

  const uiConnections = allConnections.map((c) => ({
    id: c.id,
    label: c.label,
    institutionName: c.institutionName,
  }));

  if (activeConnections.length === 0) {
    return NextResponse.json({
      connected: allConnections.length > 0,
      accounts: [],
      transactions: [],
      connections: uiConnections,
      earliestAvailableDate: null,
      pagination: { total: 0, page: 1, pageSize },
    });
  }

  // Live balances still come from Plaid — we don't persist them. Individual
  // failures don't break the response.
  const accountsPerConn = await Promise.all(
    activeConnections.map(async (conn) => {
      try {
        const res = await plaidClient.accountsGet({ access_token: conn.accessToken });
        return res.data.accounts.map((a) => ({
          ...a,
          connectionId: conn.id,
          connectionLabel: conn.label || conn.institutionName || "Bank",
        }));
      } catch (e) {
        console.error(`Plaid accountsGet failed for ${conn.id}:`, e);
        return [];
      }
    }),
  );
  const accounts = accountsPerConn.flat();

  // Resolve the date window.
  const now = new Date();
  const todayISO = now.toISOString().slice(0, 10);
  let fromDate: Date | null = null;
  let toDate: Date | null = null;
  const dayMs = 86400000;
  if (range === "30") fromDate = new Date(now.getTime() - 30 * dayMs);
  else if (range === "60") fromDate = new Date(now.getTime() - 60 * dayMs);
  else if (range === "90") fromDate = new Date(now.getTime() - 90 * dayMs);
  else if (range === "ytd") fromDate = new Date(now.getFullYear(), 0, 1);
  else if (range === "year") fromDate = new Date(now.getTime() - 365 * dayMs);
  else if (range === "all") fromDate = null;
  else if (range === "custom") {
    if (fromParam) fromDate = new Date(`${fromParam}T00:00:00.000Z`);
    if (toParam) toDate = new Date(`${toParam}T23:59:59.999Z`);
  }

  const connectionIds = activeConnections.map((c) => c.id);

  const reviewedFilter: Prisma.PlaidTransactionWhereInput =
    reviewed === "needs_review"
      ? { reviewedAt: null, categorizedExpenseId: null, markedAsTransfer: false, excludedFromTax: false }
      : reviewed === "reviewed"
        ? { OR: [{ reviewedAt: { not: null } }, { categorizedExpenseId: { not: null } }, { markedAsTransfer: true }, { excludedFromTax: true }] }
        : {};

  const where: Prisma.PlaidTransactionWhereInput = {
    clubId: session.user.clubId,
    plaidConnectionId: { in: connectionIds },
    ...(fromDate || toDate
      ? {
          date: {
            ...(fromDate ? { gte: fromDate } : {}),
            ...(toDate ? { lte: toDate } : {}),
          },
        }
      : {}),
    ...reviewedFilter,
  };

  const [total, rows] = await Promise.all([
    prisma.plaidTransaction.count({ where }),
    prisma.plaidTransaction.findMany({
      where,
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { connection: { select: { id: true, label: true, institutionName: true } } },
    }),
  ]);

  const transactions = rows.map((r) => ({
    id: r.id,
    transaction_id: r.plaidTransactionId, // legacy compatibility
    date: r.date.toISOString().slice(0, 10),
    name: r.name,
    merchantName: r.merchantName,
    amount: Number(r.amount),
    category: (r.category as unknown as string[] | null) ?? null,
    personalFinanceCategoryPrimary: r.personalFinanceCategoryPrimary,
    personalFinanceCategoryDetailed: r.personalFinanceCategoryDetailed,
    pending: r.pending,
    paymentChannel: r.paymentChannel,
    connectionId: r.plaidConnectionId,
    connectionLabel: r.connection.label || r.connection.institutionName || "Bank",
    // Review state
    reviewedAt: r.reviewedAt,
    categorizedExpenseId: r.categorizedExpenseId,
    categoryOverride: r.categoryOverride,
    markedAsTransfer: r.markedAsTransfer,
    excludedFromTax: r.excludedFromTax,
    notes: r.notes,
    suggestedCategory: suggestExpenseCategory(r.merchantName, r.name),
  }));

  // The earliest available date across the active connections. Falls back to
  // the earliest row we actually persisted if the cursor didn't record it.
  const earliestFromCursors = activeConnections
    .map((c) => c.syncCursor?.earliestAvailableDate)
    .filter((d): d is Date => !!d);
  const earliestAvailableDate =
    earliestFromCursors.length > 0
      ? new Date(Math.min(...earliestFromCursors.map((d) => d.getTime())))
      : null;

  // Sync freshness — the UI can nudge the owner to click Sync when the last
  // pull is stale (over 24h) or errored.
  const syncStatus = activeConnections.map((c) => ({
    connectionId: c.id,
    lastSyncedAt: c.syncCursor?.lastSyncedAt ?? null,
    lastSyncError: c.syncCursor?.lastSyncError ?? null,
  }));

  return NextResponse.json({
    connected: allConnections.length > 0,
    accounts,
    transactions,
    connections: uiConnections,
    activeConnectionId: filterConnectionId || null,
    earliestAvailableDate: earliestAvailableDate?.toISOString().slice(0, 10) ?? null,
    todayISO,
    syncStatus,
    pagination: { total, page, pageSize },
  });
}

// DELETE /api/plaid/transactions?connectionId=...
//   - With `connectionId`: soft-delete that one bank connection (also drops
//     its persisted PlaidTransaction rows via ON DELETE CASCADE).
//   - Without: clear ALL bank connections (legacy "disconnect bank" behavior).
export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const connectionId = url.searchParams.get("connectionId");

  if (connectionId) {
    const conn = await prisma.plaidConnection.findFirst({
      where: { id: connectionId, clubId: session.user.clubId, deletedAt: null },
    });
    if (!conn) return NextResponse.json({ error: "Not found" }, { status: 404 });
    await prisma.plaidConnection.update({
      where: { id: conn.id },
      data: { deletedAt: new Date() },
    });
  } else {
    await prisma.plaidConnection.updateMany({
      where: { clubId: session.user.clubId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }

  return NextResponse.json({ ok: true });
}
