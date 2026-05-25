import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// PATCH /api/classes/[id]/sessions/[sessionId]
//
// Per-occurrence edit for a single class session. Owner can change just this
// day's time, mark it canceled, add a one-off note, or override the assigned
// staff (substitute coach). Setting `overridden=true` makes the session
// regenerator preserve this row, so editing the parent recurring class later
// won't blow away the per-day customization.

const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;

const schema = z.object({
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  // "HH:mm" wall-clock alternatives — apply on the existing session date.
  startTime: z.string().regex(TIME_RE).optional(),
  endTime: z.string().regex(TIME_RE).optional(),
  canceled: z.boolean().optional(),
  staffOverride: z.array(z.string()).optional().nullable(),
  note: z.string().max(2000).optional().nullable(),
});

function applyWallClock(date: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  // Class sessions store wall-clock as UTC (see lib/classSessions.ts).
  const d = new Date(date);
  d.setUTCHours(h, m, 0, 0);
  return d;
}

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string; sessionId: string }> },
) {
  const { id: classId, sessionId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "OWNER" && session.user.role !== "STAFF") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cls = await prisma.recurringClass.findFirst({
    where: { id: classId, clubId: session.user.clubId, deletedAt: null },
    select: { id: true },
  });
  if (!cls) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const cs = await prisma.classSession.findFirst({
    where: { id: sessionId, classId, clubId: session.user.clubId },
  });
  if (!cs) return NextResponse.json({ error: "Session not found" }, { status: 404 });

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    }
    throw err;
  }

  const startsAt = data.startsAt
    ? new Date(data.startsAt)
    : data.startTime
      ? applyWallClock(cs.startsAt, data.startTime)
      : undefined;
  const endsAt = data.endsAt
    ? new Date(data.endsAt)
    : data.endTime
      ? applyWallClock(cs.endsAt, data.endTime)
      : undefined;
  if (startsAt && isNaN(startsAt.getTime())) {
    return NextResponse.json({ error: "Invalid start time" }, { status: 400 });
  }
  if (endsAt && isNaN(endsAt.getTime())) {
    return NextResponse.json({ error: "Invalid end time" }, { status: 400 });
  }

  const updated = await prisma.classSession.update({
    where: { id: sessionId },
    data: {
      ...(startsAt !== undefined ? { startsAt } : {}),
      ...(endsAt !== undefined ? { endsAt } : {}),
      ...(data.canceled !== undefined ? { canceled: data.canceled } : {}),
      ...(data.staffOverride !== undefined
        ? { staffOverride: data.staffOverride ?? undefined }
        : {}),
      ...(data.note !== undefined ? { note: data.note ?? null } : {}),
      // Any per-occurrence edit pins this row so series regeneration
      // preserves it.
      overridden: true,
    },
  });

  return NextResponse.json(updated);
}
