import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermissionLive } from "@/lib/apiGuard";
import { switchHowTheyPay } from "@/lib/membershipMoneyServer";

// B16 — POST /api/members/[id]/membership/switch-method   (billing:full)
//
// "Switch how they pay", for good:
//   to_cash — Stripe stops at the end of the paid period and the SAME row
//             carries on as cash from that day (lib/autopay.turnAutopayOff):
//             plan, price, commitment unchanged.
//   to_card — a Stripe subscription on the saved method whose first charge is
//             the day the cash runs out (lib/autopay.turnAutopayOn). If nothing
//             is paid ahead it charges today, and `confirmImmediateCharge` must
//             say so. No saved method → the panel offers the card-setup link
//             (/api/members/[id]/payment-methods/setup) instead.
// This is the fix for the "Advanced billing setup → Cash" trap: that form only
// edits a migration draft; this changes who actually charges.

const schema = z.object({
  subscriptionId: z.string().min(1),
  direction: z.enum(["to_cash", "to_card"]),
  method: z.enum(["CASH", "CHECK"]).default("CASH"),
  confirmImmediateCharge: z.boolean().optional().default(false),
  preview: z.boolean().optional().default(false),
  expectedEffectiveAt: z.string().optional().nullable(),
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
  const r = await switchHowTheyPay({
    clubId: session.user.clubId, memberId: id, subscriptionId: data.subscriptionId, actorUserId: session.user.id ?? null,
    direction: data.direction, method: data.method, confirmImmediateCharge: data.confirmImmediateCharge, preview: data.preview,
    expectedEffectiveAt: data.expectedEffectiveAt ?? null,
  });
  if (!r.ok) return NextResponse.json({ error: r.error, code: r.code }, { status: r.status });
  return NextResponse.json(r);
}
