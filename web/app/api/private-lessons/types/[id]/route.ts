import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const schema = z.object({
  title:            z.string().min(1).max(100).optional(),
  description:      z.string().max(500).optional().nullable(),
  durationMin:      z.number().int().positive().optional(),
  maxAthletes:      z.number().int().positive().optional(),
  basePrice:        z.number().nonnegative().optional(),
  locationId:       z.string().optional().nullable(),
  coachTierLabel:   z.string().optional().nullable(),
  eligibleCoachIds: z.array(z.string()).optional(),
  active:           z.boolean().optional(),
  sortOrder:        z.number().int().optional(),
});

async function requireType(id: string, clubId: string) {
  return prisma.privateLessonType.findFirst({ where: { id, clubId, deletedAt: null } });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const type = await requireType(params.id, session.user.clubId);
  if (!type) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const data = schema.parse(await req.json());
    const updated = await prisma.privateLessonType.update({ where: { id: params.id }, data });
    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const type = await requireType(params.id, session.user.clubId);
  if (!type) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.privateLessonType.update({ where: { id: params.id }, data: { deletedAt: new Date() } });
  return new NextResponse(null, { status: 204 });
}
