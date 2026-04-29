import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const sessionSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional().nullable(),
  startsAt: z.string(),
  endsAt: z.string(),
  sortOrder: z.number().int().default(0),
});

const updateSchema = z.object({
  type: z.enum(["CLASS", "PRIVATE", "CLINIC", "CAMP", "TOURNAMENT", "OTHER"]).optional(),
  customEventTypeId: z.string().optional().nullable(),
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
  visibility: z.enum(["PUBLIC", "MEMBERS_ONLY", "STAFF_ONLY"]).optional(),
  purchaseAccess: z.enum(["ANYONE", "STAFF_ONLY"]).optional(),
  allowMembershipPayment: z.boolean().optional(),
  imageUrl: z.string().optional().nullable(),
  pricingOptions: z.array(z.object({ type: z.literal("membership"), membershipId: z.string() })).optional(),
  staffUserIds: z.array(z.string()).optional(),
  sessions: z.array(sessionSchema).optional(),
});

async function requireEvent(id: string, clubId: string) {
  return prisma.event.findFirst({
    where: { id, clubId, deletedAt: null },
  });
}

export async function GET(_: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const event = await prisma.event.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
    include: {
      location: true,
      customEventType: true,
      sessions: { orderBy: { sortOrder: "asc" } },
      staffAssignments: { include: { user: { select: { id: true, firstName: true, lastName: true } } } },
      bookings: {
        include: { member: { select: { id: true, firstName: true, lastName: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(event);
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const event = await requireEvent(params.id, session.user.clubId);
  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const body = await req.json();
    const { sessions, staffUserIds, ...rest } = updateSchema.parse(body);

    const baseType =
      "customEventTypeId" in rest
        ? rest.customEventTypeId
          ? "OTHER"
          : rest.type
        : rest.type;

    const updated = await prisma.event.update({
      where: { id: params.id },
      data: {
        ...rest,
        ...(baseType ? { type: baseType } : {}),
        startsAt: rest.startsAt ? new Date(rest.startsAt) : undefined,
        endsAt: rest.endsAt ? new Date(rest.endsAt) : undefined,
        publishAt: rest.publishAt ? new Date(rest.publishAt) : rest.publishAt === null ? null : undefined,
        unpublishAt: rest.unpublishAt ? new Date(rest.unpublishAt) : rest.unpublishAt === null ? null : undefined,
      },
    });

    if (sessions !== undefined) {
      await prisma.eventSession.deleteMany({ where: { eventId: params.id } });
      if (sessions.length > 0) {
        await prisma.eventSession.createMany({
          data: sessions.map((s, i) => ({
            eventId: params.id,
            name: s.name || null,
            startsAt: new Date(s.startsAt),
            endsAt: new Date(s.endsAt),
            sortOrder: s.sortOrder ?? i,
          })),
        });
      }
    }

    if (staffUserIds !== undefined) {
      await prisma.eventStaffAssignment.deleteMany({ where: { eventId: params.id, clubId: session.user.clubId } });
      if (staffUserIds.length > 0) {
        await prisma.eventStaffAssignment.createMany({
          data: staffUserIds.map((userId) => ({
            clubId: session.user.clubId,
            eventId: params.id,
            userId,
            role: "COACH",
          })),
          skipDuplicates: true,
        });
      }
    }

    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(_: Request, { params }: { params: { id: string } }) {
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
