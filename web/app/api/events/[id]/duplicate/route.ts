import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { requirePermission } from "@/lib/apiGuard";

// POST /api/events/[id]/duplicate — clone an event (and its sessions).
// The copy starts unpublished with no public slug so it can't collide.
export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "events", "edit");
  if (denied) return denied;

  const src = await prisma.event.findFirst({
    where: { id, clubId: session.user.clubId, deletedAt: null },
    include: { sessions: true },
  });
  if (!src) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const {
    id: _id,
    createdAt: _c,
    updatedAt: _u,
    deletedAt: _d,
    publicSlug: _slug,
    variableCostBilledAt: _vb,
    sessions,
    ...rest
  } = src;

  // Structural clone of an existing row; JSON columns (pricingOptions,
  // registrationForm…) read back as JsonValue|null which doesn't line up
  // with Prisma's write input type, so cast through unknown.
  const data = {
    ...rest,
    name: `${src.name} (Copy)`,
    publicSlug: null,
    publicRegistration: false,
    variableCostBilledAt: null,
  } as unknown as Prisma.EventUncheckedCreateInput;
  const copy = await prisma.event.create({ data });

  if (sessions.length > 0) {
    await prisma.eventSession.createMany({
      data: sessions.map((s) => ({
        eventId: copy.id,
        name: s.name,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        sortOrder: s.sortOrder,
      })),
    });
  }

  return NextResponse.json(copy, { status: 201 });
}
