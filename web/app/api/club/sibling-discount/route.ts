import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import type { Prisma } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive } from "@/lib/apiGuard";
import { writeBillingAudit } from "@/lib/billingAudit";
import { parseMembershipSibling, validateMembershipSibling, membershipSiblingSummary } from "@/lib/membershipSiblingDiscount";
import { siblingDrift } from "@/lib/membershipSiblingServer";

// B3 slice 2 — Settings → Billing → Sibling membership discount.
// GET: the rule, the plans it can cover, and every membership whose price
// doesn't match it (the list the Action Center links to).
// PUT: save the rule. Saving never changes a price — new purchases follow it,
// running memberships are listed here for the owner to apply.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "billing", "view");
  if (denied) return denied;
  const clubId = session.user.clubId;
  const [club, plans, drift] = await Promise.all([
    prisma.club.findUnique({ where: { id: clubId }, select: { siblingDiscount: true } }),
    prisma.membership.findMany({ where: { clubId, deletedAt: null, active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    siblingDrift(clubId).catch(() => []),
  ]);
  const config = parseMembershipSibling(club?.siblingDiscount);
  return NextResponse.json({
    config,
    summary: membershipSiblingSummary(config),
    plans,
    review: drift.map((l) => ({
      memberId: l.memberId, name: l.memberName, subId: l.subId, drift: l.drift, label: l.label, price: l.price, expected: l.expected,
    })),
  });
}

export async function PUT(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "billing", "full");
  if (denied) return denied;
  const clubId = session.user.clubId;
  const body = await req.json().catch(() => null);
  const v = validateMembershipSibling(body);
  if (!v.ok) return NextResponse.json({ error: v.message }, { status: 400 });
  const before = await prisma.club.findUnique({ where: { id: clubId }, select: { siblingDiscount: true } });
  await prisma.club.update({ where: { id: clubId }, data: { siblingDiscount: v.value as unknown as Prisma.InputJsonValue } });
  await writeBillingAudit({
    clubId,
    actorUserId: session.user.id ?? null,
    action: "SIBLING_DISCOUNT_RULE_SET",
    before: before?.siblingDiscount ?? null,
    after: v.value,
    note: `Sibling membership discount: ${membershipSiblingSummary(v.value)} No price changed.`,
  });
  return NextResponse.json({ ok: true, config: v.value, summary: membershipSiblingSummary(v.value) });
}
