import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";

// GET /api/messages/audience
// Everything the "Create group" modal needs to build recipient filters:
//   - members with their membership names (direct plan + active subscriptions)
//   - staff
//   - class rosters (members who have any attendance in each recurring class)
//
// This is the single source the group filters read so "By membership",
// "By tag", and "By class" all actually populate.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "messages", "view");
  if (denied) return denied;

  const clubId = session.user.clubId;

  const [members, staff, classes] = await Promise.all([
    prisma.member.findMany({
      where: { clubId, deletedAt: null },
      orderBy: { firstName: "asc" },
      select: {
        id: true,
        userId: true,
        firstName: true,
        lastName: true,
        email: true,
        tags: true,
        status: true,
        isMinor: true,
        guardianName: true,
        guardianEmail: true,
        membership: { select: { name: true } },
        subscriptions: {
          where: { status: { in: ["active", "past_due"] } },
          select: { membership: { select: { name: true } } },
        },
      },
    }),
    prisma.user.findMany({
      where: { clubId, deletedAt: null, role: { in: ["OWNER", "STAFF"] } },
      select: { id: true, firstName: true, lastName: true, role: true },
    }),
    prisma.recurringClass.findMany({
      where: { clubId },
      select: {
        id: true,
        name: true,
        sessions: {
          select: {
            attendance: { select: { memberId: true } },
          },
        },
      },
    }),
  ]);

  const shapedMembers = members.map((m) => {
    const names = new Set<string>();
    if (m.membership?.name) names.add(m.membership.name);
    for (const s of m.subscriptions) if (s.membership?.name) names.add(s.membership.name);
    return {
      id: m.id,
      userId: m.userId,
      firstName: m.firstName,
      lastName: m.lastName,
      email: m.email,
      tags: m.tags,
      status: m.status,
      isMinor: m.isMinor,
      guardianName: m.guardianName,
      guardianEmail: m.guardianEmail,
      membership: m.membership,
      membershipNames: Array.from(names),
    };
  });

  const shapedStaff = staff.map((s) => ({
    id: s.id,
    firstName: s.firstName,
    lastName: s.lastName,
    role: s.role,
  }));

  const shapedClasses = classes
    .map((c) => {
      const memberIds = new Set<string>();
      for (const sess of c.sessions) {
        for (const a of sess.attendance) memberIds.add(a.memberId);
      }
      return { id: c.id, name: c.name, memberIds: Array.from(memberIds) };
    })
    .filter((c) => c.memberIds.length > 0);

  return NextResponse.json({
    members: shapedMembers,
    staff: shapedStaff,
    classes: shapedClasses,
  });
}
