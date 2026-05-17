import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getTierFeatures, getTierName, tierBlockedBody, upgradeRequired } from "@/lib/tier";
import { requirePermission } from "@/lib/apiGuard";

type Range = "month" | "last_month" | "last_30" | "last_90" | "ytd" | "year" | "all";

function resolveRange(range: Range): { start: Date | null; end: Date; prevStart: Date | null; prevEnd: Date | null; label: string } {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (range === "month") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return { start, end, prevStart, prevEnd: start, label: "This month" };
  }
  if (range === "last_month") {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevStart = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    return { start, end, prevStart, prevEnd: start, label: "Last month" };
  }
  if (range === "last_30") {
    const start = new Date(today.getTime() - 30 * 86400000);
    const prevStart = new Date(today.getTime() - 60 * 86400000);
    return { start, end: now, prevStart, prevEnd: start, label: "Last 30 days" };
  }
  if (range === "last_90") {
    const start = new Date(today.getTime() - 90 * 86400000);
    const prevStart = new Date(today.getTime() - 180 * 86400000);
    return { start, end: now, prevStart, prevEnd: start, label: "Last 90 days" };
  }
  if (range === "ytd") {
    const start = new Date(now.getFullYear(), 0, 1);
    const prevStart = new Date(now.getFullYear() - 1, 0, 1);
    return { start, end: now, prevStart, prevEnd: start, label: "Year to date" };
  }
  if (range === "year") {
    const start = new Date(now.getTime() - 365 * 86400000);
    const prevStart = new Date(now.getTime() - 730 * 86400000);
    return { start, end: now, prevStart, prevEnd: start, label: "Last 12 months" };
  }
  return { start: null, end: now, prevStart: null, prevEnd: null, label: "All time" };
}

