import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermission } from "@/lib/apiGuard";
import { loadEventAttendees } from "@/lib/eventAttendeesServer";

// GET /api/events/[id]/attendees
//
// READ-ONLY. One list merging the roster (Booking) and the money
// (EventRegistration) for display — the design handoff's Attendees screen.
// This route never writes: recording a payment, approving, cancelling or
// adding someone still goes through the registration routes, because the
// registration is the money spine and nothing writes event money except
// through one (CLAUDE.md, "Event money model"). Unlike the registrations GET,
// this deliberately runs NO lazy charge/reminder sweep — a list that people
// open to look at must not be the thing that charges a card.
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "events", "view");
  if (denied) return denied;

  const payload = await loadEventAttendees(session.user.clubId, params.id);
  if (!payload) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(payload);
}
