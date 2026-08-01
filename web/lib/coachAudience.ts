// Coach-restricted audience (plan §3L example).
//
//   "A coach may email athletes assigned to their program without seeing
//    the entire club's member list or financial information."
//
// A staff user with messages:send but WITHOUT the messages.audience_all_club
// sub-scope may only address members enrolled in a class or event they
// currently teach. "Enrolled" is derived — the shape we have today is
// attendance history (`AttendanceRecord`) on classes they're assigned to
// (via `RecurringClass.assignedStaffIds`) plus event registrations they
// staff (via `EventStaffAssignment`). We deliberately include event
// registrations too so a clinic coach can email their registered
// athletes even before check-in.
//
// Enforcement: computeCoachAudienceMemberIds(userId, clubId) returns the
// SET of memberIds the coach may address. Every bulk / audience path
// intersects the caller's requested memberIds with this set before
// enqueueing sends. Requested ids OUTSIDE the set are dropped, not just
// hidden — a coach fabricating a memberId in the request payload must
// not send to a member they don't own.

import { prisma } from "@/lib/prisma";
import { hasMessagesSubScope } from "@/lib/permissions";

export interface CoachAudienceContext {
  role?: string;
  userId: string;
  clubId: string;
  permissions?: Record<string, unknown> | null;
}

// Owner OR staff with audience_all_club → null (no restriction).
// Any other staff with messages:send → a Set of allowed memberIds.
export async function computeCoachAudienceMemberIds(ctx: CoachAudienceContext): Promise<Set<string> | null> {
  if (ctx.role === "OWNER") return null;
  if (hasMessagesSubScope(ctx.permissions ?? null, "audience_all_club")) return null;

  // The three sources of coach-audience membership:
  //   (1) attendance recorded on any session of a recurring class where
  //       this user is in RecurringClass.assignedStaffIds
  //   (2) event registrations (Booking + EventRegistration) for events
  //       where this user has an EventStaffAssignment
  //   (3) private-lesson bookings for lessons this coach ran
  // All three folded into a single Set — a coach who teaches a class
  // AND owns an event both count.
  const [classes, eventAssignments, privates] = await Promise.all([
    prisma.recurringClass.findMany({
      where: { clubId: ctx.clubId },
      select: { id: true, assignedStaffIds: true },
    }),
    prisma.eventStaffAssignment.findMany({
      where: { userId: ctx.userId, event: { clubId: ctx.clubId } },
      select: { eventId: true },
    }),
    prisma.privateBooking.findMany({
      where: { clubId: ctx.clubId, coachId: ctx.userId },
      select: { memberId: true },
    }),
  ]);

  const myClassIds = classes
    .filter((c) => {
      const arr = Array.isArray(c.assignedStaffIds) ? c.assignedStaffIds : [];
      return arr.includes(ctx.userId);
    })
    .map((c) => c.id);

  const eventIds = eventAssignments.map((a) => a.eventId);

  const [attendanceRows, bookingRows, regRows] = await Promise.all([
    myClassIds.length
      ? prisma.attendanceRecord.findMany({
          where: {
            clubId: ctx.clubId,
            classSession: { classId: { in: myClassIds } },
          },
          select: { memberId: true },
          distinct: ["memberId"],
        })
      : Promise.resolve([]),
    eventIds.length
      ? prisma.booking.findMany({
          where: { eventId: { in: eventIds } },
          select: { memberId: true },
          distinct: ["memberId"],
        })
      : Promise.resolve([]),
    eventIds.length
      ? prisma.eventRegistration.findMany({
          where: { eventId: { in: eventIds }, memberId: { not: null } },
          select: { memberId: true },
          distinct: ["memberId"],
        })
      : Promise.resolve([]),
  ]);

  const set = new Set<string>();
  for (const a of attendanceRows) if (a.memberId) set.add(a.memberId);
  for (const b of bookingRows) if (b.memberId) set.add(b.memberId);
  for (const r of regRows) if (r.memberId) set.add(r.memberId);
  for (const p of privates) if (p.memberId) set.add(p.memberId);
  return set;
}

// Convenience — filter a requested memberId list down to what the caller
// is allowed to address. Owner / audience_all_club returns the input
// unchanged. Returns { allowed, dropped } so callers can surface the
// dropped ids in the pre-send review.
export async function filterMemberIdsByCoachAudience(
  ctx: CoachAudienceContext,
  requestedIds: string[],
): Promise<{ allowed: string[]; dropped: string[] }> {
  const allowedSet = await computeCoachAudienceMemberIds(ctx);
  if (allowedSet === null) return { allowed: requestedIds, dropped: [] };
  const allowed: string[] = [];
  const dropped: string[] = [];
  for (const id of requestedIds) {
    if (allowedSet.has(id)) allowed.push(id);
    else dropped.push(id);
  }
  return { allowed, dropped };
}
