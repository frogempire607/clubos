import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { resolveEventPolicy } from "@/lib/eventPayments";
import { validateRosterDef } from "@/lib/eventRoster";
import { loadRosterDef, rosterGrid, saveRosterDef, backfillEntriesFromAnswers } from "@/lib/eventRosterServer";

// B16 — the event's roster positions.
//
// GET  (events:view)  the definition (rosters = columns, positions = rows) and
//                     the coach's grid with names, pending requests and waitlist.
// PUT  (events:edit)  replace the definition. Rows keep their ids; removing a
//                     roster or position someone signed up for is refused.

async function eventFor(id: string, clubId: string) {
  return prisma.event.findFirst({
    where: { id, clubId, deletedAt: null },
    include: { customEventType: { select: { defaultPolicy: true } } },
  });
}

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "events", "view");
  if (denied) return denied;
  const event = await eventFor(id, session.user.clubId);
  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const policy = resolveEventPolicy(event);
  const [def, grid, entries] = await Promise.all([
    loadRosterDef(event.id),
    rosterGrid(event.id, policy.holdSpotDuringReview),
    // Per registration, for the coach's "move this entry" picker.
    prisma.eventRegistrationEntry.findMany({
      where: { eventId: event.id, status: { not: "DROPPED" } },
      orderBy: [{ registrationId: "asc" }, { sortOrder: "asc" }],
      select: { id: true, registrationId: true, rosterId: true, positionId: true, status: true },
    }),
  ]);
  return NextResponse.json({
    event: { id: event.id, name: event.name, startsAt: event.startsAt, requiresCoachApproval: policy.requiresCoachApproval },
    definition: def,
    grid,
    entries,
  });
}

export async function PUT(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "events", "edit");
  if (denied) return denied;
  const event = await eventFor(id, session.user.clubId);
  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const checked = validateRosterDef({
    rosters: Array.isArray(body?.rosters) ? body.rosters : [],
    positions: Array.isArray(body?.positions) ? body.positions : [],
  });
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
  const saved = await saveRosterDef(event.id, checked.def);
  if (!saved.ok) return NextResponse.json({ error: saved.error, code: "ROSTER_IN_USE" }, { status: saved.status });

  // Built from two dropdowns: place everyone who already answered them.
  let backfill: { placed: number; unmatched: number } | null = null;
  const from = body?.backfillFrom;
  if (from && typeof from.rosterFieldId === "string" && typeof from.positionFieldId === "string") {
    const policy = resolveEventPolicy(event);
    backfill = await backfillEntriesFromAnswers({
      eventId: event.id,
      clubId: event.clubId,
      rosterFieldId: from.rosterFieldId,
      positionFieldId: from.positionFieldId,
      approvalGated: policy.requiresCoachApproval,
      holdSpotDuringReview: policy.holdSpotDuringReview,
    });
  }
  return NextResponse.json({ ok: true, definition: await loadRosterDef(event.id), backfill });
}
