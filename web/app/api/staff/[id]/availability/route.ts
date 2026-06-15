import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.id !== params.id)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
  if (!session || (session.user.role !== "OWNER" && session.user.id !== params.id)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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

    const result = await prisma.staffAvailability.findMany({
      where: { userId: params.id, clubId: session.user.clubId },
      orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
    });

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
