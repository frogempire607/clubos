import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import type { Prisma } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveFamilyContext } from "@/lib/memberContext";
import { parseGroupRates, cleanGroupValues, readGroupValues } from "@/lib/membershipGroupRates";

// GET  /api/member/group-values — the club's group rates (the questions) and
// each accessible athlete's answers. PUT { memberId, values } — a family
// answers for itself or a child they guardian. Changes no price.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const [club, user] = await Promise.all([
    prisma.club.findUnique({ where: { id: session.user.clubId }, select: { groupRates: true } }),
    prisma.user.findUnique({ where: { id: session.user.id }, select: { email: true } }),
  ]);
  const rates = parseGroupRates(club?.groupRates).filter((r) => r.on).map((r) => ({ id: r.id, label: r.label, options: r.options }));
  const resolved = user ? await resolveFamilyContext(session.user.id, session.user.clubId, user.email) : null;
  const ids = resolved && resolved !== "FORBIDDEN" ? resolved.accessible.map((a) => a.id) : [];
  const members = ids.length ? await prisma.member.findMany({ where: { id: { in: ids } }, select: { id: true, groupValues: true } }) : [];
  return NextResponse.json({ rates, values: Object.fromEntries(members.map((m) => [m.id, readGroupValues(m.groupValues)])) });
}

export async function PUT(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { email: true } });
  const resolved = user ? await resolveFamilyContext(session.user.id, session.user.clubId, user.email, body?.memberId ?? undefined) : null;
  if (!resolved || resolved === "FORBIDDEN" || !resolved.context) return NextResponse.json({ error: "You can't change that profile." }, { status: 403 });
  const member = await prisma.member.findUnique({ where: { id: resolved.context.id }, select: { id: true, groupValues: true } });
  const club = await prisma.club.findUnique({ where: { id: session.user.clubId }, select: { groupRates: true } });
  const rates = parseGroupRates(club?.groupRates).filter((r) => r.on);
  const v = cleanGroupValues(rates, body?.values ?? {});
  if (!v.ok) return NextResponse.json({ error: v.message }, { status: 400 });
  const next = { ...readGroupValues(member?.groupValues), ...v.value };
  for (const k of Object.keys(body?.values ?? {})) if (!v.value[k] && rates.some((r) => r.id === k)) delete next[k];
  await prisma.member.update({ where: { id: resolved.context.id }, data: { groupValues: next as Prisma.InputJsonValue } });
  return NextResponse.json({ ok: true, groupValues: next });
}
