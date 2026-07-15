import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { DISCOUNT_ITEM_TYPES, type DiscountItemType } from "@/lib/discounts";

// GET /api/discounts/eligible?itemType=MEMBERSHIP&membershipId=…&price=…
//
// The staff/owner discount DROPDOWN's data source: every club discount with
// its display facts plus a server-computed `eligible` flag for the given item
// (ineligible/expired/inactive rows are returned greyed-out so staff can see
// WHY something isn't offered, but only eligible ones are selectable).
// Amounts are display-only — every purchase route re-validates the code and
// recomputes the price server-side; nothing from this payload is trusted.
//
// Staff-gated: billing:view (owners bypass). Clients never see this — the
// public flows keep their type-a-code behavior.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "billing", "view");
  if (denied) return denied;

  const url = new URL(req.url);
  const itemType = (url.searchParams.get("itemType") || "").toUpperCase() as DiscountItemType;
  const membershipId = url.searchParams.get("membershipId");
  if (!DISCOUNT_ITEM_TYPES.some((t) => t.key === itemType)) {
    return NextResponse.json({ error: "itemType required" }, { status: 400 });
  }

  const rows = await prisma.discount.findMany({
    where: { clubId: session.user.clubId },
    orderBy: [{ active: "desc" }, { code: "asc" }],
  });

  const now = new Date();
  const items = rows.map((d) => {
    const appliesTo = Array.isArray(d.appliesTo) ? (d.appliesTo as string[]) : [];
    const planScope = Array.isArray(d.membershipIds) ? (d.membershipIds as string[]) : [];
    const expired = !!d.expiresAt && d.expiresAt < now;
    const exhausted = d.maxUses != null && d.usedCount >= d.maxUses;
    // Mirrors findValidDiscountFor: empty appliesTo = all types, EXCEPT the
    // legacy plan-narrowed case which is memberships-only.
    const typeOk =
      appliesTo.length > 0 ? appliesTo.includes(itemType) : planScope.length > 0 ? itemType === "MEMBERSHIP" : true;
    const planOk =
      itemType !== "MEMBERSHIP" || planScope.length === 0 || (membershipId ? planScope.includes(membershipId) : false);
    const eligible = d.active && !expired && !exhausted && typeOk && planOk;
    let reason: string | null = null;
    if (!d.active) reason = "Inactive";
    else if (expired) reason = "Expired";
    else if (exhausted) reason = "Usage limit reached";
    else if (!typeOk) reason = "Not valid for this item type";
    else if (!planOk) reason = membershipId ? "Not valid for this plan" : "Limited to specific plans";
    return {
      id: d.id,
      code: d.code,
      name: d.description || d.code,
      type: d.type, // PERCENT | FIXED
      value: Number(d.value),
      amountLabel: d.type === "PERCENT" ? `${Number(d.value)}% off` : `$${Number(d.value).toFixed(2)} off`,
      appliesTo: appliesTo.length ? appliesTo : ["ALL"],
      expiresAt: d.expiresAt,
      active: d.active,
      eligible,
      reason,
      usesLeft: d.maxUses != null ? Math.max(0, d.maxUses - d.usedCount) : null,
    };
  });

  return NextResponse.json({ discounts: items });
}
