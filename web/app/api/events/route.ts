import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const upcoming = searchParams.get("upcoming") === "true";

  const events = await prisma.event.findMany({
    where: {
      clubId: session.user.clubId,
      deletedAt: null,
      ...(upcoming ? { startsAt: { gte: new Date() } } : {}),
    },
    orderBy: { startsAt: "asc" },
    include: {
      location: { select: { name: true } },
      customEventType: { select: { id: true, name: true, color: true, textColor: true } },
      sessions: { orderBy: { sortOrder: "asc" } },
      _count: { select: { bookings: true } },
    },
  });

  return NextResponse.json(events);
}

const sessionSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional().nullable(),
  startsAt: z.string(),
  endsAt: z.string(),
  sortOrder: z.number().int().default(0),
});

const createSchema = z.object({
  type: z.enum(["CLASS", "PRIVATE", "CLINIC", "CAMP", "TOURNAMENT", "OTHER"]).default("OTHER"),
  customEventTypeId: z.string().optional().nullable(),
  name: z.string().min(1),
  description: z.string().optional(),
  startsAt: z.string(),
  endsAt: z.string(),
  capacity: z.number().int().positive().optional().nullable(),
  memberPrice: z.number().min(0).optional().nullable(),
  nonMemberPrice: z.number().min(0).optional().nullable(),
  dropInFee: z.number().min(0).optional().nullable(),
  travelFee: z.number().min(0).optional().nullable(),
  publishAt: z.string().optional().nullable(),
  unpublishAt: z.string().optional().nullable(),
  locationId: z.string().optional().nullable(),
  visibility: z.enum(["PUBLIC", "MEMBERS_ONLY", "STAFF_ONLY"]).default("PUBLIC"),
  purchaseAccess: z.enum(["ANYONE", "STAFF_ONLY"]).default("ANYONE"),
  allowMembershipPayment: z.boolean().default(false),
  imageUrl: z.string().optional().nullable(),
  sessions: z.array(sessionSchema).optional(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const data = createSchema.parse(body);

    const startsAt = new Date(data.startsAt);
    const endsAt = new Date(data.endsAt);

    if (endsAt <= startsAt) {
      return NextResponse.json({ error: "End time must be after start time" }, { status: 400 });
    }

    // Determine the base type: use OTHER when a custom type is selected
    const baseType = data.customEventTypeId ? "OTHER" : (data.type || "OTHER");

    const event = await prisma.event.create({
      data: {
        clubId: session.user.clubId,
        type: baseType,
        customEventTypeId: data.customEventTypeId || null,
        name: data.name,
        description: data.description || null,
        startsAt,
        endsAt,
        capacity: data.capacity || null,
        memberPrice: data.memberPrice ?? null,
        nonMemberPrice: data.nonMemberPrice ?? null,
        dropInFee: data.dropInFee ?? null,
        travelFee: data.travelFee ?? null,
        publishAt: data.publishAt ? new Date(data.publishAt) : null,
        unpublishAt: data.unpublishAt ? new Date(data.unpublishAt) : null,
        locationId: data.locationId || null,
        visibility: data.visibility,
        purchaseAccess: data.purchaseAccess,
        allowMembershipPayment: data.allowMembershipPayment,
        imageUrl: data.imageUrl ?? null,
        sessions: data.sessions?.length
          ? {
              create: data.sessions.map((s, i) => ({
                name: s.name || null,
                startsAt: new Date(s.startsAt),
                endsAt: new Date(s.endsAt),
                sortOrder: s.sortOrder ?? i,
              })),
            }
          : undefined,
      },
    });

    return NextResponse.json(event, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
