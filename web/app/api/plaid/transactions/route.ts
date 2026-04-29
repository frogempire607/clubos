import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { plaidClient } from "@/lib/plaid";
import { prisma } from "@/lib/prisma";
import { getTierFeatures } from "@/lib/tier";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const club = await prisma.club.findUnique({ where: { id: session.user.clubId } });

  // Tier gate: Plaid requires Growth+
  const features = getTierFeatures(club?.tier ?? "starter");
  if (!features.plaid) {
    return NextResponse.json(
      {
        error: "Bank integration requires a Growth plan or higher.",
        code: "UPGRADE_REQUIRED",
        upgradeRequired: "growth",
      },
      { status: 403 }
    );
  }

  if (!club?.plaidAccessToken) {
    return NextResponse.json({ connected: false, accounts: [], transactions: [] });
  }

  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const startDate = thirtyDaysAgo.toISOString().split("T")[0];
    const endDate   = new Date().toISOString().split("T")[0];

    const [accountsRes, txRes] = await Promise.all([
      plaidClient.accountsGet({ access_token: club.plaidAccessToken }),
      plaidClient.transactionsGet({
        access_token: club.plaidAccessToken,
        start_date: startDate,
        end_date: endDate,
        options: { count: 50 },
      }),
    ]);

    return NextResponse.json({
      connected: true,
      accounts: accountsRes.data.accounts,
      transactions: txRes.data.transactions,
    });
  } catch (err) {
    console.error("Plaid transactions error:", err);
    return NextResponse.json({ error: "Failed to fetch bank data" }, { status: 500 });
  }
}

export async function DELETE() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await prisma.club.update({
    where: { id: session.user.clubId },
    data: { plaidAccessToken: null, plaidItemId: null },
  });

  return NextResponse.json({ ok: true });
}
