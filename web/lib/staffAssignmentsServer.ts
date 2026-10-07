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
import { hasPermission } from "@/lib/permissions";
import { recordStaffActivity } from "@/lib/staffActivity";
import { sendEmail } from "@/lib/email";
import { hasPermissionLive } from "@/lib/apiGuard";
import { assignmentVerdict, type AssignmentVerdict } from "@/lib/staffSelf";

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

/**
 * THE check for any write that changes who is on a class or an event
 * (rule: lib/staffSelf.ts "Assignments"). Call it BEFORE writing.
 *
 *   `before`     the ids on it now
 *   `requested`  the ids the caller wants on it
 *
 * Both lists are reduced to this club's current OWNER/STAFF first, so a
 * made-up id, a member's id or another club's id can never be written, and a
 * stale id left over from a removed coach does not read as a change.
 * `schedule:edit` is read LIVE (database, 20s cache), never from the token.
 */
export async function checkAssignmentChange(
  session: { user?: { id?: string; role?: string; clubId?: string; permissions?: Record<string, unknown> | null } } | null,
  clubId: string,
  before: string[],
  requested: string[],
): Promise<{ verdict: AssignmentVerdict; after: string[]; before: string[]; canManage: boolean }> {
  const [canManage, valid] = await Promise.all([
    hasPermissionLive(session, "schedule", "edit"),
    validScheduleStaffIds(clubId, [...before, ...requested]),
  ]);
  const ok = new Set(valid);
  const uniq = (ids: string[]) => Array.from(new Set(ids.filter((id) => ok.has(id))));
  const b = uniq(before);
  const a = uniq(requested);
  // Without schedule:edit the only possible "allow" is a self-removal, and that
  // is for staff only — a MEMBER session can never reach it.
  const role = session?.user?.role;
  const actorId = role === "OWNER" || role === "STAFF" ? session?.user?.id : null;
  return { verdict: assignmentVerdict({ canManage, actorId, before: b, after: a }), after: a, before: b, canManage };
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

/**
 * A coach WITHOUT schedule-management access took themself off a class or an
 * event (the one assignment change they may make — lib/staffSelf.ts). Tell the
 * people who now have a gap to cover: the other coaches on it, every owner,
 * and every staff member with schedule:edit.
 *
 * Three channels, all best-effort and all AFTER the write has committed (never
 * inside a transaction — a failed notice must not undo or block the removal):
 *   - a line in the leaver's Recent activity (StaffActivity, kind ASSIGNMENT)
 *   - an in-app message from the leaver to each recipient (same mechanism the
 *     private-lesson "you've been assigned" notice uses)
 *   - an email to each recipient (lib/email.sendEmail; a no-op without SMTP)
 */
export async function notifySelfRemoval(input: {
  clubId: string;
  actorId: string;
  actorName: string | null | undefined;
  /** "Tuesday Advanced" / the event's name. */
  what: string;
  /** "every week" | "on Oct 14" | "" for an event. */
  when?: string;
  /** Other people on the same class/event. */
  otherCoachIds: string[];
}): Promise<{ notified: number }> {
  const who = (input.actorName ?? "").trim() || "A coach";
  const whenPart = input.when ? ` ${input.when}` : "";
  const body = `${who} took themself off ${input.what}${whenPart}. It may need someone to cover.`;
  try {
    await recordStaffActivity({
      clubId: input.clubId,
      staffUserId: input.actorId,
      actorUserId: input.actorId,
      actorName: input.actorName ?? null,
      kind: "ASSIGNMENT",
      summary: `Took themself off ${input.what}${whenPart}`,
    });
    const staff = await prisma.user.findMany({
      where: { clubId: input.clubId, role: { in: ["OWNER", "STAFF"] }, deletedAt: null },
      select: { id: true, email: true, role: true, staffProfile: { select: { permissions: true } } },
    });
    const others = new Set(input.otherCoachIds);
    const recipients = staff.filter(
      (u) =>
        u.id !== input.actorId &&
        (u.role === "OWNER" ||
          others.has(u.id) ||
          hasPermission((u.staffProfile?.permissions ?? null) as Record<string, unknown> | null, "schedule", "edit")),
    );
    if (recipients.length === 0) return { notified: 0 };
    await prisma.message.createMany({
      data: recipients.map((r) => ({ clubId: input.clubId, senderId: input.actorId, recipientId: r.id, body })),
    });
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    await Promise.allSettled(
      recipients
        .filter((r) => !!r.email)
        .map((r) =>
          sendEmail({
            to: r.email,
            subject: `${who} is off ${input.what}${whenPart}`,
            html: `<p style="font-size:15px;color:#1C1917">${esc(body)}</p><p style="font-size:13px;color:#57534e">Open the staff schedule to assign someone else.</p>`,
          }),
        ),
    );
    return { notified: recipients.length };
  } catch (err) {
    console.error("[staffAssignments] self-removal notice failed", err);
    return { notified: 0 };
  }
}
