import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import type { Prisma } from "@prisma/client";
import { randomBytes } from "crypto";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive } from "@/lib/apiGuard";
import { writeBillingAudit } from "@/lib/billingAudit";
import { parseGroupRates, validateGroupRates, groupRateSummary } from "@/lib/membershipGroupRates";

// B3 slice 3 — Settings → Billing → Group rates (memberships). Any number,
// each named by the club. Saving changes no price: new purchases follow the
// rates, running memberships are listed under "To review".
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "billing", "view");
  if (denied) return denied;
  const club = await prisma.club.findUnique({ where: { id: session.user.clubId }, select: { groupRates: true } });
  const rates = parseGroupRates(club?.groupRates);
  // How many athletes have answered each rate — so the owner sees the rate reaches someone.
  const members = await prisma.member.findMany({ where: { clubId: session.user.clubId, deletedAt: null }, select: { groupValues: true } });
  const answered: Record<string, number> = {};
  for (const m of members) {
    const v = (m.groupValues ?? {}) as Record<string, unknown>;
    for (const r of rates) if (typeof v[r.id] === "string" && (v[r.id] as string).trim()) answered[r.id] = (answered[r.id] ?? 0) + 1;
  }
  return NextResponse.json({ rates, answered });
}

export async function PUT(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "billing", "full");
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  const v = validateGroupRates(body?.rates, () => `gr_${randomBytes(5).toString("hex")}`);
  if (!v.ok) return NextResponse.json({ error: v.message }, { status: 400 });
  const clubId = session.user.clubId;
  const before = await prisma.club.findUnique({ where: { id: clubId }, select: { groupRates: true } });
  await prisma.club.update({ where: { id: clubId }, data: { groupRates: v.value as unknown as Prisma.InputJsonValue } });
  await writeBillingAudit({
    clubId, actorUserId: session.user.id ?? null, action: "GROUP_RATES_SET",
    before: before?.groupRates ?? null, after: v.value,
    note: v.value.length ? `Group rates: ${v.value.map(groupRateSummary).join(" ")} No price changed.` : "Group rates removed. No price changed.",
  });
  return NextResponse.json({ ok: true, rates: v.value });
}
