import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermissionLive } from "@/lib/apiGuard";
import { waivePayment } from "@/lib/membershipMoneyServer";

// B16 — POST /api/members/[id]/membership/waive   (billing:full)
//
// "Waive a payment" — one period given free, with a reason ("Volunteer
// help"). Stripe rows: the next invoice is skipped (same one-time coupon as
// paid-another-way) and no money is recorded. Cash rows: paid-through moves
// forward one period. Either way a $0 COMP line records it for Reports (the
// existing "Comped" category — never income) and the history says who and why.

const schema = z.object({
  subscriptionId: z.string().min(1),
  reason: z.string().max(120).default(""),
  preview: z.boolean().optional().default(false),
  expectedSkipAt: z.string().optional().nullable(),
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
  const r = await waivePayment({
    clubId: session.user.clubId, memberId: id, subscriptionId: data.subscriptionId, actorUserId: session.user.id ?? null,
    reason: data.reason, preview: data.preview, expectedSkipAt: data.expectedSkipAt ?? null,
  });
  if (!r.ok) return NextResponse.json({ error: r.error, code: r.code }, { status: r.status });
  return NextResponse.json(r);
}
