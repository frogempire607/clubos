import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { getTierFeatures, tierBlockedBody, upgradeRequired } from "@/lib/tier";
import { resolveReportsRange, serializeRange, type RangeKey } from "@/lib/reportsRange";
import { buildMembership, type GroupBy } from "@/lib/reportsMembership";

// GET /api/reports/membership?range=&groupBy=type|program|location|age|coach
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = requirePermission(session, "reports", "view");
  if (denied) return denied;

  const clubId = session.user.clubId;
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { tier: true, timezone: true, wentLiveAt: true, createdAt: true },
  });
  const features = getTierFeatures(club?.tier ?? "growth");
  if (!features.reports) {
    return NextResponse.json(
      tierBlockedBody({
        message: "Reports & analytics aren't available on your current plan.",
        upgradeRequired: upgradeRequired(club?.tier ?? "growth", "reports"),
      }),
      { status: 403 },
    );
  }

  const url = new URL(req.url);
  const range = resolveReportsRange({
    key: (url.searchParams.get("range") || "month") as RangeKey,
    from: url.searchParams.get("from"),
    to: url.searchParams.get("to"),
    timezone: club?.timezone ?? null,
    wentLiveAt: club?.wentLiveAt ?? null,
    clubCreatedAt: club?.createdAt ?? new Date(),
  });

  const groupBy = (url.searchParams.get("groupBy") ?? "type") as GroupBy;
  // groupBy=coach returns 403 without reports.by_coach (Phase 2.5.11). For now
  // fall through to type since sub-scope perms aren't implemented yet.

  const payload = await buildMembership(clubId, range, groupBy);
  return NextResponse.json({ ...payload, range: serializeRange(range) });
}
