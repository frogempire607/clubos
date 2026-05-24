import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { buildSessions } from "@/lib/classSessions";

const TIME_REGEX = /^\d{2}:\d{2}$/;
const dayOverrideSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string().regex(TIME_REGEX),
  endTime: z.string().regex(TIME_REGEX),
});

const createSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  locationId: z.string().optional().nullable(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1),
  startTime: z.string().regex(TIME_REGEX),
  endTime: z.string().regex(TIME_REGEX),
  // Optional per-day override list. If absent for a day, that day uses the
  // default startTime/endTime above. This lets a class run Mon 5-6pm but
  // Wed 6-7:30pm without forcing the owner to create two separate classes.
  dayOverrides: z.array(dayOverrideSchema).default([]),
  capacity: z.number().int().positive().optional().nullable(),
  recurrenceStartDate: z.string(),
  recurrenceEndDate: z.string().optional().nullable(),
  pricingOptions: z
    .array(z.union([
      z.object({ type: z.enum(["member", "nonmember", "dropin"]), price: z.number() }),
      z.object({ type: z.literal("membership"), membershipId: z.string() }),
    ]))
    .default([]),
  assignedStaffIds: z.array(z.string()).default([]),
  color: z.string().optional().nullable(),
  textColor: z.string().optional().nullable(),
});


export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const classes = await prisma.recurringClass.findMany({
    where: { clubId: session.user.clubId, deletedAt: null },
    include: {
      location: { select: { name: true } },
      _count: {
        select: {
          sessions: { where: { canceled: false, date: { gte: new Date() } } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(classes);
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["OWNER", "STAFF"].includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const d = parsed.data;
  const recStart = new Date(d.recurrenceStartDate);
  const recEnd = d.recurrenceEndDate ? new Date(d.recurrenceEndDate) : null;

  // Drop overrides for days that aren't actually scheduled
  const cleanOverrides = d.dayOverrides.filter((o) => d.daysOfWeek.includes(o.dayOfWeek));

  const cls = await prisma.recurringClass.create({
    data: {
      clubId: session.user.clubId,
      locationId: d.locationId ?? null,
      name: d.name,
      description: d.description ?? null,
      daysOfWeek: d.daysOfWeek,
      startTime: d.startTime,
      endTime: d.endTime,
      dayOverrides: cleanOverrides,
      capacity: d.capacity ?? null,
      recurrenceStartDate: recStart,
      recurrenceEndDate: recEnd,
      pricingOptions: d.pricingOptions,
      assignedStaffIds: d.assignedStaffIds,
      color: d.color || null,
      textColor: d.textColor || null,
    },
  });

  const sessions = buildSessions(
    cls.id,
    session.user.clubId,
    d.daysOfWeek,
    d.startTime,
    d.endTime,
    cleanOverrides,
    recStart,
    recEnd
  );
  if (sessions.length > 0) {
    await prisma.classSession.createMany({ data: sessions });
  }

  return NextResponse.json(cls, { status: 201 });
}
