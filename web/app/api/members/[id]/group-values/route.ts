import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import type { Prisma } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive } from "@/lib/apiGuard";
import { parseGroupRates, cleanGroupValues, readGroupValues } from "@/lib/membershipGroupRates";

// PUT /api/members/[id]/group-values — B3 slice 3. Staff set which group
// (team, school, …) an athlete is in for each club group rate. Changes no
// price; the Membership panel then recommends the rate if it's earned.
export async function PUT(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "members", "edit");
  if (denied) return denied;
  const member = await prisma.member.findFirst({ where: { id, clubId: session.user.clubId, deletedAt: null }, select: { id: true, groupValues: true } });
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const club = await prisma.club.findUnique({ where: { id: session.user.clubId }, select: { groupRates: true } });
  const body = await req.json().catch(() => ({}));
  const v = cleanGroupValues(parseGroupRates(club?.groupRates), body?.values ?? {});
  if (!v.ok) return NextResponse.json({ error: v.message }, { status: 400 });
  // Answers for rates not sent are kept (another rate's answer isn't wiped).
  const next = { ...readGroupValues(member.groupValues), ...v.value };
  for (const k of Object.keys(body?.values ?? {})) if (!v.value[k]) delete next[k];
  await prisma.member.update({ where: { id }, data: { groupValues: next as Prisma.InputJsonValue } });
  return NextResponse.json({ ok: true, groupValues: next });
}
