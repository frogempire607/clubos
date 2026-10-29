import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive } from "@/lib/apiGuard";
import { isCoachRelationship } from "@/lib/membershipSiblingDiscount";

// GET /api/members/[id]/payer   (billing:full) — 2026-10-29
//
// For the "Paid by" sheet. Read-only; the change itself is the
// billing-admin action `set_payer`.
//   ?q=jason        → up to 10 accounts in this club matching name / email
//   ?forUserId=…    → the other athletes that account is linked to as a
//                     guardian or already pays for, so one step can set
//                     "Paid by" on a whole team; plus how that account is
//                     linked to THIS athlete (relationship), so the sheet can
//                     default the "coach, not family" box sensibly.
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "billing", "full");
  if (denied) return denied;
  const clubId = session.user.clubId;
  const member = await prisma.member.findFirst({
    where: { id, clubId, deletedAt: null },
    select: { id: true, lastName: true, responsiblePayerUserId: true },
  });
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const forUserId = url.searchParams.get("forUserId");

  if (forUserId) {
    const user = await prisma.user.findFirst({ where: { id: forUserId, clubId, deletedAt: null }, select: { id: true } });
    if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const athletes = await prisma.member.findMany({
      where: {
        clubId, deletedAt: null, id: { not: member.id },
        OR: [
          { responsiblePayerUserId: forUserId },
          { guardianLinks: { some: { userId: forUserId, status: "CONFIRMED" } } },
        ],
      },
      select: {
        id: true, firstName: true, lastName: true, responsiblePayerUserId: true,
        guardianLinks: { where: { userId: forUserId, status: "CONFIRMED" }, select: { relationship: true }, take: 1 },
      },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      take: 60,
    });
    const own = await prisma.memberGuardianUser.findFirst({
      where: { clubId, memberId: member.id, userId: forUserId, status: "CONFIRMED" },
      select: { relationship: true },
    });
    // Linked to athletes from more than one family (different last names) →
    // most likely a coach. A suggestion for the sheet's default only.
    const lastNames = new Set([member.lastName, ...athletes.map((a) => a.lastName)].map((n) => (n ?? "").trim().toLowerCase()).filter(Boolean));
    return NextResponse.json({
      relationshipToThis: own ? own.relationship ?? null : null,
      linkedHere: !!own,
      looksLikeTeam: lastNames.size > 1,
      isCoachHere: isCoachRelationship(own?.relationship),
      athletes: athletes.map((a) => ({
        id: a.id,
        name: `${a.firstName} ${a.lastName}`.trim(),
        alreadyPaidBy: a.responsiblePayerUserId === forUserId,
        relationship: a.guardianLinks[0]?.relationship ?? null,
      })),
    });
  }

  if (q.length < 2) return NextResponse.json({ results: [] });
  const users = await prisma.user.findMany({
    where: {
      clubId, deletedAt: null,
      // Every word must match a name or the email: "jason reynolds" finds him.
      AND: q.split(/\s+/).filter(Boolean).slice(0, 4).map((t) => ({
        OR: [
          { firstName: { contains: t, mode: "insensitive" as const } },
          { lastName: { contains: t, mode: "insensitive" as const } },
          { email: { contains: t, mode: "insensitive" as const } },
        ],
      })),
    },
    select: { id: true, firstName: true, lastName: true, email: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    take: 10,
  });
  return NextResponse.json({
    results: users.map((u) => ({ id: u.id, name: `${u.firstName} ${u.lastName}`.trim(), email: u.email })),
  });
}
