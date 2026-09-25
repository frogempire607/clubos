import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive } from "@/lib/apiGuard";
import { inventoryRows } from "@/lib/productInventory";

// GET /api/products/inventory — B10 2c. Every tracked variant (or plain count)
// across all products, worst first, with units sold in the last 30 days.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "view");
  if (denied) return denied;
  const clubId = session.user.clubId;
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [products, sold] = await Promise.all([
    prisma.product.findMany({
      where: { clubId, deletedAt: null },
      select: { id: true, name: true, price: true, productType: true, active: true, trackInventory: true, inventory: true, settings: true, imageUrl: true },
    }),
    prisma.productSale.groupBy({
      by: ["productId", "variantId"],
      where: { clubId, status: "COMPLETED", createdAt: { gte: since } },
      _sum: { quantity: true },
    }),
  ]);
  const soldMap = new Map(sold.map((s) => [`${s.productId}|${s.variantId ?? ""}`, s._sum.quantity ?? 0]));
  return NextResponse.json(inventoryRows(products, (pid, vid) => soldMap.get(`${pid}|${vid ?? ""}`) ?? 0));
}
