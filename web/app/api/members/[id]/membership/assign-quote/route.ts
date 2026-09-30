import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermissionLive } from "@/lib/apiGuard";
import { quoteAssignment } from "@/lib/membershipAssignQuoteServer";

// GET /api/members/[id]/membership/assign-quote
//   ?membershipId=…&optionId=…&priceOverride=…&discountCode=…&applyFamily=1&method=CARD|CASH|OFFER
//
// The Assign sheet's live price: the option, each discount it could get
// (sibling, group rate, a typed code), which one wins, the per-period price
// and the first charge. Read-only; billing:view. Every assign path recomputes
// this at commit — nothing here is trusted back from the browser.
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "billing", "view");
  if (denied) return denied;

  const q = new URL(req.url).searchParams;
  const membershipId = q.get("membershipId");
  const optionId = q.get("optionId");
  if (!membershipId || !optionId) return NextResponse.json({ error: "membershipId and optionId are required." }, { status: 400 });
  const rawOverride = q.get("priceOverride");
  const priceOverride = rawOverride != null && rawOverride !== "" ? Number(rawOverride) : null;
  if (priceOverride != null && (!Number.isFinite(priceOverride) || priceOverride < 0 || priceOverride > 100000)) {
    return NextResponse.json({ error: "Enter a price of $0 or more." }, { status: 400 });
  }
  const m = (q.get("method") || "CARD").toUpperCase();
  const method = m === "CASH" || m === "OFFER" ? m : "CARD";

  const r = await quoteAssignment({
    clubId: session.user.clubId,
    memberId: id,
    membershipId,
    optionId,
    priceOverride,
    discountCode: q.get("discountCode"),
    applyFamily: q.get("applyFamily") !== "0",
    method,
  });
  if (!r.ok) return NextResponse.json({ error: r.error, code: r.code }, { status: r.status });
  return NextResponse.json({ quote: r.quote });
}
