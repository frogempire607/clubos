import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isOwnerLive, hasPermissionLive, requirePermissionLive } from "@/lib/apiGuard";
import { isCancelAudience, type CancelAudience } from "@/lib/classStaff";
import { cancelAudienceMembers, getScheduleSettings } from "@/lib/classStaffServer";
import { userOnDay } from "@/lib/classStaffApi";

// GET /api/classes/sessions/[sessionId]/cancel-preview?audience=BOOKED|CLASS_MEMBERS|BOTH|NONE
//
// For the cancel sheet, before anything is written: how many people each
// audience choice would notify ("Notify 14 families"), the club's default
// choice, and whether this viewer may choose "canceled, paid".
// `recipients` = distinct email addresses (a guardian of two athletes is one);
// `members` = athletes the notice is about. classes:edit (live).
export async function GET(req: Request, context: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "classes", "edit");
  if (denied) return denied;
  const clubId = session.user.clubId;

  const cs = await prisma.classSession.findFirst({
    where: { id: sessionId, clubId },
    select: { id: true, canceled: true, date: true, startsAt: true, endsAt: true, recurringClass: { select: { name: true } } },
  });
  if (!cs) return NextResponse.json({ error: "Class day not found", code: "NOT_FOUND" }, { status: 404 });

  const settings = await getScheduleSettings(clubId);
  const asked = new URL(req.url).searchParams.get("audience");
  const audience: CancelAudience = isCancelAudience(asked) ? asked : settings.classCancelNotifyDefault;

  // One read of the widest audience answers all four choices.
  const both = await cancelAudienceMembers(clubId, sessionId, "BOTH");
  const booked = new Set(both.bookedMemberIds);
  const classMembers = new Set(both.classMemberIds);
  const count = (keep: (memberId: string) => boolean) => ({
    members: both.memberIds.filter(keep).length,
    recipients: both.recipients.filter((r) => r.memberIds.some(keep)).length,
    noAddress: both.skipped.filter((s) => keep(s.memberId)).length,
  });
  const counts = {
    BOOKED: count((id) => booked.has(id)),
    CLASS_MEMBERS: count((id) => classMembers.has(id)),
    BOTH: count(() => true),
    NONE: { members: 0, recipients: 0, noAddress: 0 },
  };
  const [finances, owner, onDay] = await Promise.all([
    hasPermissionLive(session, "finances", "full"),
    isOwnerLive(session),
    userOnDay(clubId, sessionId, session.user.id),
  ]);
  return NextResponse.json({
    sessionId,
    className: cs.recurringClass.name,
    date: cs.date.toISOString().slice(0, 10),
    canceled: cs.canceled,
    defaultAudience: settings.classCancelNotifyDefault,
    audience,
    selected: counts[audience],
    counts,
    canSetPaid: finances && (owner || !onDay),
  });
}
