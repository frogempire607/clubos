// Coach assignments — the database half. See lib/staffAssignments.ts for the
// map of every place staff assignments are stored and read.
//
// Every write that changes WHO WORKS AN EVENT goes through here, so the
// things hanging off that roster cannot go stale:
//   - EventCompAssignment: a coach taken off an event loses their UNPAID comp
//     row for it (a generated payout is ledger history and is never touched).
//   - Event.responsibleCoachUserId: a coach taken off an event stops being its
//     signup approver, unless the same save names them again.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { removedIds } from "@/lib/staffAssignments";

/** Every schedulable person in the club: OWNER + STAFF, not deleted. Owners coach too. */
export async function listScheduleStaff(clubId: string) {
  return prisma.user.findMany({
    where: { clubId, role: { in: ["OWNER", "STAFF"] }, deletedAt: null },
    select: { id: true, firstName: true, lastName: true, email: true, role: true, staffProfile: { select: { title: true } } },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });
}

/** Keep only ids that are OWNER/STAFF users of this club (drops anything else silently). */
export async function validScheduleStaffIds(clubId: string, ids: string[]): Promise<string[]> {
  const uniq = Array.from(new Set(ids.filter((x) => typeof x === "string" && x)));
  if (uniq.length === 0) return [];
  const rows = await prisma.user.findMany({
    where: { id: { in: uniq }, clubId, role: { in: ["OWNER", "STAFF"] }, deletedAt: null },
    select: { id: true },
  });
  const ok = new Set(rows.map((r) => r.id));
  return uniq.filter((id) => ok.has(id));
}

/** Value to write to ClassSession.staffOverride: null clears it (inherit the series). */
export function staffOverrideValue(ids: string[] | null): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return ids === null ? Prisma.DbNull : (Array.from(new Set(ids)) as Prisma.InputJsonValue);
}

/** Put one person on an event (idempotent). */
export async function addEventStaff(clubId: string, eventId: string, userId: string, role = "COACH") {
  return prisma.eventStaffAssignment.upsert({
    where: { eventId_userId: { eventId, userId } },
    update: { role },
    create: { clubId, eventId, userId, role },
    include: { user: { select: { id: true, firstName: true, lastName: true } } },
  });
}

/** Put someone on an event without touching an existing row's role. */
export async function addEventStaffIfMissing(clubId: string, eventId: string, userId: string) {
  await prisma.eventStaffAssignment.createMany({
    data: [{ clubId, eventId, userId, role: "COACH" }],
    skipDuplicates: true,
  });
}

/**
 * Take people off an event, and everything that follows the roster with them.
 * `keepResponsibleCoach` — the same save explicitly set the responsible coach,
 * so respect it.
 */
export async function removeEventStaff(
  clubId: string,
  eventId: string,
  userIds: string[],
  opts?: { keepResponsibleCoach?: boolean },
): Promise<{ removed: number; compRowsRemoved: number; responsibleCoachCleared: boolean }> {
  const ids = Array.from(new Set(userIds));
  if (ids.length === 0) return { removed: 0, compRowsRemoved: 0, responsibleCoachCleared: false };
  const [del, comp] = await prisma.$transaction([
    prisma.eventStaffAssignment.deleteMany({ where: { clubId, eventId, userId: { in: ids } } }),
    prisma.eventCompAssignment.deleteMany({
      where: { clubId, eventId, payeeType: "STAFF", userId: { in: ids }, payoutId: null },
    }),
  ]);
  let cleared = false;
  if (!opts?.keepResponsibleCoach) {
    const r = await prisma.event.updateMany({
      where: { id: eventId, clubId, responsibleCoachUserId: { in: ids } },
      data: { responsibleCoachUserId: null },
    });
    cleared = r.count > 0;
  }
  return { removed: del.count, compRowsRemoved: comp.count, responsibleCoachCleared: cleared };
}

/**
 * Replace an event's roster with exactly `userIds` (validated to this club's
 * OWNER/STAFF). Removed people go through removeEventStaff.
 */
export async function setEventStaff(
  clubId: string,
  eventId: string,
  userIds: string[],
  opts?: { keepResponsibleCoach?: boolean },
): Promise<{ staffIds: string[]; removed: string[] }> {
  const next = await validScheduleStaffIds(clubId, userIds);
  const current = await prisma.eventStaffAssignment.findMany({
    where: { clubId, eventId },
    select: { userId: true },
  });
  const before = current.map((c) => c.userId);
  const gone = removedIds(before, next);
  await removeEventStaff(clubId, eventId, gone, opts);
  const toAdd = next.filter((id) => !before.includes(id));
  if (toAdd.length > 0) {
    await prisma.eventStaffAssignment.createMany({
      data: toAdd.map((userId) => ({ clubId, eventId, userId, role: "COACH" })),
      skipDuplicates: true,
    });
  }
  return { staffIds: next, removed: gone };
}
