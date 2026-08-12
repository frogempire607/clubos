import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ACTIVE_GUARDIAN_LINK } from "@/lib/familyAccess";
import { baseUrlFromRequest } from "@/lib/baseUrl";
import { resolveEventPolicy } from "@/lib/eventPayments";
import { renderableRegistrationState } from "@/lib/registrationRenderState";

// GET /api/member/registrations
//
// Every event registration belonging to the signed-in user's family, rendered
// through the SAME resolver as the confirmation page and every lifecycle email
// (§5.2.2). The member portal previously had no way to show these at all: a
// registration awaiting a coach has no Booking by design (§5.4.5), and Bookings
// is what /member/bookings reads — so a family who registered for a tournament
// saw nothing until a coach approved them.
//
// Read-only. Answering a proposal is the two POST routes under
// /api/member/events/[id]/registrations/[regId]/proposal.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const viewer = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      memberProfile: { select: { id: true } },
      guardianOf: { where: ACTIVE_GUARDIAN_LINK, select: { memberId: true } },
    },
  });
  const memberIds = [
    ...(viewer?.memberProfile ? [viewer.memberProfile.id] : []),
    ...(viewer?.guardianOf ?? []).map((g) => g.memberId),
  ];
  if (memberIds.length === 0) return NextResponse.json({ registrations: [] });

  const rows = await prisma.eventRegistration.findMany({
    where: {
      clubId: session.user.clubId,
      memberId: { in: memberIds },
      // Canceled registrations stay as history on the confirmation page, but
      // the portal list is about what is live.
      status: { not: "CANCELED" },
      event: { deletedAt: null },
    },
    orderBy: { createdAt: "desc" },
    include: {
      event: { include: { customEventType: { select: { defaultPolicy: true } }, location: true } },
      member: { select: { id: true, firstName: true, lastName: true } },
    },
  });
  if (rows.length === 0) return NextResponse.json({ registrations: [] });

  const club = await prisma.club.findUnique({
    where: { id: session.user.clubId },
    select: { name: true, contactEmail: true, contactPhone: true, timezone: true },
  });

  // The divisor for a variable-cost split, per event, in one query.
  const counts = await prisma.eventRegistration.groupBy({
    by: ["eventId"],
    where: { eventId: { in: [...new Set(rows.map((r) => r.eventId))] }, status: { not: "CANCELED" } },
    _count: { _all: true },
  });
  const activeByEvent = new Map(counts.map((c) => [c.eventId, c._count._all]));

  // baseUrlFromRequest, not getAppBaseUrl: this is a live request from a
  // browser, and a Netlify preview deploy must link back to itself (§5.2.3).
  const baseUrl = baseUrlFromRequest(req);

  const registrations = rows.map((reg) => {
    const ctx = renderableRegistrationState({
      registration: reg,
      event: reg.event,
      club: club ?? { name: "your club" },
      activeCount: activeByEvent.get(reg.eventId) ?? 1,
      baseUrl,
      cancellationPolicyText: resolveEventPolicy(reg.event).cancellationPolicyText,
    });
    return {
      id: reg.id,
      memberId: reg.memberId,
      memberName: reg.member ? `${reg.member.firstName} ${reg.member.lastName ?? ""}`.trim() : reg.name,
      eventId: reg.eventId,
      eventName: reg.event.name,
      startsAt: reg.event.startsAt,
      key: ctx.key,
      headline: ctx.headline,
      subheadline: ctx.subheadline,
      chargeTiming: ctx.chargeTiming,
      waitingOn: ctx.waitingOn,
      waitingOnLabel: ctx.waitingOnLabel,
      severity: ctx.severity,
      confirmationCode: ctx.meta.confirmationCode,
      amountDue: ctx.meta.amountDue,
      amountPaid: ctx.meta.amountPaid,
      declineReason: ctx.meta.declineReason,
      proposedChange: ctx.meta.proposedChange,
      primaryAction: ctx.actions.primary,
      cancellationPolicyText: ctx.meta.cancellationPolicyText,
    };
  });

  return NextResponse.json({
    registrations,
    // What the portal badges: how many of these are the family's move.
    awaitingYou: registrations.filter((r) => r.waitingOn === "PARENT").length,
  });
}
