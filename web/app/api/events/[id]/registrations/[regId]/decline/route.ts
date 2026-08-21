import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import { sanitizeRichHtml } from "@/lib/sanitizeHtml";
import { declineRegistration, canDecideRegistrations } from "@/lib/eventApproval";

const bodySchema = z.object({
  // Required, and it reaches the parent verbatim — a decline with no reason is
  // the thing that generates the phone call this workflow exists to avoid.
  reason: z.string().trim().min(1, "Give the family a reason.").max(500),
});

// POST /api/events/[id]/registrations/[regId]/decline
// The coach can't accept this registration as submitted (plan.md §5.4.6).
//
// Declining a registration that already paid MUST refund it — a declined but
// still-charged registration is never a correct terminal state. That is why
// this route computes `canRefund` from finance permission and passes it down:
// a coach without it is refused before anything is written, rather than
// producing a half-finished decline an owner has to discover later.
export const maxDuration = 60;

export async function POST(req: Request, context: { params: Promise<{ id: string; regId: string }> }) {
  const { id: eventId, regId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role === "MEMBER") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const rl = rateLimit({ key: `approve:event:${session.user.id}`, limit: 60, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many decisions at once. Try again in a moment.");

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json().catch(() => ({})));
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    throw err;
  }

  const event = await prisma.event.findFirst({
    where: { id: eventId, clubId: session.user.clubId, deletedAt: null },
    select: { id: true, responsibleCoachUserId: true },
  });
  if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });

  const perms = (session.user as unknown as { permissions?: Record<string, unknown> | null }).permissions ?? null;
  const canEdit = hasPermission(perms, "events", "edit");
  if (!canDecideRegistrations(session, event, canEdit)) {
    return NextResponse.json(
      {
        error: "PERMISSION_REQUIRED",
        message: "You need event-editing permission, or to be this event's responsible coach, to decline registrations.",
      },
      { status: 403 },
    );
  }

  const canRefund = session.user.role === "OWNER" || hasPermission(perms, "finances", "full");

  const result = await declineRegistration({
    registrationId: regId,
    clubId: session.user.clubId,
    actorUserId: session.user.id ?? null,
    // The reason renders inside an email body, so it is sanitized on write —
    // the same rule Document.body follows.
    reason: sanitizeRichHtml(body.reason),
    canRefund,
  });

  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.code,
        message: result.message,
        currentStatus: result.currentStatus,
        currentApprovalStatus: result.currentApprovalStatus,
      },
      { status: result.status },
    );
  }

  return NextResponse.json(result);
}
