import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const createSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  locationId: z.string().optional().nullable(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  capacity: z.number().int().positive().optional().nullable(),
  recurrenceStartDate: z.string(),
  recurrenceEndDate: z.string().optional().nullable(),
  pricingOptions: z
    .array(z.object({ type: z.enum(["member", "nonmember", "dropin"]), price: z.number() }))
    .default([]),
});

function buildSessions(
  classId: string,
  clubId: string,
  daysOfWeek: number[],
  startTime: string,
  endTime: string,
  start: Date,
  end: Date | null
) {
  const ceiling = end ?? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);

  const rows: {
    classId: string;
    clubId: string;
    date: Date;
    startsAt: Date;
    endsAt: Date;
    canceled: boolean;
  }[] = [];

  const cur = new Date(start);
  cur.setUTCHours(0, 0, 0, 0);

  while (cur <= ceiling) {
    if (daysOfWeek.includes(cur.getUTCDay())) {
      const startsAt = new Date(cur);
      startsAt.setUTCHours(sh, sm, 0, 0);
      const endsAt = new Date(cur);
      endsAt.setUTCHours(eh, em, 0, 0);
      rows.push({ classId, clubId, date: new Date(cur), startsAt, endsAt, canceled: false });
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return rows;
}

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

  const cls = await prisma.recurringClass.create({
    data: {
      clubId: session.user.clubId,
      locationId: d.locationId ?? null,
      name: d.name,
      description: d.description ?? null,
      daysOfWeek: d.daysOfWeek,
      startTime: d.startTime,
      endTime: d.endTime,
      capacity: d.capacity ?? null,
      recurrenceStartDate: recStart,
      recurrenceEndDate: recEnd,
      pricingOptions: d.pricingOptions,
    },
  });

  const sessions = buildSessions(
    cls.id,
    session.user.clubId,
    d.daysOfWeek,
    d.startTime,
    d.endTime,
    recStart,
    recEnd
  );
  if (sessions.length > 0) {
    await prisma.classSession.createMany({ data: sessions });
  }

  return NextResponse.json(cls, { status: 201 });
}
