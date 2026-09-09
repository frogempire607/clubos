import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { z } from "zod";
import { syncFutureSessions } from "@/lib/classSessionSync";

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
  color: z.string().optional().nullable(),
  textColor: z.string().optional().nullable(),
  visibility: z.enum(["PUBLIC", "MEMBERS_ONLY", "PRIVATE"]).optional(),
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

  // Bring future sessions in line when scheduling-relevant fields change. The
  // series is RECONCILED BY DATE, not deleted and regenerated: a member's
  // booking is an AttendanceRecord on a specific ClassSession row, so dropping
  // the row and making a new one is a cancellation as far as that member is
  // concerned. Moving the row's time carries the bookings with it. Past
  // sessions are never touched.
  const scheduleChanged =
    rest.daysOfWeek !== undefined ||
    rest.startTime !== undefined ||
    rest.endTime !== undefined ||
    cleanOverrides !== undefined ||
    recurrenceStartDate !== undefined ||
    recurrenceEndDate !== undefined;

  const sessionSync = scheduleChanged ? await syncFutureSessions(updated) : null;

  return NextResponse.json({ ...updated, sessionSync });
}

export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Staff with full Classes access can delete — not owner-only.
  const denied = requirePermission(session, "classes", "full");
  if (denied) return denied;

  const cls = await findClass(params.id, session.user.clubId);
  if (!cls) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.recurringClass.update({
    where: { id: params.id },
    data: { deletedAt: new Date() },
  });
  return NextResponse.json({ ok: true });
}
