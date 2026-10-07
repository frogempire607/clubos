import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermissionLive } from "@/lib/apiGuard";
import { validScheduleStaffIds } from "@/lib/staffAssignmentsServer";
import { recordStaffActivity, actorFrom } from "@/lib/staffActivity";

import { prisma } from "@/lib/prisma";

// Who may touch this person's availability (2026-10-07, all read LIVE):
//   their own   → any current staff member (lib/staffSelf.ts edit_hours / edit_time_off)
//   someone else → schedule:view to read, schedule:edit to change
// and the target must be a current OWNER/STAFF of this club — the id in the URL
// used to be written as-is, so rows could be created for a member or a made-up id.
async function authorize(
  session: Parameters<typeof requirePermissionLive>[0] & { user: { id: string; clubId: string } },
  targetId: string,
  level: "view" | "edit",
) {
  const denied = await requirePermissionLive(session, "schedule", session.user.id === targetId ? "none" : level);
  if (denied) return denied;
  const ok = await validScheduleStaffIds(session.user.clubId, [targetId]);
  if (ok.length === 0) return NextResponse.json({ error: "Staff member not found" }, { status: 404 });
  return null;
}

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await authorize(session, params.id, "view");
  if (denied) return denied;

  const slots = await prisma.staffAvailability.findMany({
    where: { userId: params.id, clubId: session.user.clubId },
    orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
  });

  return NextResponse.json(slots);
}

const slotSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime:   z.string().regex(/^\d{2}:\d{2}$/),
  active:    z.boolean().default(true),
});

const schema = z.object({
  slots: z.array(slotSchema),
});

// POST replaces all weekly slots for this staff member
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await authorize(session, params.id, "edit");
  if (denied) return denied;

  try {
    const { slots } = schema.parse(await req.json());

    await prisma.$transaction([
      prisma.staffAvailability.deleteMany({
        where: { userId: params.id, clubId: session.user.clubId },
      }),
      prisma.staffAvailability.createMany({
        data: slots.map((s) => ({
          userId:    params.id,
          clubId:    session.user.clubId,
          dayOfWeek: s.dayOfWeek,
          startTime: s.startTime,
          endTime:   s.endTime,
          active:    s.active,
        })),
      }),
    ]);

    await recordStaffActivity({
      clubId: session.user.clubId,
      staffUserId: params.id,
      ...actorFrom(session),
      kind: "HOURS",
      summary: session.user.id === params.id ? "Updated their weekly hours from their own profile" : "Updated weekly hours",
    });

    const result = await prisma.staffAvailability.findMany({
      where: { userId: params.id, clubId: session.user.clubId },
      orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
    });

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
