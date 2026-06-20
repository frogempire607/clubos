import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveFamilyContext } from "@/lib/memberContext";

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

  // Family-aware: the viewer can buy for their own profile or any child they
  // guardian, so report all accessible profiles for the switcher.
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { email: true },
  });
  const resolved = user
    ? await resolveFamilyContext(session.user.id, session.user.clubId, user.email)
    : null;
  const accessible = resolved && resolved !== "FORBIDDEN" ? resolved.accessible : [];
  const defaultMemberId = resolved && resolved !== "FORBIDDEN" ? resolved.context?.id ?? null : null;

  return NextResponse.json({
    products,
    accessible,
    defaultMemberId,
    hasMemberProfile: accessible.length > 0,
  });
}
