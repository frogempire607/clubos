import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { getTierFeatures, tierBlockedBody, upgradeRequired } from "@/lib/tier";
import { resolveReportsRange, serializeRange, type RangeKey } from "@/lib/reportsRange";
import { buildSnapshot } from "@/lib/reportsSnapshot";
import { computeReliability } from "@/lib/reportsReliability";

// GET /api/reports/snapshot?range=&from=&to=
//
// Owner-first Snapshot. Answers the five owner questions:
//   1. Did I make money?
//   2. Who owes me money?
//   3. Which memberships are growing?
//   4. Which coaches/classes are driving revenue?
//   5. What requires my attention today?  (via /api/reports/action-items)
//
// SaaS metrics (MRR/ARR/ARPA/ARPM/CAC/LTV) are NOT here — they live on
// /api/reports/revenue and /api/reports/unit-economics.
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
  const rangeInput: RangeKey = (url.searchParams.get("range") || "month") as RangeKey;
  const range = resolveReportsRange({
    key: rangeInput,
    from: url.searchParams.get("from"),
    to: url.searchParams.get("to"),
    timezone: club?.timezone ?? null,
    wentLiveAt: club?.wentLiveAt ?? null,
    clubCreatedAt: club?.createdAt ?? new Date(),
  });

  const [snapshot, reliability] = await Promise.all([
    buildSnapshot(clubId, range),
    computeReliability(clubId),
  ]);

  return NextResponse.json({
    range: serializeRange(range),
    reliability: reliability.sections,
    reliabilityAttentionCount: reliability.attentionCount,
    ...snapshot,
  });
}
