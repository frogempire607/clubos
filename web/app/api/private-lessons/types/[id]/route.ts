import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isValidPrivateDuration } from "@/lib/privateLessonRules";
import { requirePermission } from "@/lib/apiGuard";
import { validScheduleStaffIds } from "@/lib/staffAssignmentsServer";
import { recordStaffActivity, actorFrom } from "@/lib/staffActivity";

const priceOption = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(60),
  price: z.number().nonnegative(),
  // ALL (default) | MEMBER | NON_MEMBER — who may pick this option.
  audience: z.enum(["ALL", "MEMBER", "NON_MEMBER"]).optional().default("ALL"),
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

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  const guard = requirePermission(session, "events", "edit");
  if (guard) return guard;

  const type = await requireType(params.id, session!.user.clubId);
  if (!type) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const data = await cleanCoachIds(session!.user.clubId, schema.parse(await req.json()));
    const updated = await prisma.privateLessonType.update({ where: { id: params.id }, data });

    // B21 — a coach added to / removed from this lesson type shows in that
    // coach's Recent activity. After the write; best-effort (never fails the save).
    if (data.eligibleCoachIds !== undefined) {
      const before = new Set(Array.isArray(type.eligibleCoachIds) ? (type.eligibleCoachIds as unknown[]).map(String) : []);
      const after = new Set(data.eligibleCoachIds);
      const name = updated.title;
      const base = { clubId: session!.user.clubId, ...actorFrom(session), kind: "LESSONS" as const };
      for (const id of Array.from(after)) {
        if (!before.has(id)) await recordStaffActivity({ ...base, staffUserId: id, summary: `Added to ${name}` });
      }
      for (const id of Array.from(before)) {
        if (!after.has(id)) await recordStaffActivity({ ...base, staffUserId: id, summary: `Removed from ${name}` });
      }
    }

    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  // Deletion is a more destructive action, so require full events access.
  const guard = requirePermission(session, "events", "full");
  if (guard) return guard;

  const type = await requireType(params.id, session!.user.clubId);
  if (!type) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.privateLessonType.update({ where: { id: params.id }, data: { deletedAt: new Date() } });
  return new NextResponse(null, { status: 204 });
}
