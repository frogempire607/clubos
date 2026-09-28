import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermissionLive } from "@/lib/apiGuard";
import { refundPaymentTx } from "@/lib/membershipMoneyServer";

// B16 — POST /api/members/[id]/membership/refund   (billing:full)
//
// Refund one payment from the membership's payment list — full or partial,
// never more than paid minus already refunded. Card payments: a real
// stripe.refunds.create on the club's connected account against the original
// charge (or payment intent); the row takes Stripe's running total, which is
// exactly what the charge.refunded webhook writes too, so a refund is counted
// once. Cash/check: recorded on the same row (refundedAmount/At/Reason/By),
// which is what Reports subtract. Nothing here creates a second money row.

const schema = z.object({
  transactionId: z.string().min(1),
  subscriptionId: z.string().optional().nullable(),
  amount: z.number().positive().max(100000).optional().nullable(),
  reason: z.string().max(120).default(""),
  preview: z.boolean().optional().default(false),
  confirm: z.boolean().optional(),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "billing", "full");
  if (denied) return denied;
  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    throw err;
  }
  if (!data.preview && data.confirm !== true) return NextResponse.json({ error: "This action requires explicit confirmation." }, { status: 400 });
  const r = await refundPaymentTx({
    clubId: session.user.clubId, memberId: id, subscriptionId: data.subscriptionId ?? null, transactionId: data.transactionId,
    actorUserId: session.user.id ?? null, amount: data.amount ?? null, reason: data.reason, preview: data.preview,
  });
  if (!r.ok) return NextResponse.json({ error: r.error, code: r.code }, { status: r.status });
  return NextResponse.json(r);
}
