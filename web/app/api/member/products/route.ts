import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/member/products
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const products = await prisma.product.findMany({
    where: {
      clubId: session.user.clubId,
      deletedAt: null,
      active: true,
      visibility: { in: ["MEMBERS_ONLY", "MEMBERS_AND_PUBLIC"] },
      showLocation: { in: ["MEMBER_PORTAL", "PUBLIC_CHECKOUT"] },
    },
    orderBy: [{ category: "asc" }, { createdAt: "desc" }],
    select: {
      id: true,
      name: true,
      description: true,
      price: true,
      category: true,
      productType: true,
      imageUrl: true,
      trackInventory: true,
      inventory: true,
      visibility: true,
    },
  });

  const member = await prisma.member.findFirst({
    where: { userId: session.user.id, clubId: session.user.clubId, deletedAt: null },
    select: { id: true },
  });

  return NextResponse.json({ products, hasMemberProfile: !!member });
}
