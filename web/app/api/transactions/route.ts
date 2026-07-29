import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import type { Prisma } from "@prisma/client";
import { OFFLINE_PAYMENT_SOURCES } from "@/lib/offlineTransactions";

// GET /api/transactions?entity=&from=&to=&bank=&paymentSource=stripe|offline|CASH|CHECK|…
//
// `paymentSource` accepts a single canonical PAYMENT_SOURCE value (STRIPE,
// CASH, CHECK, EXTERNAL_READER, COMP, MANUAL_ADJUSTMENT), or one of two
// aliases:
//   - "stripe"  → Stripe-source rows ONLY (Cash tab never leaks into Stripe)
//   - "offline" → every non-Stripe source (the Cash & Offline tab)
// Missing/empty = every row (legacy behavior).
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "view");
  if (denied) return denied;

  const { searchParams } = new URL(req.url);
  const entity = searchParams.get("entity");
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const bank = searchParams.get("bank");
  const paymentSource = searchParams.get("paymentSource");
  const limitParam = Number(searchParams.get("limit") || "");
  const takeRaw = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 1000) : 250;

  const sourceFilter: Prisma.TransactionWhereInput = (() => {
    if (!paymentSource) return {};
    if (paymentSource === "stripe") return { paymentSource: "STRIPE" };
    if (paymentSource === "offline") {
      return { paymentSource: { in: OFFLINE_PAYMENT_SOURCES } };
    }
    // Single canonical value.
    return { paymentSource };
  })();

  const where: Prisma.TransactionWhereInput = {
    clubId: session.user.clubId,
    ...(entity && entity !== "all" ? { legalEntityId: entity } : {}),
    ...(bank && bank !== "all" ? { plaidConnectionId: bank } : {}),
    ...(from || to
      ? { createdAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } }
      : {}),
    ...sourceFilter,
  };

  const transactions = await prisma.transaction.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      member: { select: { id: true, firstName: true, lastName: true } },
      legalEntity: { select: { id: true, name: true } },
    },
    take: takeRaw,
  });

  // Enrich with recordedBy + athlete names in one round-trip each.
  const recordedByIds = Array.from(
    new Set(transactions.map((t) => t.recordedByUserId).filter((v): v is string => !!v)),
  );
  const athleteIds = Array.from(
    new Set(transactions.map((t) => t.athleteMemberId).filter((v): v is string => !!v)),
  );
  const [recordedByUsers, athletes] = await Promise.all([
    recordedByIds.length
      ? prisma.user.findMany({
          where: { id: { in: recordedByIds } },
          select: { id: true, firstName: true, lastName: true, email: true },
        })
      : Promise.resolve([]),
    athleteIds.length
      ? prisma.member.findMany({
          where: { id: { in: athleteIds }, clubId: session.user.clubId },
          select: { id: true, firstName: true, lastName: true },
        })
      : Promise.resolve([]),
  ]);
  const recordedByById = new Map(recordedByUsers.map((u) => [u.id, u]));
  const athleteById = new Map(athletes.map((a) => [a.id, a]));

  const rows = transactions.map((t) => {
    const rb = t.recordedByUserId ? recordedByById.get(t.recordedByUserId) : null;
    const ath = t.athleteMemberId ? athleteById.get(t.athleteMemberId) : null;
    return {
      ...t,
      recordedBy: rb
        ? {
            id: rb.id,
            name: `${rb.firstName ?? ""} ${rb.lastName ?? ""}`.trim() || rb.email,
          }
        : null,
      athlete: ath ? { id: ath.id, firstName: ath.firstName, lastName: ath.lastName } : null,
    };
  });

  // Voided rows stay visible in the list (history) but never count in totals.
  const succeeded = transactions.filter(
    (t) => t.status === "SUCCEEDED" && t.reconciliationStatus !== "VOID",
  );
  const totalRevenue = succeeded.reduce((s, t) => s + Number(t.amount), 0);
  // Exact Stripe processing fees (from balance transactions) — platformFee is
  // the AthletixOS application fee and is reported separately.
  const totalStripeFees = succeeded.reduce((s, t) => s + Number(t.stripeFeeAmount || 0), 0);
  const totalPlatformFees = succeeded.reduce((s, t) => s + Number(t.platformFee || 0), 0);
  const totalRefunded = succeeded.reduce((s, t) => s + Number(t.refundedAmount || 0), 0);

  return NextResponse.json({
    transactions: rows,
    totals: {
      revenue: totalRevenue,
      stripeFees: totalStripeFees,
      platformFees: totalPlatformFees,
      refunded: totalRefunded,
      net: totalRevenue - totalStripeFees - totalPlatformFees - totalRefunded,
    },
  });
}
