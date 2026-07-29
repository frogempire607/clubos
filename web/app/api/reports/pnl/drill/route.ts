import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { getTierFeatures, tierBlockedBody, upgradeRequired } from "@/lib/tier";
import { resolveReportsRange, type RangeKey } from "@/lib/reportsRange";
import { fetchDrill } from "@/lib/reportsPnl";

// GET /api/reports/pnl/drill?line=…&column=…&period=…&range=…
//
// Returns the transaction list backing a single P&L cell. `column` is the
// column key from the P&L payload (e.g. "2026-07" for monthly, or a Monday
// ISO date for weekly). When omitted, drills the whole range window.
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
  const line = url.searchParams.get("line");
  if (!line) return NextResponse.json({ error: "line required" }, { status: 400 });
  const columnKey = url.searchParams.get("column");
  const period = url.searchParams.get("period") ?? "monthly";

  // Resolve the drill window. If `column` is provided we scope to that column;
  // otherwise we use the range's start/end.
  let windowStart: Date;
  let windowEnd: Date;
  if (columnKey) {
    if (period === "weekly") {
      windowStart = new Date(columnKey);
      windowStart.setUTCHours(0, 0, 0, 0);
      windowEnd = new Date(windowStart);
      windowEnd.setUTCDate(windowEnd.getUTCDate() + 7);
    } else {
      const [y, m] = columnKey.split("-").map(Number);
      windowStart = new Date(Date.UTC(y, m - 1, 1));
      windowEnd = new Date(Date.UTC(y, m, 1));
    }
  } else {
    const range = resolveReportsRange({
      key: (url.searchParams.get("range") || "month") as RangeKey,
      from: url.searchParams.get("from"),
      to: url.searchParams.get("to"),
      timezone: club?.timezone ?? null,
      wentLiveAt: club?.wentLiveAt ?? null,
      clubCreatedAt: club?.createdAt ?? new Date(),
    });
    windowStart = range.start ?? new Date(0);
    windowEnd = range.end;
  }

  const drill = await fetchDrill(clubId, line, windowStart, windowEnd);
  return NextResponse.json({
    ...drill,
    window: { start: windowStart.toISOString(), end: windowEnd.toISOString() },
    columnKey,
    period,
  });
}
