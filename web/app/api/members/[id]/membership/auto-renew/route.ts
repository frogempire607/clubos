import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermissionLive } from "@/lib/apiGuard";
import { setAutoRenewFromPanel } from "@/lib/membershipMoneyServer";

// B16 — POST /api/members/[id]/membership/auto-renew   (billing:full)
//
// The panel's auto-renew switch. Runs lib/autopay.setAutoRenew (Stripe:
// cancel_at at the commitment end, or cancel_at_period_end, or both cleared;
// cash rows: offlineStopDate) and records RENEWAL_CHANGED with who did it.
// `preview: true` returns "Off: ends Nov 20, 2026 after the commitment — no
// more charges after that." without changing anything.

const schema = z.object({
  subscriptionId: z.string().min(1),
  autoRenew: z.boolean(),
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
  const r = await setAutoRenewFromPanel({
    clubId: session.user.clubId, memberId: id, subscriptionId: data.subscriptionId, actorUserId: session.user.id ?? null,
    on: data.autoRenew, preview: data.preview,
  });
  if (!r.ok) return NextResponse.json({ error: r.error, code: r.code }, { status: r.status });
  return NextResponse.json(r);
}
