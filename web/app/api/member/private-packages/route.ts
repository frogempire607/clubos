import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/member/private-packages
//
// Returns the private-lesson packages a member can buy directly from the
// portal shop. Filtered to: owner has flipped `publishedToMembers=true`
// AND `active=true` AND `pricingMode === "FLAT"`. PERCENT/FIXED packages
// stay owner-only for now because they require the buyer to pick a
// lesson type + coach tier before the price is known; that UX is a
// follow-up and isn't shipping with the first cut of the shop.
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
      pricingMode: "FLAT",
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
      expiresAfterDays: true,
    },
  });

  // Cast Decimal → Number at the API boundary so the client never has to
  // hand-parse Prisma's Decimal wrapper.
  return NextResponse.json({
    packages: packages.map((p) => ({
      ...p,
      price: Number(p.price),
    })),
  });
}
