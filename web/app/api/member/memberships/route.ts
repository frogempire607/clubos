import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveFamilyContext } from "@/lib/memberContext";
import { trialForMembership } from "@/lib/freeTrial";

// GET /api/member/memberships
// Returns active memberships the member is allowed to purchase (purchaseAccess=ANYONE),
// plus the family profiles the viewer can buy for and each one's active subs.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [membershipsRaw, club] = await Promise.all([
    prisma.membership.findMany({
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
        trialEnabled: true,
        trialDays: true,
        trialAppliesToReturning: true,
      },
    }),
    prisma.club.findUnique({
      where: { id: session.user.clubId },
      select: { freeTrialConfig: true },
    }),
  ]);

  // The trial pill reflects the club's central Free Trial offer (legacy
  // per-membership flags only for clubs that never configured it). Keeps the
  // response shape the portal page already renders.
  const memberships = membershipsRaw.map((m) => {
    const trial = trialForMembership(club?.freeTrialConfig, m);
    return {
      ...m,
      trialEnabled: !!trial,
      trialDays: trial?.days ?? null,
      trialAppliesToReturning: trial?.allowRepeatUse ?? false,
    };
  });

  // Family-aware: the viewer's own profile + every child they guardian.
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { email: true },
  });
  const resolved = user
    ? await resolveFamilyContext(session.user.id, session.user.clubId, user.email)
    : null;
  const accessible = resolved && resolved !== "FORBIDDEN" ? resolved.accessible : [];

  // Active subscriptions per accessible profile, so the page can show "Current
  // plan" for whichever profile is selected.
  const accessibleIds = accessible.map((m) => m.id);
  const activeSubs = accessibleIds.length
    ? await prisma.memberSubscription.findMany({
        where: { memberId: { in: accessibleIds }, status: { in: ["active", "past_due"] } },
        select: { id: true, memberId: true, membershipId: true, optionLabel: true, status: true },
      })
    : [];
  const activeByMember: Record<string, typeof activeSubs> = {};
  for (const s of activeSubs) (activeByMember[s.memberId] ||= []).push(s);

  const defaultId = resolved && resolved !== "FORBIDDEN" ? resolved.context?.id ?? null : null;

  return NextResponse.json({
    memberships,
    accessible,
    defaultMemberId: defaultId,
    activeByMember,
    // Back-compat: subs for the default profile.
    activeSubscriptions: defaultId ? activeByMember[defaultId] ?? [] : [],
    hasMemberProfile: accessible.length > 0,
  });
}
