import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import { sanitizeRichHtml } from "@/lib/sanitizeHtml";
import { proposeRegistrationChange, canDecideRegistrations } from "@/lib/eventApproval";

const bodySchema = z.object({
  // Shape only. WHICH keys are allowed depends on the event's own category
  // fields, so that check lives in proposeRegistrationChange where the event is
  // already loaded — an unknown key is still a 400, it is just no longer a
  // fixed list written in one sport's vocabulary.
  changes: z
    .record(z.string().max(40), z.union([z.string().max(500), z.boolean(), z.number()]))
    .refine((c) => Object.keys(c).length > 0, "Propose at least one change."),
  message: z.string().trim().max(2000).optional(),
  priceDelta: z.number().finite().optional(),
});

// POST /api/events/[id]/registrations/[regId]/propose-change
// The coach wants a different spot — a weight class, a division, a session, an
// added dual — and the parent has to agree before it counts (plan.md §5.4.6).
//
// No money moves here, ever. A price delta is recorded so the parent sees it
// before they agree; it is collected only when they accept (§5.4.7), and only
// against fresh consent for the delta.
export async function POST(req: Request, context: { params: Promise<{ id: string; regId: string }> }) {
  const { id: eventId, regId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role === "MEMBER") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const rl = rateLimit({ key: `approve:event:${session.user.id}`, limit: 60, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many changes at once. Try again in a moment.");

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

  const canEdit = hasPermission((session.user as unknown as { permissions?: Record<string, unknown> | null }).permissions ?? null, "events", "edit");
  if (!canDecideRegistrations(session, event, canEdit)) {
    return NextResponse.json(
      {
        error: "PERMISSION_REQUIRED",
        message: "You need event-editing permission, or to be this event's responsible coach, to propose changes.",
      },
      { status: 403 },
    );
  }

  const result = await proposeRegistrationChange({
    registrationId: regId,
    clubId: session.user.clubId,
    actorUserId: session.user.id ?? null,
    changes: body.changes,
    // Renders in the parent's email — sanitized on write like every other
    // owner-typed string that leaves the building.
    message: body.message ? sanitizeRichHtml(body.message) : null,
    priceDelta: body.priceDelta ?? null,
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
