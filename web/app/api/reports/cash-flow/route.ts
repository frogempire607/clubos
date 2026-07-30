import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { getTierFeatures, tierBlockedBody, upgradeRequired } from "@/lib/tier";
import { resolveReportsRange, serializeRange, type RangeKey } from "@/lib/reportsRange";
import { buildCashFlow } from "@/lib/reportsCashFlow";
import { hasReportScope } from "@/lib/reportsPermissions";

// GET /api/reports/cash-flow?range=&from=&to=
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

  if (!hasReportScope(session, "financials")) {
    return NextResponse.json({ error: "You don't have permission to view cash flow." }, { status: 403 });
  }
  const canBank = hasReportScope(session, "bank_balances");
  const canOwnerEquity = hasReportScope(session, "owner_equity");

  const payload = await buildCashFlow(clubId, range);
  const restricted: string[] = [];
  if (!canBank) {
    payload.beginningCash = null;
    payload.endingCash = null;
    restricted.push("bank_balances");
  }
  if (!canOwnerEquity) {
    payload.financing = payload.financing.filter(
      (f) => f.kind !== "OWNER_CONTRIBUTION" && f.kind !== "OWNER_DISTRIBUTION",
    );
    restricted.push("owner_equity");
  }
  return NextResponse.json({ ...payload, range: serializeRange(range), restricted });
}
