import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import type { Prisma } from "@prisma/client";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "view");
  if (denied) return denied;

  const { searchParams } = new URL(req.url);
  const entity = searchParams.get("entity");
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  // Optional filter by Plaid bank connection. Empty/"all" = include every
  // transaction; otherwise scope to the matching plaidConnectionId.
  const bank = searchParams.get("bank");

  const where: Prisma.TransactionWhereInput = {
    clubId: session.user.clubId,
    ...(entity && entity !== "all" ? { legalEntityId: entity } : {}),
    ...(bank && bank !== "all" ? { plaidConnectionId: bank } : {}),
    ...(from || to
      ? { createdAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } }
      : {}),
  };

  const transactions = await prisma.transaction.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      member: { select: { id: true, firstName: true, lastName: true } },
      legalEntity: { select: { id: true, name: true } },
    },
    take: 250,
  });

  // Voided rows stay visible in the list (history) but never count in totals.
  const succeeded = transactions.filter(
    (t) => t.status === "SUCCEEDED" && t.reconciliationStatus !== "VOID",
  );
  const totalRevenue = succeeded.reduce((s, t) => s + Number(t.amount), 0);
  // Exact Stripe processing fees (from balance transactions) — platformFee is
  // the AthletixOS application fee and is reported separately.
  const totalStripeFees = succeeded.reduce((s, t) => s + Number(t.stripeFeeAmount || 0), 0);
  const totalPlatformFees = succeeded.reduce((s, t) => s + Number(t.platformFee || 0), 0);

  return NextResponse.json({
    transactions,
    totals: {
      revenue: totalRevenue,
      stripeFees: totalStripeFees,
      platformFees: totalPlatformFees,
      net: totalRevenue - totalStripeFees - totalPlatformFees,
    },
  });
}
