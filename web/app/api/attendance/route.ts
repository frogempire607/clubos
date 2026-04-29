import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

// GET /api/attendance?date=YYYY-MM-DD
// Returns all class sessions + events for that date
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const dateStr = searchParams.get("date");

  const date = dateStr ? new Date(dateStr) : new Date();
  date.setUTCHours(0, 0, 0, 0);
  const nextDay = new Date(date);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);

  const [classSessions, events] = await Promise.all([
    prisma.classSession.findMany({
      where: {
        clubId: session.user.clubId,
        date: { gte: date, lt: nextDay },
        canceled: false,
      },
      include: {
        recurringClass: { select: { name: true, capacity: true } },
        _count: { select: { attendance: true } },
      },
      orderBy: { startsAt: "asc" },
    }),
    prisma.event.findMany({
      where: {
        clubId: session.user.clubId,
        startsAt: { gte: date, lt: nextDay },
        deletedAt: null,
      },
      include: {
        location: { select: { name: true } },
        _count: { select: { bookings: true } },
      },
      orderBy: { startsAt: "asc" },
    }),
  ]);

  return NextResponse.json({ classSessions, events });
}

const recordSchema = z.object({
  classSessionId: z.string().optional().nullable(),
  eventId: z.string().optional().nullable(),
  memberId: z.string().min(1),
  status: z.enum(["PRESENT", "ABSENT", "LATE", "TRIAL", "DROP_IN"]),
  notes: z.string().optional().nullable(),
});

// POST /api/attendance — upsert an attendance record
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["OWNER", "STAFF"].includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const parsed = recordSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { classSessionId, eventId, memberId, status, notes } = parsed.data;
  if (!classSessionId && !eventId) {
    return NextResponse.json({ error: "classSessionId or eventId required" }, { status: 400 });
  }

  // Verify member belongs to club
  const member = await prisma.member.findFirst({
    where: { id: memberId, clubId: session.user.clubId, deletedAt: null },
  });
  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

  // Upsert: find existing then update or create
  const existing = await prisma.attendanceRecord.findFirst({
    where: {
      ...(classSessionId ? { classSessionId } : {}),
      ...(eventId ? { eventId } : {}),
      memberId,
    },
  });

  let record;
  if (existing) {
    record = await prisma.attendanceRecord.update({
      where: { id: existing.id },
      data: {
        status,
        notes: notes ?? undefined,
        checkedInAt: status === "PRESENT" ? (existing.checkedInAt ?? new Date()) : existing.checkedInAt,
        addedById: session.user.id,
      },
      include: { member: { select: { id: true, firstName: true, lastName: true } } },
    });
  } else {
    record = await prisma.attendanceRecord.create({
      data: {
        clubId: session.user.clubId,
        classSessionId: classSessionId ?? null,
        eventId: eventId ?? null,
        memberId,
        status,
        notes: notes ?? null,
        checkedInAt: status === "PRESENT" ? new Date() : null,
        addedById: session.user.id,
      },
      include: { member: { select: { id: true, firstName: true, lastName: true } } },
    });
  }

  return NextResponse.json(record);
}
