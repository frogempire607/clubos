import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermissionLive } from "@/lib/apiGuard";
import { previewAnyPlanChange } from "@/lib/stripePlanChangeServer";

// B12 / B13 slice 3 — GET ?subscriptionId=…&optionId=…[&autoRenew=true|false]
// `kind` in the answer says which change this is: SAME_INTERVAL (Stripe price
// swap at the next invoice), SWITCH (Stripe, different billing cycle: end at
// period end + new subscription that day), OFFLINE (local, from the next
// payment). The commit (POST …/actions change_plan) takes the kind back and
// refuses if the row no longer matches it.
// The exact sentences the "Change plan" dialog shows, computed from LIVE Stripe
// values (period end, trial end, current unit amount). Read-only; billing:view.
// The commit (POST …/actions change_stripe_plan) recomputes the same preview,
// so what the owner confirmed is what gets applied.
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "billing", "view");
  if (denied) return denied;

  const url = new URL(req.url);
  const subscriptionId = url.searchParams.get("subscriptionId");
  const optionId = url.searchParams.get("optionId");
  const ar = url.searchParams.get("autoRenew");
  if (!subscriptionId || !optionId) return NextResponse.json({ error: "subscriptionId and optionId are required." }, { status: 400 });

  const res = await previewAnyPlanChange({
    clubId: session.user.clubId, memberId: id, subscriptionId, optionId,
    autoRenew: ar === "true" ? true : ar === "false" ? false : null,
  });
  if (!res.ok) return NextResponse.json({ error: res.error, code: res.code }, { status: res.status });
  return NextResponse.json(res);
}
