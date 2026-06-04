import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/member/private-packages
//
// Returns the private-lesson packages a member can buy directly from the
// portal shop. Filtered to: owner has flipped `publishedToMembers=true`
// AND `active=true`. All pricing modes (FLAT, PERCENT, FIXED) are
// surfaced — the inline display in /member/privates renders only after
// the member picks a lesson type, and price/credits is consistent enough
// across modes that the per-lesson cost shown is always sensible. The
// pricingMode + discountValue are included in the response so the UI
// can label tier-priced packages clearly if needed later.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "MEMBER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const packages = await prisma.privatePackage.findMany({
    where: {
      clubId: session.user.clubId,
      deletedAt: null,
      active: true,
      publishedToMembers: true,
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      description: true,
      lessonType: { select: { title: true } },
      lessonTypeIds: true,
      credits: true,
      bonusCredits: true,
      price: true,
      pricingMode: true,
      discountValue: true,
      expiresAfterDays: true,
    },
  });

  // Cast Decimal → Number at the API boundary so the client never has to
  // hand-parse Prisma's Decimal wrapper.
  return NextResponse.json({
    packages: packages.map((p) => ({
      ...p,
      price: Number(p.price),
      discountValue: p.discountValue == null ? null : Number(p.discountValue),
    })),
  });
}
