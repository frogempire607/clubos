import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import { approveRegistration, canDecideRegistrations } from "@/lib/eventApproval";

// POST /api/events/[id]/registrations/[regId]/approve
// The coach accepts this registration as submitted (plan.md §5.4.6).
//
// Body: {} — approval takes no parameters. Approving something OTHER than what
// the parent submitted is `propose-change`, which hands the decision back to
// them; there is no path where a coach silently alters a registration and
// approves the altered version.
//
// Everything this does — capacity re-check, the status transition per payment
// method, the Booking, the charge or the first invoice, the audit row, the
// email — is in lib/eventApproval.approveRegistration, because §5.4.7's
// parent-accepts-a-proposal path re-enters the same function.
export const maxDuration = 60;

export async function POST(_req: Request, context: { params: Promise<{ id: string; regId: string }> }) {
  const { id: eventId, regId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role === "MEMBER") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Approving is a money-moving decision on a real family's registration; the
  // limit is per-user and generous enough for a coach clearing a queue.
  const rl = rateLimit({ key: `approve:event:${session.user.id}`, limit: 60, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many approvals at once. Try again in a moment.");

  const event = await prisma.event.findFirst({
    where: { id: eventId, clubId: session.user.clubId, deletedAt: null },
    select: { id: true, responsibleCoachUserId: true },
  });
  if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });

  const canEdit = hasPermission((session.user as unknown as { permissions?: Record<string, unknown> | null }).permissions ?? null, "events", "edit");
  if (!canDecideRegistrations(session, event, canEdit)) {
    return NextResponse.json(
      {
        error: "PERMISSION_REQUIRED",
        message: "You need event-editing permission, or to be this event's responsible coach, to approve registrations.",
      },
      { status: 403 },
    );
  }

  const result = await approveRegistration({
    registrationId: regId,
    clubId: session.user.clubId,
    actorUserId: session.user.id ?? null,
  });

  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.code,
        message: result.message,
        // The caller's view was stale — hand back the truth so the roster can
        // re-render instead of showing a button that will fail again.
        currentStatus: result.currentStatus,
        currentApprovalStatus: result.currentApprovalStatus,
      },
      { status: result.status },
    );
  }

  return NextResponse.json(result);
}
