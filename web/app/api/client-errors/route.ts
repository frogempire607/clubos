import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/apiGuard";
import { groupErrors } from "@/lib/clientErrors";

// GET /api/client-errors — the club's screen crashes from the last 14 days,
// grouped, for Settings → Diagnostics. Owner only, and only this club's rows
// (a crash by someone signed out belongs to no club and is not listed here).
export const dynamic = "force-dynamic";

const DAYS = 14;

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requireOwner(session);
  if (denied) return denied;

  const since = new Date(Date.now() - DAYS * 86_400_000);
  try {
    const rows = await prisma.clientError.findMany({
      where: { clubId: session.user.clubId, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 500,
      select: { fingerprint: true, source: true, path: true, message: true, stack: true, userId: true, createdAt: true },
    });
    return NextResponse.json({ ready: true, days: DAYS, total: rows.length, capped: rows.length === 500, groups: groupErrors(rows).slice(0, 50) });
  } catch {
    // The table is added by a migration applied separately.
    return NextResponse.json({ ready: false, days: DAYS, total: 0, capped: false, groups: [] });
  }
}
