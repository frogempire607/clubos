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

  const succeeded = transactions.filter((t) => t.status === "SUCCEEDED");
  const totalRevenue = succeeded.reduce((s, t) => s + Number(t.amount), 0);
  const totalFees = succeeded.reduce((s, t) => s + Number(t.platformFee || 0), 0);

  return NextResponse.json({
    transactions,
    totals: { revenue: totalRevenue, platformFees: totalFees, net: totalRevenue - totalFees },
  });
}
