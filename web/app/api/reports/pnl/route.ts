import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { getTierFeatures, tierBlockedBody, upgradeRequired } from "@/lib/tier";
import { resolveReportsRange, serializeRange, type RangeKey } from "@/lib/reportsRange";
import { buildPnl, type PnlBasis, type PnlPeriod } from "@/lib/reportsPnl";

// GET /api/reports/pnl?period=monthly|weekly&basis=cash|accrual&range=…
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
  const period = (url.searchParams.get("period") ?? "monthly") as PnlPeriod;
  const basis = (url.searchParams.get("basis") ?? "cash") as PnlBasis;
  const range = resolveReportsRange({
    key: (url.searchParams.get("range") || "month") as RangeKey,
    from: url.searchParams.get("from"),
    to: url.searchParams.get("to"),
    timezone: club?.timezone ?? null,
    wentLiveAt: club?.wentLiveAt ?? null,
    clubCreatedAt: club?.createdAt ?? new Date(),
  });

  const pnl = await buildPnl(clubId, range, period, basis);
  return NextResponse.json({ ...pnl, range: serializeRange(range) });
}
