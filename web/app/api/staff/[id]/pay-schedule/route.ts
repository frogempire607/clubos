import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { formatZodError } from "@/lib/zodErrors";
import { requirePermissionLive } from "@/lib/apiGuard";
import { selfRule, SELF_DENY_MESSAGE } from "@/lib/staffSelf";
import { recordStaffActivity, actorFrom } from "@/lib/staffActivity";
import { prisma } from "@/lib/prisma";
import { clubTodayYmd } from "@/lib/payReminders";
import {
  PAY_FREQUENCIES,
  dateFromYmd,
  describeSchedule,
  isValidYmd,
  nextPaydays,
  ymdFromDate,
} from "@/lib/paySchedule";

// GET/PUT /api/staff/[id]/pay-schedule — when this staff member gets paid.
// Drives the payday reminders (lib/payReminders.ts). Stored in its own table
// (staff_pay_schedules) because the compensation PUT recreates
// StaffCompensation and would wipe anything kept there.
//
// GET: finances:view, or the staff member themselves (read-only).
// PUT: finances:full, and never on yourself unless you're the owner (B21 rule:
//      staff can never change their own pay — that includes when they're paid).

async function requireStaff(userId: string, clubId: string) {
  return prisma.user.findFirst({
    where: { id: userId, clubId, role: { in: ["OWNER", "STAFF"] }, deletedAt: null },
    select: { id: true },
  });
}

async function view(clubId: string, userId: string) {
  const [row, club] = await Promise.all([
    prisma.staffPaySchedule.findUnique({ where: { userId } }),
    prisma.club.findUnique({ where: { id: clubId }, select: { timezone: true } }),
  ]);
  const today = clubTodayYmd(club?.timezone);
  if (!row || row.clubId !== clubId) return { schedule: null, nextPaydays: [], today };
  const schedule = {
    frequency: row.frequency,
    anchorDate: ymdFromDate(row.anchorDate),
    active: row.active,
    updatedAt: row.updatedAt.toISOString(),
  };
  return { schedule, nextPaydays: row.active ? nextPaydays(schedule, today, 3) : [], today };
}

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (selfRule(session.user.role, session.user.id, id, "view_pay") !== "allow") {
    const denied = await requirePermissionLive(session, "finances", "view");
    if (denied) return denied;
  }
  if (!(await requireStaff(id, session.user.clubId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(await view(session.user.clubId, id));
}

const putSchema = z.object({
  frequency: z.enum(PAY_FREQUENCIES),
  anchorDate: z.string().refine(isValidYmd, "Pick a date for the next payday."),
  active: z.boolean().default(true),
});

export async function PUT(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (selfRule(session.user.role, session.user.id, id, "edit_pay") === "deny") {
    return NextResponse.json({ error: SELF_DENY_MESSAGE.edit_pay }, { status: 403 });
  }
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  const clubId = session.user.clubId;
  if (!(await requireStaff(id, clubId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let data: z.infer<typeof putSchema>;
  try {
    data = putSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const before = await prisma.staffPaySchedule.findUnique({ where: { userId: id } });
  if (before && before.clubId !== clubId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const anchor = dateFromYmd(data.anchorDate);
  await prisma.staffPaySchedule.upsert({
    where: { userId: id },
    create: { clubId, userId: id, frequency: data.frequency, anchorDate: anchor, active: data.active },
    update: { frequency: data.frequency, anchorDate: anchor, active: data.active },
  });

  const desc = describeSchedule({ frequency: data.frequency, anchorDate: data.anchorDate });
  const ruleChanged =
    !before || before.frequency !== data.frequency || ymdFromDate(before.anchorDate) !== data.anchorDate;
  let summary: string | null = null;
  if (ruleChanged) summary = `Set pay schedule: ${desc}${data.active ? "" : " (reminders off)"}`;
  else if (before && before.active !== data.active) summary = data.active ? "Turned payday reminders on" : "Turned payday reminders off";
  if (summary) {
    await recordStaffActivity({ clubId, staffUserId: id, ...actorFrom(session), kind: "PAY", summary });
  }

  return NextResponse.json(await view(clubId, id));
}
