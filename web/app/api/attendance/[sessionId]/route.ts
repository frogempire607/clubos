import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/attendance/[sessionId]
// Returns attendance records for a class session with member details
export async function GET(_req: Request, context: { params: Promise<{ sessionId: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const classSession = await prisma.classSession.findFirst({
    where: { id: params.sessionId, clubId: session.user.clubId },
    include: {
      recurringClass: {
        select: {
          id: true,
          name: true,
          capacity: true,
          daysOfWeek: true,
          startTime: true,
          endTime: true,
          pricingOptions: true,
        },
      },
    },
  });
  if (!classSession) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const pricingOptions =
    (classSession.recurringClass.pricingOptions as Array<{ type: string; price?: number; membershipId?: string }> | null) || [];
  const acceptedMembershipIds = pricingOptions
    .filter((o) => o?.type === "membership" && o.membershipId)
    .map((o) => o.membershipId as string);
  const acceptedMemberships = acceptedMembershipIds.length
    ? await prisma.membership.findMany({
        where: { id: { in: acceptedMembershipIds }, clubId: session.user.clubId, deletedAt: null },
        select: { id: true, name: true },
      })
    : [];

  const attendance = await prisma.attendanceRecord.findMany({
    where: { classSessionId: params.sessionId },
    include: {
      member: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          isMinor: true,
          guardianName: true,
          status: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({
    session: classSession,
    attendance,
    pricingOptions,
    acceptedMemberships,
  });
}
