import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermissionLive } from "@/lib/apiGuard";
import { moveChargeDate } from "@/lib/membershipMoneyServer";

// POST /api/members/[id]/membership/charge-date   (billing:full)
//
// "Change charge date" — move a live membership's next charge. Stripe rows:
// the next invoice moves to the new day and the cycle renews on it (trial_end,
// no proration — why, and what `trialing` does and doesn't change, is in
// lib/membershipMoneyServer.moveChargeDate). Cash/check rows: the next due
// date (paid-through) moves. Rules and words: lib/chargeDate.chargeDateMovePlan.
// `preview: true` returns the sentences without touching anything; the commit
// echoes the `from` date the sheet showed and is refused if it moved.

const schema = z.object({
  subscriptionId: z.string().min(1),
  newDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date."),
  preview: z.boolean().optional().default(false),
  expectedFrom: z.string().optional().nullable(),
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
  const r = await moveChargeDate({
    clubId: session.user.clubId, memberId: id, subscriptionId: data.subscriptionId, actorUserId: session.user.id ?? null,
    newDate: data.newDate, preview: data.preview, expectedFrom: data.expectedFrom ?? null,
  });
  if (!r.ok) return NextResponse.json({ error: r.error, code: r.code }, { status: r.status });
  return NextResponse.json(r);
}
