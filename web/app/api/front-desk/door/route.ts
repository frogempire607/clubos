import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { coverageForMembers, loadSessionCoverageContext } from "@/lib/coverageQuery";
import { decideDoor, verdictCovers } from "@/lib/doorAccess";
import { freeTrialSummary, trialCoversClass, trialWindowDays } from "@/lib/freeTrial";
import { classDropInPrice } from "@/lib/attendanceBilling";

// GET /api/front-desk/door?classSessionId=&memberId=
//
// What the front desk should do with this person at this class — the SAME door
// rule the QR self check-in applies (lib/doorAccess): covered → check in;
// no plan and a trial left → start the trial; otherwise → the drop-in.
// READ-ONLY. The actions are the existing attendance routes.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "attendance", "edit");
  if (denied) return denied;
  const clubId = session.user.clubId;
  const url = new URL(req.url);
  const classSessionId = url.searchParams.get("classSessionId") || "";
  const memberId = url.searchParams.get("memberId") || "";
  if (!classSessionId || !memberId) return NextResponse.json({ error: "classSessionId and memberId are required" }, { status: 400 });

  const [cs, member, club] = await Promise.all([
    prisma.classSession.findFirst({
      where: { id: classSessionId, clubId },
      select: { id: true, startsAt: true, recurringClass: { select: { id: true, name: true, pricingOptions: true } } },
    }),
    prisma.member.findFirst({
      where: { id: memberId, clubId, deletedAt: null },
      select: {
        id: true, firstName: true, lastName: true, isMinor: true, trialEndsAt: true,
        subscriptions: { where: { status: "active" }, select: { id: true } },
      },
    }),
    prisma.club.findUnique({ where: { id: clubId }, select: { freeTrialConfig: true } }),
  ]);
  if (!cs || !member) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const ctx = await loadSessionCoverageContext(classSessionId, clubId);
  const verdict = ctx ? (await coverageForMembers([memberId], ctx, clubId)).get(memberId) ?? null : null;
  const hasSub = member.subscriptions.length > 0;
  const dropInPrice = classDropInPrice(cs.recurringClass.pricingOptions);
  const decision = decideDoor({
    covered: verdictCovers(verdict, hasSub),
    hasActiveSubscription: hasSub,
    trialWindowActive: !!member.trialEndsAt && member.trialEndsAt > new Date(),
    trialCoversClass: trialCoversClass(club?.freeTrialConfig, ctx?.acceptedMembershipIds ?? []),
    newTrialDays: trialWindowDays(club?.freeTrialConfig, member),
    dropInPrice,
  });
  const existing = await prisma.attendanceRecord.findFirst({
    where: { classSessionId, memberId },
    select: { id: true, status: true, checkedInAt: true },
  });

  return NextResponse.json({
    member: { id: member.id, name: `${member.firstName} ${member.lastName}`.trim(), firstName: member.firstName, isMinor: member.isMinor },
    session: { id: cs.id, classId: cs.recurringClass.id, className: cs.recurringClass.name, startsAt: cs.startsAt },
    decision,
    verdict: verdict ? { reason: verdict.reason, message: verdict.message, planName: verdict.planName, optionLabel: verdict.optionLabel } : null,
    dropInPrice,
    trial: freeTrialSummary(club?.freeTrialConfig),
    trialEndsAt: member.trialEndsAt,
    existing: existing ? { status: existing.status, checkedIn: !!existing.checkedInAt } : null,
  });
}
