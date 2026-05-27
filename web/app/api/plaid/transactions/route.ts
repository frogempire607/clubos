import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { plaidClient } from "@/lib/plaid";
import { prisma } from "@/lib/prisma";
import { getTierFeatures } from "@/lib/tier";
import { suggestExpenseCategory } from "@/lib/categoryMatcher";

// Lazy-migrate the legacy Club.plaidAccessToken into a PlaidConnection row.
// Mirrors the helper in /api/plaid/connections; duplicated locally so this
// route stays self-contained.
async function ensureLegacyConnection(clubId: string) {
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { plaidAccessToken: true, plaidItemId: true },
  });
  if (!club?.plaidAccessToken || !club?.plaidItemId) return;
  const existing = await prisma.plaidConnection.findUnique({
    where: { itemId: club.plaidItemId },
  });
  if (existing) return;
  await prisma.plaidConnection.create({
    data: {
      clubId,
      accessToken: club.plaidAccessToken,
      itemId: club.plaidItemId,
      label: "Primary",
    },
  });
}

// GET /api/plaid/transactions?connectionId=...
//   - Without `connectionId`: aggregates accounts + transactions across
//     every active PlaidConnection for the club.
//   - With `connectionId`: returns just that connection's data.
//
// Response shape stays back-compat with the original single-bank API:
//   { connected, accounts[], transactions[], connections[] }
// `connections[]` is new — the UI uses it to render the bank filter.
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

  await ensureLegacyConnection(session.user.clubId);

  const url = new URL(req.url);
  const filterConnectionId = url.searchParams.get("connectionId");

  const connections = await prisma.plaidConnection.findMany({
    where: {
      clubId: session.user.clubId,
      deletedAt: null,
      ...(filterConnectionId ? { id: filterConnectionId } : {}),
    },
    orderBy: { createdAt: "asc" },
  });

  // Always tell the UI what connections exist so it can render the filter
  // even when none match the current selection.
  const allConnections = filterConnectionId
    ? await prisma.plaidConnection.findMany({
        where: { clubId: session.user.clubId, deletedAt: null },
        orderBy: { createdAt: "asc" },
        select: { id: true, label: true, institutionName: true },
      })
    : connections.map((c) => ({ id: c.id, label: c.label, institutionName: c.institutionName }));

  if (connections.length === 0) {
    return NextResponse.json({
      connected: false,
      accounts: [],
      transactions: [],
      connections: allConnections,
    });
  }

  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const startDate = thirtyDaysAgo.toISOString().split("T")[0];
    const endDate = new Date().toISOString().split("T")[0];

    // Fetch each connection in parallel. Individual failures don't kill
    // the whole response — we tag them with the connectionId so callers
    // can see which bank failed and retry.
    const perConnection = await Promise.all(
      connections.map(async (conn) => {
        try {
          const [accountsRes, txRes] = await Promise.all([
            plaidClient.accountsGet({ access_token: conn.accessToken }),
            plaidClient.transactionsGet({
              access_token: conn.accessToken,
              start_date: startDate,
              end_date: endDate,
              options: { count: 50 },
            }),
          ]);
          const tagged = txRes.data.transactions.map((t) => ({
            ...t,
            connectionId: conn.id,
            connectionLabel: conn.label || conn.institutionName || "Bank",
            suggestedCategory: suggestExpenseCategory(t.merchant_name, t.name),
          }));
          const accounts = accountsRes.data.accounts.map((a) => ({
            ...a,
            connectionId: conn.id,
            connectionLabel: conn.label || conn.institutionName || "Bank",
          }));
          return { accounts, transactions: tagged, error: null };
        } catch (e) {
          console.error(`Plaid fetch failed for connection ${conn.id}:`, e);
          return { accounts: [], transactions: [], error: (e as Error).message };
        }
      }),
    );

    const accounts = perConnection.flatMap((r) => r.accounts);
    const transactions = perConnection
      .flatMap((r) => r.transactions)
      .sort((a, b) => (a.date < b.date ? 1 : -1));

    return NextResponse.json({
      connected: true,
      accounts,
      transactions,
      connections: allConnections,
      activeConnectionId: filterConnectionId || null,
    });
  } catch (err) {
    console.error("Plaid transactions aggregate error:", err);
    return NextResponse.json({ error: "Failed to fetch bank data" }, { status: 500 });
  }
}

// DELETE /api/plaid/transactions?connectionId=...
//   - With `connectionId`: soft-delete that one bank connection.
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

  // Keep the legacy Club fields in sync with what's left.
  const remaining = await prisma.plaidConnection.findFirst({
    where: { clubId: session.user.clubId, deletedAt: null },
    orderBy: { createdAt: "asc" },
  });
  await prisma.club.update({
    where: { id: session.user.clubId },
    data: {
      plaidAccessToken: remaining?.accessToken ?? null,
      plaidItemId: remaining?.itemId ?? null,
    },
  });

  return NextResponse.json({ ok: true });
}
