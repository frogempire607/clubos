import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import { respondToProposal } from "@/lib/eventApproval";
import { assertCanRespondToRegistration } from "@/lib/memberRegistrationAccess";

const bodySchema = z.object({
  // Required when the proposal costs more. The AMOUNT is re-derived server-side
  // from the stored proposal — this only records that the payer agreed, and to
  // exactly what wording.
  additionalConsent: z
    .object({ agreed: z.literal(true), buttonLabel: z.string().max(200).optional(), amount: z.number() })
    .optional()
    .nullable(),
});

// POST /api/member/events/[id]/registrations/[regId]/proposal/accept
// The family agrees to the coach's proposed change (plan.md §5.4.7).
//
// Accepting IS approving — the coach's proposal was their approval, conditional
// on this answer — so this re-enters the same approve pipeline the coach route
// uses, with the coach recorded as the approver.
export const maxDuration = 60;

export async function POST(req: Request, context: { params: Promise<{ id: string; regId: string }> }) {
  const { regId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rl = rateLimit({ key: `respond:event:${session.user.id}`, limit: 20, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many attempts. Try again in a moment.");

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json().catch(() => ({})));
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const access = await assertCanRespondToRegistration(session, regId);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const result = await respondToProposal({
    registrationId: regId,
    clubId: session.user.clubId,
    actorUserId: session.user.id,
    accept: true,
    additionalConsent: body.additionalConsent ?? null,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.code, message: result.message, currentStatus: result.currentStatus },
      { status: result.status },
    );
  }
  return NextResponse.json(result);
}
