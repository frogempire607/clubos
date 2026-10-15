import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive } from "@/lib/apiGuard";
import { purchaseTrialFor } from "@/lib/freeTrial";

// GET /api/members/[id]/purchase-trial?membershipId=…   (billing:full)
//
// For the staff "Add membership" modal: would a free trial apply if this
// member bought this plan by card right now, and when would the first charge
// be if they waited for it? null trial = there is nothing to wait for, the
// card is charged at checkout. /api/members/subscribe re-derives it.
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "billing", "full");
  if (denied) return denied;
  const membershipId = new URL(req.url).searchParams.get("membershipId") ?? "";
  const [member, membership, club] = await Promise.all([
    prisma.member.findFirst({ where: { id, clubId: session.user.clubId, deletedAt: null }, select: { id: true, trialEndsAt: true } }),
    prisma.membership.findFirst({
      where: { id: membershipId, clubId: session.user.clubId, deletedAt: null },
      select: { id: true, trialEnabled: true, trialDays: true, trialAppliesToReturning: true },
    }),
    prisma.club.findUnique({ where: { id: session.user.clubId }, select: { freeTrialConfig: true } }),
  ]);
  if (!member || !membership) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const t = await purchaseTrialFor(club?.freeTrialConfig, membership, member);
  return NextResponse.json({
    trial: t ? { kind: t.kind, days: t.days, firstChargeAt: t.firstChargeAt.toISOString() } : null,
  });
}
