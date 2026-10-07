import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isValidPrivateDuration } from "@/lib/privateLessonRules";
import { requirePermission } from "@/lib/apiGuard";
import { validScheduleStaffIds } from "@/lib/staffAssignmentsServer";

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
  // ALL (default) | MEMBER | NON_MEMBER — who may pick this option.
  audience: z.enum(["ALL", "MEMBER", "NON_MEMBER"]).optional().default("ALL"),
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

// Coach ids on a lesson type (who may teach it, and per-option coach limits)
// are reduced to this club's current OWNER/STAFF before they are stored.
async function cleanCoachIds<T extends { eligibleCoachIds?: string[]; priceOptions?: { coachIds: string[] }[] }>(
  clubId: string,
  data: T,
): Promise<T> {
  const all = [...(data.eligibleCoachIds ?? []), ...(data.priceOptions ?? []).flatMap((o) => o.coachIds)];
  if (all.length === 0) return data;
  const ok = new Set(await validScheduleStaffIds(clubId, all));
  return {
    ...data,
    ...(data.eligibleCoachIds ? { eligibleCoachIds: data.eligibleCoachIds.filter((id) => ok.has(id)) } : {}),
    ...(data.priceOptions
      ? { priceOptions: data.priceOptions.map((o) => ({ ...o, coachIds: o.coachIds.filter((id) => ok.has(id)) })) }
      : {}),
  };
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  // Privates live under the "events / purchase options" permission. Owner
  // bypasses; staff need at least edit-level access on `events`.
  const guard = requirePermission(session, "events", "edit");
  if (guard) return guard;

  try {
    const data = await cleanCoachIds(session!.user.clubId, schema.parse(await req.json()));
    const type = await prisma.privateLessonType.create({
      data: { clubId: session!.user.clubId, ...data },
    });
    return NextResponse.json(type, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
