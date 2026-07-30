import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { getTierFeatures, tierBlockedBody, upgradeRequired } from "@/lib/tier";
import { resolveReportsRange, serializeRange, type RangeKey } from "@/lib/reportsRange";
import { buildPnl, type PnlBasis, type PnlPeriod } from "@/lib/reportsPnl";
import { hasReportScope } from "@/lib/reportsPermissions";

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

  // Granular scopes: strip payroll + owner-equity lines when the caller
  // lacks those sub-scopes. Also null the section totals that would leak
  // the redacted line via subtraction. Reports the redaction in
  // `restricted[]` so the client can render an explanatory chip.
  const canPayroll = hasReportScope(session, "payroll");
  const canOwnerEquity = hasReportScope(session, "owner_equity");
  const canFinancials = hasReportScope(session, "financials");
  if (!canFinancials) {
    return NextResponse.json({ error: "You don't have permission to view P&L." }, { status: 403 });
  }

  const pnl = await buildPnl(clubId, range, period, basis);
  const restricted: string[] = [];
  if (!canPayroll) {
    for (const section of pnl.sections) {
      for (const line of section.lines) {
        if (line.key.toLowerCase().includes("payroll")) {
          line.values = line.values.map(() => 0);
          line.label = `${line.label} (restricted)`;
        }
      }
      // Null the section total to prevent leak-by-subtraction.
      section.total.values = section.total.values.map(() => 0);
    }
    // Null the summary numbers too — they would let a coach subtract to
    // find payroll.
    pnl.summary = pnl.summary.map(() => ({
      grossIncome: 0,
      netOperatingIncome: 0,
      grossProfit: 0,
      grossMarginPercent: null,
      totalOperatingExpenses: 0,
      operatingProfit: 0,
      netProfit: 0,
      profitMarginPercent: null,
    }));
    restricted.push("payroll");
  }
  if (!canOwnerEquity) restricted.push("owner_equity");
  return NextResponse.json({ ...pnl, range: serializeRange(range), restricted });
}
