import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "view");
  if (denied) return denied;

  const transactions = await prisma.transaction.findMany({
    where: { clubId: session.user.clubId },
    orderBy: { createdAt: "desc" },
    include: {
      member: { select: { id: true, firstName: true, lastName: true } },
    },
    take: 100,
  });

  // Quick totals
  const totalRevenue = transactions
    .filter((t) => t.status === "SUCCEEDED")
    .reduce((sum, t) => sum + Number(t.amount), 0);

  const totalFees = transactions
    .filter((t) => t.status === "SUCCEEDED")
    .reduce((sum, t) => sum + Number(t.platformFee || 0), 0);

  return NextResponse.json({
    transactions,
    totals: {
      revenue: totalRevenue,
      platformFees: totalFees,
      net: totalRevenue - totalFees,
    },
  });
}
