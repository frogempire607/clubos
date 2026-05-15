import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const updateSchema = z.object({
  type: z.enum(["CLASS", "PRIVATE", "CLINIC", "CAMP", "TOURNAMENT", "OTHER"]).optional(),
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  capacity: z.number().int().positive().optional().nullable(),
  memberPrice: z.number().min(0).optional().nullable(),
  nonMemberPrice: z.number().min(0).optional().nullable(),
  dropInFee: z.number().min(0).optional().nullable(),
  travelFee: z.number().min(0).optional().nullable(),
  publishAt: z.string().optional().nullable(),
  unpublishAt: z.string().optional().nullable(),
  locationId: z.string().optional().nullable(),
});

async function requireEvent(id: string, clubId: string) {
  return prisma.event.findFirst({
    where: { id, clubId, deletedAt: null },
  });
}

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const event = await prisma.event.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
    include: {
      location: true,
      bookings: {
        include: { member: { select: { id: true, firstName: true, lastName: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(event);
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const event = await requireEvent(params.id, session.user.clubId);
  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const body = await req.json();
    const data = updateSchema.parse(body);

    const updated = await prisma.event.update({
      where: { id: params.id },
      data: {
        ...data,
        startsAt: data.startsAt ? new Date(data.startsAt) : undefined,
        endsAt: data.endsAt ? new Date(data.endsAt) : undefined,
        publishAt: data.publishAt ? new Date(data.publishAt) : data.publishAt === null ? null : undefined,
        unpublishAt: data.unpublishAt ? new Date(data.unpublishAt) : data.unpublishAt === null ? null : undefined,
      },
    });

    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const event = await requireEvent(params.id, session.user.clubId);
  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.event.update({
    where: { id: params.id },
    data: { deletedAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}
