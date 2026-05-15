import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role === "MEMBER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const assignments = await prisma.eventStaffAssignment.findMany({
    where: { eventId: params.id, clubId: session.user.clubId },
    include: { user: { select: { id: true, firstName: true, lastName: true, role: true } } },
  });

  return NextResponse.json(assignments);
}

const schema = z.object({
  userId: z.string(),
  role:   z.string().min(1).max(100).default("Coach"),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const event = await prisma.event.findFirst({
    where: { id: params.id, clubId: session.user.clubId },
  });
  if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });

  try {
    const data = schema.parse(await req.json());

    const staff = await prisma.user.findFirst({
      where: { id: data.userId, clubId: session.user.clubId, role: { in: ["OWNER", "STAFF"] } },
    });
    if (!staff) return NextResponse.json({ error: "Staff member not found" }, { status: 404 });

    const assignment = await prisma.eventStaffAssignment.upsert({
      where: { eventId_userId: { eventId: params.id, userId: data.userId } },
      update: { role: data.role },
      create: {
        clubId:  session.user.clubId,
        eventId: params.id,
        userId:  data.userId,
        role:    data.role,
      },
      include: { user: { select: { id: true, firstName: true, lastName: true } } },
    });

    return NextResponse.json(assignment, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const userId = searchParams.get("userId");
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  const existing = await prisma.eventStaffAssignment.findFirst({
    where: { eventId: params.id, userId, clubId: session.user.clubId },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.eventStaffAssignment.delete({
    where: { eventId_userId: { eventId: params.id, userId } },
  });

  return new NextResponse(null, { status: 204 });
}
