import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveCardSnapshot } from "@/lib/memberCard";
import {
  payablePeopleFor,
  describeForPortal,
  AUTO_RENEW_SUB_SELECT,
  type AutoRenewRow,
} from "@/lib/memberAutoRenewAccess";

// GET /api/member/auto-renew
//
// Every live membership the signed-in adult can PAY for — their own, and each
// athlete they hold a confirmed can-pay guardian link to — with the auto-renew
// consequence spelled out in dates and the "How you pay" line. Read only; the
// toggle itself is POST /api/member/subscriptions/[id]/auto-renew.
//
// Card lookups hit the club's connected Stripe account (read only, degrade to
// null), so this is its own endpoint rather than part of the portal payload.

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "MEMBER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const clubId = session.user.clubId;
  const people = await payablePeopleFor(session.user.id, clubId);
  if (people.length === 0) return NextResponse.json({ rows: [] });

  const [club, members] = await Promise.all([
    prisma.club.findUnique({ where: { id: clubId }, select: { stripeAccountId: true, passProcessingFees: true } }),
    prisma.member.findMany({
      where: { id: { in: people.map((p) => p.memberId) }, clubId, deletedAt: null },
      select: {
        id: true, stripeCustomerId: true, stripeSetupCustomerId: true,
        subscriptions: {
          where: { status: { in: ["active", "past_due", "pending"] } },
          select: AUTO_RENEW_SUB_SELECT,
          orderBy: { createdAt: "desc" },
        },
      },
    }),
  ]);

  const now = new Date();
  const rows: AutoRenewRow[] = [];
  for (const person of people) {
    const m = members.find((x) => x.id === person.memberId);
    if (!m || m.subscriptions.length === 0) continue;
    const hasCardRow = m.subscriptions.some((s) => s.stripeSubscriptionId && s.billingType !== "MANUAL");
    const customerId = m.stripeSetupCustomerId || m.stripeCustomerId || null;
    const card = hasCardRow && customerId && club?.stripeAccountId
      ? await resolveCardSnapshot(customerId, club.stripeAccountId)
      : null;
    const lastTx = await prisma.transaction.findFirst({
      where: { memberId: m.id, type: "MEMBERSHIP", status: "SUCCEEDED", reconciliationStatus: { not: "VOID" } },
      orderBy: { createdAt: "desc" },
      select: { paymentMethod: true, paymentSource: true },
    });
    for (const sub of m.subscriptions) {
      rows.push(
        describeForPortal({
          sub,
          person,
          passProcessingFees: !!club?.passProcessingFees,
          card,
          lastPaidMethod: lastTx?.paymentSource ?? lastTx?.paymentMethod ?? null,
          now,
        }),
      );
    }
  }
  return NextResponse.json({ rows });
}
