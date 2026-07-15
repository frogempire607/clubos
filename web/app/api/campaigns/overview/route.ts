import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermission } from "@/lib/apiGuard";
import { buildCampaignOverview, resolveCampaignRange } from "@/lib/campaignAnalytics";
import { prisma } from "@/lib/prisma";
import { EXCLUDE_VOID } from "@/lib/paymentSources";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const denied = requirePermission(session, "messages", "view");
  if (denied) return denied;

  const clubId = session.user.clubId;
  const url = new URL(req.url);
  const range = resolveCampaignRange(url.searchParams.get("range"));

  const [
    members,
    currentTransactions,
    previousTransactions,
    historicalTransactions,
    campaigns,
  ] = await Promise.all([
    prisma.member.findMany({
      where: { clubId, deletedAt: null },
      select: {
        id: true,
        status: true,
        joinedAt: true,
        leadSource: true,
        leadStage: true,
      },
    }),
    prisma.transaction.findMany({
      where: {
        clubId,
        status: "SUCCEEDED",
        ...EXCLUDE_VOID,
        createdAt: { gte: range.start, lt: range.end },
      },
      select: { id: true, memberId: true, amount: true, type: true, category: true, createdAt: true },
    }),
    prisma.transaction.findMany({
      where: {
        clubId,
        status: "SUCCEEDED",
        ...EXCLUDE_VOID,
        createdAt: { gte: range.prevStart, lt: range.prevEnd },
      },
      select: { id: true, memberId: true, amount: true, type: true, category: true, createdAt: true },
    }),
    prisma.transaction.findMany({
      where: {
        clubId,
        status: "SUCCEEDED",
        ...EXCLUDE_VOID,
        createdAt: { lt: range.start },
      },
      select: { id: true, memberId: true, amount: true, type: true, category: true, createdAt: true },
    }),
    prisma.campaign.findMany({
      where: {
        clubId,
        deletedAt: null,
        OR: [
          { status: { in: ["ACTIVE", "SCHEDULED"] } },
          { startAt: { gte: range.start, lt: range.end } },
          { endAt: { gte: range.start, lt: range.end } },
        ],
      },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: 8,
      select: {
        id: true,
        name: true,
        type: true,
        status: true,
        startAt: true,
        endAt: true,
        attributions: {
          where: {
            OR: [
              { firstTouchAt: { gte: range.start, lt: range.end } },
              { lastTouchAt: { gte: range.start, lt: range.end } },
              { transaction: { createdAt: { gte: range.start, lt: range.end } } },
            ],
          },
          select: {
            memberId: true,
            revenueAmount: true,
            transaction: { select: { amount: true } },
          },
        },
      },
    }),
  ]);

  return NextResponse.json(
    buildCampaignOverview({
      range,
      members,
      currentTransactions,
      previousTransactions,
      historicalTransactions,
      campaigns,
    }),
  );
}
