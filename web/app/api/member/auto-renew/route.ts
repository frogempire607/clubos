import { feePolicyFor } from "@/lib/fees";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { cardSnapshotLookup } from "@/lib/memberCard";
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
    prisma.club.findUnique({ where: { id: clubId }, select: { stripeAccountId: true, passProcessingFees: true, passPlatformFee: true, tier: true } }),
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
  // Card labels and last payments for everyone at once: one Stripe read per
  // distinct customer (siblings usually share one) and one ledger query for
  // the whole family — this used to be 2–3 Stripe calls plus a query per
  // athlete, one athlete after another.
  const cardOf = cardSnapshotLookup(club?.stripeAccountId);
  const shown = people
    .map((person) => ({ person, m: members.find((x) => x.id === person.memberId) }))
    .filter((x): x is { person: (typeof people)[number]; m: (typeof members)[number] } => !!x.m && x.m.subscriptions.length > 0);
  const [cards, lastTxRows] = await Promise.all([
    Promise.all(shown.map(({ m }) => {
      const hasCardRow = m.subscriptions.some((s) => s.stripeSubscriptionId && s.billingType !== "MANUAL");
      return hasCardRow ? cardOf(m.stripeSetupCustomerId || m.stripeCustomerId || null) : Promise.resolve(null);
    })),
    shown.length
      ? prisma.transaction.findMany({
          where: { memberId: { in: shown.map(({ m }) => m.id) }, type: "MEMBERSHIP", status: "SUCCEEDED", reconciliationStatus: { not: "VOID" } },
          orderBy: { createdAt: "desc" },
          distinct: ["memberId"],
          select: { memberId: true, paymentMethod: true, paymentSource: true },
        })
      : Promise.resolve([]),
  ]);
  for (let i = 0; i < shown.length; i++) {
    const { person, m } = shown[i];
    const card = cards[i];
    const lastTx = lastTxRows.find((t) => t.memberId === m.id) ?? null;
    for (const sub of m.subscriptions) {
      rows.push(
        describeForPortal({
          sub,
          person,
          passProcessingFees: club ? feePolicyFor(club) : false,
          card,
          lastPaidMethod: lastTx?.paymentSource ?? lastTx?.paymentMethod ?? null,
          now,
        }),
      );
    }
  }
  return NextResponse.json({ rows });
}
