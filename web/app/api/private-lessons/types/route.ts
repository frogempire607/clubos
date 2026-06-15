import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isValidPrivateDuration } from "@/lib/privateLessonRules";
import { requirePermission } from "@/lib/apiGuard";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const types = await prisma.privateLessonType.findMany({
    where: { clubId: session!.user.clubId, deletedAt: null },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: { location: { select: { name: true } } },
  });
  return NextResponse.json(types);
}

const priceOption = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(60),
  price: z.number().nonnegative(),
  coachIds: z.array(z.string()).default([]),
});

const schema = z.object({
  title:            z.string().min(1).max(100),
  description:      z.string().max(500).optional().nullable(),
  durationMin:      z.number().int().refine(isValidPrivateDuration, "Duration must be a 15-minute interval from 15 minutes to 4 hours.").default(60),
  maxAthletes:      z.number().int().positive().default(1),
  basePrice:        z.number().nonnegative(),
  locationId:       z.string().optional().nullable(),
  coachTierLabel:   z.string().optional().nullable(),
  eligibleCoachIds: z.array(z.string()).default([]),
  priceOptions:     z.array(priceOption).default([]),
  active:           z.boolean().default(true),
  sortOrder:        z.number().int().default(0),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  // Privates live under the "events / purchase options" permission. Owner
  // bypasses; staff need at least edit-level access on `events`.
  const guard = requirePermission(session, "events", "edit");
  if (guard) return guard;

  try {
    const data = schema.parse(await req.json());
    const type = await prisma.privateLessonType.create({
      data: { clubId: session!.user.clubId, ...data },
    });
    return NextResponse.json(type, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