// GET /api/reports/overview?range=month
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = requirePermission(session, "reports", "view");
  if (denied) return denied;

  const clubId = session.user.clubId;
  const clubTier = await prisma.club.findUnique({ where: { id: clubId }, select: { tier: true } });
  const features = getTierFeatures(clubTier?.tier ?? "growth");
  if (!features.reports) {
    return NextResponse.json(
      tierBlockedBody({
        message: `Reports & analytics aren't available on the ${getTierName(clubTier?.tier ?? "growth")} plan. Upgrade to unlock.`,
        upgradeRequired: upgradeRequired(clubTier?.tier ?? "growth", "reports"),
      }),
      { status: 403 }
    );
  }

  const url = new URL(req.url);
  const rangeParam = (url.searchParams.get("range") || "month") as Range;
  const range = resolveRange(rangeParam);

  const txWhereBase = { clubId, status: "SUCCEEDED" as const };
  const txWhereRange = range.start
    ? { ...txWhereBase, createdAt: { gte: range.start, lt: range.end } }
    : txWhereBase;
  const txWherePrev = range.prevStart && range.prevEnd
    ? { ...txWhereBase, createdAt: { gte: range.prevStart, lt: range.prevEnd } }
    : null;

  const [
    txCurrent,
    txPrev,
    allMembers,
    newMembers,
    activeSubs,
    pastDueSubs,
    pendingSubs,
    expenses,
    attendanceRecords,
    topEventsRaw,
    revenueMonthlyRaw,
  ] = await Promise.all([
    prisma.transaction.findMany({ where: txWhereRange, select: { amount: true, type: true, platformFee: true, createdAt: true } }),
    txWherePrev ? prisma.transaction.findMany({ where: txWherePrev, select: { amount: true } }) : Promise.resolve([]),
    prisma.member.findMany({
      where: { clubId, deletedAt: null },
      select: { id: true, status: true, isMinor: true, joinedAt: true },
    }),
    range.start
      ? prisma.member.count({ where: { clubId, deletedAt: null, joinedAt: { gte: range.start, lt: range.end } } })
      : prisma.member.count({ where: { clubId, deletedAt: null } }),
    prisma.memberSubscription.count({
      where: { member: { clubId, deletedAt: null }, status: "active" },
    }),
    prisma.memberSubscription.count({
      where: { member: { clubId, deletedAt: null }, status: "past_due" },
    }),
    prisma.memberSubscription.count({
      where: { member: { clubId, deletedAt: null }, status: "pending" },
    }),
    prisma.expense.findMany({
      where: {
        clubId,
        ...(range.start ? { date: { gte: range.start, lt: range.end } } : {}),
      },
      select: { amount: true, category: true },
    }),
    prisma.attendanceRecord.findMany({
      where: {
        clubId,
        ...(range.start ? { createdAt: { gte: range.start, lt: range.end } } : {}),
      },
      select: { status: true, eventId: true, classSessionId: true },
    }),
    // Top events by confirmed bookings in range
    prisma.booking.groupBy({
      by: ["eventId"],
      where: {
        status: { in: ["CONFIRMED", "ATTENDED"] },
        event: {
          clubId,
          ...(range.start ? { startsAt: { gte: range.start, lt: range.end } } : {}),
        },
      },
      _count: { _all: true },
      orderBy: { _count: { eventId: "desc" } },
      take: 5,
    }),
    // Revenue by month for last 12 months (independent of range, for the chart)
    prisma.$queryRaw<Array<{ month: Date; total: number }>>`
      SELECT
        date_trunc('month', "createdAt") as month,
        SUM("amount")::float as total
      FROM "transactions"
      WHERE "clubId" = ${clubId}
        AND "status" = 'SUCCEEDED'
        AND "createdAt" >= NOW() - INTERVAL '12 months'
      GROUP BY date_trunc('month', "createdAt")
      ORDER BY month ASC
    `,
  ]);

  const sumAmounts = (rows: { amount: { toString: () => string } }[]) =>
    rows.reduce((acc, r) => acc + Number(r.amount), 0);

  const revenueCurrent = sumAmounts(txCurrent);
  const revenuePrev = sumAmounts(txPrev);
  const revenueDelta = revenuePrev > 0 ? ((revenueCurrent - revenuePrev) / revenuePrev) * 100 : null;
  const platformFeesCurrent = txCurrent.reduce((acc, r) => acc + Number(r.platformFee ?? 0), 0);

  const revenueByType: Record<string, number> = {};
  for (const t of txCurrent) {
    const key = t.type || "OTHER";
    revenueByType[key] = (revenueByType[key] || 0) + Number(t.amount);
  }

  const memberStatusCounts: Record<string, number> = { ACTIVE: 0, PROSPECT: 0, INACTIVE: 0, PAUSED: 0 };
  let minorCount = 0;
  for (const m of allMembers) {
    memberStatusCounts[m.status] = (memberStatusCounts[m.status] || 0) + 1;
    if (m.isMinor) minorCount++;
  }

  const expensesTotal = expenses.reduce((acc, e) => acc + Number(e.amount), 0);
  const expensesByCategory: Record<string, number> = {};
  for (const e of expenses) {
    expensesByCategory[e.category] = (expensesByCategory[e.category] || 0) + Number(e.amount);
  }

  const attendanceCounts = {
    total: attendanceRecords.length,
    present: attendanceRecords.filter((a) => a.status === "PRESENT").length,
    dropIn: attendanceRecords.filter((a) => a.status === "DROP_IN").length,
    trial: attendanceRecords.filter((a) => a.status === "TRIAL").length,
    absent: attendanceRecords.filter((a) => a.status === "ABSENT").length,
  };

  // Fetch event names for top events
  const topEventIds = topEventsRaw.map((r) => r.eventId);
  const topEventNames = topEventIds.length
    ? await prisma.event.findMany({
        where: { id: { in: topEventIds } },
        select: { id: true, name: true, type: true },
      })
    : [];
  const nameById = new Map(topEventNames.map((e) => [e.id, e]));
  const topEvents = topEventsRaw.map((r) => ({
    id: r.eventId,
    name: nameById.get(r.eventId)?.name || "Unknown event",
    type: nameById.get(r.eventId)?.type || null,
    bookings: r._count._all,
  }));

  const revenueMonthly = revenueMonthlyRaw.map((r) => ({
    month: new Date(r.month).toISOString(),
    total: Number(r.total),
  }));

  return NextResponse.json({
    range: {
      key: rangeParam,
      label: range.label,
      start: range.start?.toISOString() ?? null,
      end: range.end.toISOString(),
    },
    revenue: {
      current: revenueCurrent,
      previous: revenuePrev,
      deltaPercent: revenueDelta,
      byType: revenueByType,
      platformFees: platformFeesCurrent,
    },
    members: {
      total: allMembers.length,
      newInRange: newMembers,
      byStatus: memberStatusCounts,
      minors: minorCount,
    },
    subscriptions: {
      active: activeSubs,
      pastDue: pastDueSubs,
      pending: pendingSubs,
    },
    attendance: attendanceCounts,
    expenses: {
      total: expensesTotal,
      net: revenueCurrent - expensesTotal,
      byCategory: expensesByCategory,
    },
    topEvents,
    revenueMonthly,
  });
}
