import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import { respondToProposal } from "@/lib/eventApproval";
import { assertCanRespondToRegistration } from "@/lib/memberRegistrationAccess";

// POST /api/member/events/[id]/registrations/[regId]/proposal/decline
// Body: {} — the family can't take the coach's proposed change (§5.4.7).
//
// Functionally a cancellation, so it refunds a registration that already paid.
// Unlike the coach's decline there is no finance permission to test: the actor
// IS the payer, and the refund is unconditional.
export const maxDuration = 60;

export async function POST(_req: Request, context: { params: Promise<{ id: string; regId: string }> }) {
  const { regId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rl = rateLimit({ key: `respond:event:${session.user.id}`, limit: 20, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many attempts. Try again in a moment.");

  const access = await assertCanRespondToRegistration(session, regId);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const result = await respondToProposal({
    registrationId: regId,
    clubId: session.user.clubId,
    actorUserId: session.user.id,
    accept: false,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.code, message: result.message, currentStatus: result.currentStatus },
      { status: result.status },
    );
  }
  return NextResponse.json(result);
}
