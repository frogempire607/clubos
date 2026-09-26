import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermission } from "@/lib/apiGuard";
import { recordStaffActivity, actorFrom } from "@/lib/staffActivity";

import { prisma } from "@/lib/prisma";

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "OWNER" && session.user.id !== params.id) {
    const denied = requirePermission(session, "schedule", "view");
    if (denied) return denied;
  }

  const exceptions = await prisma.staffAvailabilityException.findMany({
    where: { userId: params.id, clubId: session.user.clubId },
    orderBy: { date: "asc" },
  });

  return NextResponse.json(exceptions);
}

function dayLabel(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

const schema = z.object({
  date:      z.string(),
  type:      z.enum(["UNAVAILABLE", "PARTIAL"]),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
  endTime:   z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
  note:      z.string().max(200).optional().nullable(),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "OWNER" && session.user.id !== params.id) {
    const denied = requirePermission(session, "schedule", "edit");
    if (denied) return denied;
  }

  try {
    const data = schema.parse(await req.json());

    const exception = await prisma.staffAvailabilityException.create({
      data: {
        userId:    params.id,
        clubId:    session.user.clubId,
        date:      new Date(data.date),
        type:      data.type,
        startTime: data.startTime || null,
        endTime:   data.endTime || null,
        note:      data.note || null,
      },
    });

    await recordStaffActivity({
      clubId: session.user.clubId,
      staffUserId: params.id,
      ...actorFrom(session),
      kind: "TIME_OFF",
      summary: `${data.type === "PARTIAL" ? "Set modified hours for" : "Added time off"} ${dayLabel(exception.date)}${session.user.id === params.id ? " from their own profile" : ""}`,
    });

    return NextResponse.json(exception, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "OWNER" && session.user.id !== params.id) {
    const denied = requirePermission(session, "schedule", "edit");
    if (denied) return denied;
  }

  const { searchParams } = new URL(req.url);
  const exceptionId = searchParams.get("exceptionId");
  if (!exceptionId) return NextResponse.json({ error: "exceptionId required" }, { status: 400 });

  const existing = await prisma.staffAvailabilityException.findFirst({
    where: { id: exceptionId, userId: params.id, clubId: session.user.clubId },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.staffAvailabilityException.delete({ where: { id: exceptionId } });
  await recordStaffActivity({
    clubId: session.user.clubId,
    staffUserId: params.id,
    ...actorFrom(session),
    kind: "TIME_OFF",
    summary: `Removed the ${dayLabel(existing.date)} exception${session.user.id === params.id ? " from their own profile" : ""}`,
  });
  return new NextResponse(null, { status: 204 });
}
