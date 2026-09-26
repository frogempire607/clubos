import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";

// GET /api/front-desk/people?q=  — the walk-in search. Name, email, phone or
// guardian (a parent at the desk says their own name). READ-ONLY.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "attendance", "edit");
  if (denied) return denied;

  const q = (new URL(req.url).searchParams.get("q") || "").trim();
  if (q.length < 2) return NextResponse.json({ people: [] });
  const like = { contains: q, mode: "insensitive" as const };
  const parts = q.split(/\s+/).filter(Boolean);
  const people = await prisma.member.findMany({
    where: {
      clubId: session.user.clubId,
      deletedAt: null,
      OR: [
        { firstName: like }, { lastName: like }, { email: like }, { phone: like },
        { guardianName: like }, { guardianEmail: like },
        ...(parts.length >= 2 ? [{ AND: [{ firstName: { contains: parts[0], mode: "insensitive" as const } }, { lastName: { contains: parts.slice(1).join(" "), mode: "insensitive" as const } }] }] : []),
      ],
    },
    select: {
      id: true, firstName: true, lastName: true, isMinor: true, dateOfBirth: true, status: true, guardianName: true,
      subscriptions: { where: { status: "active" }, select: { membership: { select: { name: true } } }, take: 2 },
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    take: 12,
  });
  return NextResponse.json({
    people: people.map((p) => ({
      id: p.id,
      name: `${p.firstName} ${p.lastName}`.trim(),
      firstName: p.firstName,
      isMinor: p.isMinor,
      guardianName: p.guardianName,
      status: p.status,
      plans: p.subscriptions.map((s) => s.membership?.name).filter(Boolean),
    })),
  });
}
