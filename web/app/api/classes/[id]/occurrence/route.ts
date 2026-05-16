import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { buildSessions, type DayOverride } from "@/lib/classSessions";

const TIME = /^\d{2}:\d{2}$/;

const schema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), // the occurrence's calendar day
  scope: z.enum(["occurrence", "following", "series"]).default("occurrence"),
  // null on staffIds = clear the override (inherit the series again).
  staffIds: z.array(z.string()).nullable().optional(),
  startTime: z.string().regex(TIME).optional(),
  endTime: z.string().regex(TIME).optional(),
  note: z.string().max(2000).nullable().optional(),
  canceled: z.boolean().optional(),
});

// UTC day window matching how buildSessions stores ClassSession.date.
function dayWindow(dateStr: string) {
  const start = new Date(`${dateStr}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 86400000);
  return { start, end };
}
function atUTC(dateStr: string, hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCHours(h, m, 0, 0);
  return d;
}

// POST /api/classes/[id]/occurrence
// Recurring-calendar style edit. `scope` controls blast radius:
//   occurrence → just this day's ClassSession (created if it doesn't exist yet)
//   following  → this day and every later session of the series
//   series     → the RecurringClass itself (staff + default times), then
//                regenerate future sessions while preserving attendance and
//                any sessions that already carry a per-occurrence override.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "schedule", "edit");
  if (denied) return denied;

  const cls = await prisma.recurringClass.findFirst({
    where: { id, clubId: session.user.clubId, deletedAt: null },
  });
  if (!cls) return NextResponse.json({ error: "Class not found" }, { status: 404 });

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const seriesStaff = Array.isArray(cls.assignedStaffIds) ? (cls.assignedStaffIds as string[]) : [];

  // ── SERIES: change the recurring class itself ──
  if (body.scope === "series") {
    const data: Record<string, unknown> = {};
    if (body.staffIds !== undefined && body.staffIds !== null) data.assignedStaffIds = body.staffIds;
    if (body.startTime) data.startTime = body.startTime;
    if (body.endTime) data.endTime = body.endTime;
    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "Nothing to update for the series." }, { status: 400 });
    }
    const updated = await prisma.recurringClass.update({ where: { id }, data });

    // Regenerate future, non-attended, non-overridden sessions if times moved.
    if (body.startTime || body.endTime) {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      await prisma.classSession.deleteMany({
        where: {
          classId: id,
          date: { gte: todayStart },
          canceled: false,
          overridden: false,
          attendance: { none: {} },
        },
      });
      const rows = buildSessions(
        id,
        cls.clubId,
        updated.daysOfWeek as number[],
        updated.startTime,
        updated.endTime,
        (updated.dayOverrides as unknown as DayOverride[]) ?? [],
        new Date(Math.max(todayStart.getTime(), updated.recurrenceStartDate.getTime())),
        updated.recurrenceEndDate,
      );
      if (rows.length > 0) await prisma.classSession.createMany({ data: rows, skipDuplicates: true });
    }
    return NextResponse.json({ ok: true, scope: "series" });
  }

  // ── OCCURRENCE / FOLLOWING: write per-session overrides ──
  const { start } = dayWindow(body.date);

  // Sessions to touch.
  const targets =
    body.scope === "following"
      ? await prisma.classSession.findMany({ where: { classId: id, date: { gte: start } } })
      : await prisma.classSession.findMany({ where: { classId: id, date: { gte: start, lt: dayWindow(body.date).end } } });

  // "occurrence" with no materialized row yet → create one for that day.
  if (body.scope === "occurrence" && targets.length === 0) {
    const created = await prisma.classSession.create({
      data: {
        classId: id,
        clubId: cls.clubId,
        date: start,
        startsAt: atUTC(body.date, body.startTime ?? cls.startTime),
        endsAt: atUTC(body.date, body.endTime ?? cls.endTime),
        canceled: body.canceled ?? false,
        staffOverride: body.staffIds !== undefined ? (body.staffIds as any) : undefined,
        note: body.note ?? null,
        overridden: true,
      },
    });
    return NextResponse.json({ ok: true, scope: "occurrence", sessionId: created.id });
  }

  let updatedCount = 0;
  for (const s of targets) {
    const dateStr = s.date.toISOString().slice(0, 10);
    const data: Record<string, unknown> = { overridden: true };
    if (body.staffIds !== undefined) {
      // null clears the override (re-inherit the series); array sets it.
      data.staffOverride = body.staffIds === null ? null : (body.staffIds as any);
    }
    if (body.note !== undefined) data.note = body.note;
    if (body.canceled !== undefined) data.canceled = body.canceled;
    if (body.startTime) data.startsAt = atUTC(dateStr, body.startTime);
    if (body.endTime) data.endsAt = atUTC(dateStr, body.endTime);
    await prisma.classSession.update({ where: { id: s.id }, data });
    updatedCount++;
  }

  return NextResponse.json({
    ok: true,
    scope: body.scope,
    updated: updatedCount,
    seriesStaff,
  });
}
