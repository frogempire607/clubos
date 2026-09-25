import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { requirePermission } from "@/lib/apiGuard";

// POST /api/events/[id]/duplicate
//
// A copy for the NEXT one of these (B16 slice 3): every setting comes along —
// pricing, payment methods, approval, questions, documents, staff, sessions
// with their prices, and the roster with its capacities — and nothing that
// belongs to the original's people or money does: no registrations, entries,
// bookings, transactions, invoices or payroll.
//
// The public link is NOT copied. The copy keeps the original's signup setting,
// and the editor (which opens on the copy) mints a fresh link from the NEW name
// on its first save — a link minted now would be named "…-copy" forever,
// because links never change once shared.
export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "events", "edit");
  if (denied) return denied;

  const src = await prisma.event.findFirst({
    where: { id, clubId: session.user.clubId, deletedAt: null },
    include: {
      sessions: true,
      rosters: { orderBy: { sortOrder: "asc" } },
      rosterPositions: { orderBy: { sortOrder: "asc" } },
      staffAssignments: true,
      documentLinks: true,
    },
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
    rosters,
    rosterPositions,
    staffAssignments,
    documentLinks,
    ...rest
  } = src;

  const data = {
    ...rest,
    name: `${src.name} (Copy)`,
    publicSlug: null,
    publicRegistration: false,
    variableCostBilledAt: null,
  } as unknown as Prisma.EventUncheckedCreateInput;

  const copy = await prisma.$transaction(async (db) => {
    const created = await db.event.create({ data });
    if (sessions.length > 0) {
      await db.eventSession.createMany({
        data: sessions.map((s) => ({
          eventId: created.id,
          name: s.name,
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          sortOrder: s.sortOrder,
          price: s.price,
        })),
      });
    }
    if (rosters.length > 0) {
      await db.eventRoster.createMany({
        data: rosters.map((r) => ({ eventId: created.id, label: r.label, sortOrder: r.sortOrder })),
      });
    }
    if (rosterPositions.length > 0) {
      await db.eventRosterPosition.createMany({
        data: rosterPositions.map((p) => ({ eventId: created.id, label: p.label, capacity: p.capacity, sortOrder: p.sortOrder })),
      });
    }
    if (staffAssignments.length > 0) {
      await db.eventStaffAssignment.createMany({
        data: staffAssignments.map((a) => ({ clubId: a.clubId, eventId: created.id, userId: a.userId, role: a.role })),
        skipDuplicates: true,
      });
    }
    if (documentLinks.length > 0) {
      await db.eventDocumentLink.createMany({
        data: documentLinks.map((l) => ({ clubId: l.clubId, documentId: l.documentId, eventId: created.id })),
        skipDuplicates: true,
      });
    }
    return created;
  });

  return NextResponse.json(copy, { status: 201 });
}
