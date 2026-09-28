import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermissionLive } from "@/lib/apiGuard";
import { paidAnotherWay } from "@/lib/membershipMoneyServer";

// B16 — POST /api/members/[id]/membership/paid-another-way   (billing:full)
//
// "They paid another way this time" (card rows) / "Record a payment" (cash
// rows). Records the cash/check as RECEIVED for the upcoming period and, on a
// Stripe row, skips exactly that one card charge so the family is never
// charged twice (lib/membershipMoneyServer — one-time 100% coupon). Plan,
// price, commitment and billing date are untouched.
//
// `preview: true` returns the sentences and changes nothing. A real call must
// send back the `expectedSkipAt` the preview showed; a moved charge date is
// refused rather than skipping a different invoice than the one confirmed.

const schema = z.object({
  subscriptionId: z.string().min(1),
  method: z.enum(["CASH", "CHECK"]).default("CASH"),
  amount: z.number().positive().max(100000).optional().nullable(),
  reference: z.string().max(120).optional().nullable(),
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
  const r = await paidAnotherWay({
    clubId: session.user.clubId, memberId: id, subscriptionId: data.subscriptionId, actorUserId: session.user.id ?? null,
    method: data.method, amount: data.amount ?? null, reference: data.reference ?? null, preview: data.preview, expectedSkipAt: data.expectedSkipAt ?? null,
  });
  if (!r.ok) return NextResponse.json({ error: r.error, code: r.code }, { status: r.status });
  return NextResponse.json(r);
}
