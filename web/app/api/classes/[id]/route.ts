import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { buildSessions, type DayOverride } from "@/lib/classSessions";

const TIME_REGEX = /^\d{2}:\d{2}$/;
const dayOverrideSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string().regex(TIME_REGEX),
  endTime: z.string().regex(TIME_REGEX),
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  locationId: z.string().optional().nullable(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).optional(),
  startTime: z.string().regex(TIME_REGEX).optional(),
  endTime: z.string().regex(TIME_REGEX).optional(),
  dayOverrides: z.array(dayOverrideSchema).optional(),
  capacity: z.number().int().positive().optional().nullable(),
  recurrenceStartDate: z.string().optional(),
  recurrenceEndDate: z.string().optional().nullable(),
  pricingOptions: z
    .array(z.union([
      z.object({ type: z.enum(["member", "nonmember", "dropin"]), price: z.number() }),
      z.object({ type: z.literal("membership"), membershipId: z.string() }),
    ]))
    .optional(),
  assignedStaffIds: z.array(z.string()).optional(),
  active: z.boolean().optional(),
});

async function findClass(id: string, clubId: string) {
  return prisma.recurringClass.findFirst({
    where: { id, clubId, deletedAt: null },
  });
}

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cls = await prisma.recurringClass.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
    include: {
      location: { select: { name: true } },
      _count: { select: { sessions: true } },
    },
  });
  if (!cls) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(cls);
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["OWNER", "STAFF"].includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cls = await findClass(params.id, session.user.clubId);
  if (!cls) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { recurrenceStartDate, recurrenceEndDate, ...rest } = parsed.data;

  // Clean overrides against the (possibly updated) daysOfWeek list
  const effectiveDaysOfWeek = (rest.daysOfWeek ?? (cls.daysOfWeek as number[])) || [];
  const incomingOverrides = rest.dayOverrides;
  const cleanOverrides = incomingOverrides
    ? incomingOverrides.filter((o) => effectiveDaysOfWeek.includes(o.dayOfWeek))
    : undefined;

  const updated = await prisma.recurringClass.update({
    where: { id: params.id },
    data: {
      ...rest,
      ...(cleanOverrides !== undefined ? { dayOverrides: cleanOverrides } : {}),
      ...(recurrenceStartDate !== undefined ? { recurrenceStartDate: new Date(recurrenceStartDate) } : {}),
      ...(recurrenceEndDate !== undefined ? { recurrenceEndDate: recurrenceEndDate ? new Date(recurrenceEndDate) : null } : {}),
    },
  });

  // Regenerate future sessions when scheduling-relevant fields change. We only
  // touch sessions in the future (>= today) so historical attendance stays
  // intact. Canceled sessions are also preserved.
  const scheduleChanged =
    rest.daysOfWeek !== undefined ||
    rest.startTime !== undefined ||
    rest.endTime !== undefined ||
    cleanOverrides !== undefined ||
    recurrenceStartDate !== undefined ||
    recurrenceEndDate !== undefined;

  if (scheduleChanged) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    await prisma.classSession.deleteMany({
      where: {
        classId: updated.id,
        date: { gte: todayStart },
        canceled: false,
        // Don't blow away sessions that already have attendance recorded
        attendance: { none: {} },
      },
    });
    const newSessions = buildSessions(
      updated.id,
      updated.clubId,
      updated.daysOfWeek as number[],
      updated.startTime,
      updated.endTime,
      (updated.dayOverrides as unknown as DayOverride[]) ?? [],
      new Date(Math.max(todayStart.getTime(), updated.recurrenceStartDate.getTime())),
      updated.recurrenceEndDate,
    );
    if (newSessions.length > 0) {
      await prisma.classSession.createMany({ data: newSessions, skipDuplicates: true });
    }
  }

  return NextResponse.json(updated);
}

export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cls = await findClass(params.id, session.user.clubId);
  if (!cls) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.recurringClass.update({
    where: { id: params.id },
    data: { deletedAt: new Date() },
  });
  return NextResponse.json({ ok: true });
}
