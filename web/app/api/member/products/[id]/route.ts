import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveFamilyContext } from "@/lib/memberContext";
import { storeView } from "@/lib/productStore";

// GET /api/member/products/[id] — one product for the store detail screen
// (B10 2e): photos, member price, option groups and per-variant stock, plus
// the family profiles the viewer can buy for. Same visibility rules as the list.
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const product = await prisma.product.findFirst({
    where: {
      id,
      clubId: session.user.clubId,
      deletedAt: null,
      active: true,
      visibility: { in: ["MEMBERS_ONLY", "MEMBERS_AND_PUBLIC"] },
      showLocation: { in: ["MEMBER_PORTAL", "PUBLIC_CHECKOUT"] },
    },
    select: {
      id: true, name: true, description: true, price: true, category: true, productType: true,
      imageUrl: true, trackInventory: true, inventory: true, settings: true,
    },
  });
  if (!product) return NextResponse.json({ error: "Product not available" }, { status: 404 });

  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { email: true } });
  const resolved = user ? await resolveFamilyContext(session.user.id, session.user.clubId, user.email) : null;
  const accessible = resolved && resolved !== "FORBIDDEN" ? resolved.accessible : [];
  const defaultMemberId = resolved && resolved !== "FORBIDDEN" ? resolved.context?.id ?? null : null;

  return NextResponse.json({
    product: storeView(product),
    accessible,
    defaultMemberId,
    hasMemberProfile: accessible.length > 0,
  });
}
