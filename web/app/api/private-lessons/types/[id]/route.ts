import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isValidPrivateDuration } from "@/lib/privateLessonRules";

const priceOption = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(60),
  price: z.number().nonnegative(),
  coachIds: z.array(z.string()).default([]),
});

const schema = z.object({
  title:            z.string().min(1).max(100).optional(),
  description:      z.string().max(500).optional().nullable(),
  durationMin:      z.number().int().refine(isValidPrivateDuration, "Duration must be a 15-minute interval from 15 minutes to 4 hours.").optional(),
  maxAthletes:      z.number().int().positive().optional(),
  basePrice:        z.number().nonnegative().optional(),
  locationId:       z.string().optional().nullable(),
  coachTierLabel:   z.string().optional().nullable(),
  eligibleCoachIds: z.array(z.string()).optional(),
  priceOptions:     z.array(priceOption).optional(),
  active:           z.boolean().optional(),
  sortOrder:        z.number().int().optional(),
});

async function requireType(id: string, clubId: string) {
  return prisma.privateLessonType.findFirst({ where: { id, clubId, deletedAt: null } });
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
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

export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const type = await requireType(params.id, session.user.clubId);
  if (!type) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.privateLessonType.update({ where: { id: params.id }, data: { deletedAt: new Date() } });
  return new NextResponse(null, { status: 204 });
}
