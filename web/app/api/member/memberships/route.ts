import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/member/memberships
// Returns active memberships the member is allowed to purchase (purchaseAccess=ANYONE).
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const memberships = await prisma.membership.findMany({
    where: {
      clubId: session.user.clubId,
      deletedAt: null,
      active: true,
      purchaseAccess: "ANYONE",
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      description: true,
      options: true,
      autoRenewDefault: true,
      contractMonths: true,
    },
  });

  // The member's existing active subscriptions, so the page can show "Current plan"
  const memberProfile = await prisma.member.findFirst({
    where: { userId: session.user.id, clubId: session.user.clubId, deletedAt: null },
    select: {
      id: true,
      subscriptions: {
        where: { status: { in: ["active", "past_due"] } },
        select: { id: true, membershipId: true, optionLabel: true, status: true },
      },
    },
  });

  return NextResponse.json({
    memberships,
    activeSubscriptions: memberProfile?.subscriptions ?? [],
    hasMemberProfile: !!memberProfile,
  });
}
