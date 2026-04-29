import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/attendance/[sessionId]
// Returns attendance records for a class session with member details
export async function GET(_req: Request, { params }: { params: { sessionId: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const classSession = await prisma.classSession.findFirst({
    where: { id: params.sessionId, clubId: session.user.clubId },
    include: {
      recurringClass: {
        select: { name: true, capacity: true, daysOfWeek: true, startTime: true, endTime: true },
      },
    },
  });
  if (!classSession) return NextResponse.json({ error: "Not found" }, { status: 404 });

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

  return NextResponse.json({ session: classSession, attendance });
}
