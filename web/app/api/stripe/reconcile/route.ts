import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { reconcileClubBilling } from "@/lib/stripeSync";

// Reconcile can page through every subscription on the connected account.
export const maxDuration = 60;

// GET /api/stripe/reconcile
// Owner/staff (finances:view) — list Stripe subscriptions that couldn't be
// confidently matched to a member and need owner review, with the best-guess
// member for each. Never mutates anything.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "view");
  if (denied) return denied;

  const clubId = session.user.clubId;
  const rows = await prisma.stripeReconciliation.findMany({
    where: { clubId, status: "OPEN" },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  const suggestedIds = Array.from(new Set(rows.map((r) => r.suggestedMemberId).filter(Boolean) as string[]));
  const members = suggestedIds.length
    ? await prisma.member.findMany({
        where: { id: { in: suggestedIds }, clubId },
        select: { id: true, firstName: true, lastName: true, email: true },
      })
    : [];
  const byId = new Map(members.map((m) => [m.id, m]));

  return NextResponse.json({
    openCount: rows.length,
    items: rows.map((r) => ({
      id: r.id,
      stripeSubscriptionId: r.stripeSubscriptionId,
      customerEmail: r.customerEmail,
      customerName: r.customerName,
      stripeStatus: r.stripeStatus,
      amountCents: r.amountCents,
      interval: r.interval,
      currentPeriodEnd: r.currentPeriodEnd,
      matchConfidence: r.matchConfidence,
      suggestedMember: r.suggestedMemberId ? byId.get(r.suggestedMemberId) ?? null : null,
    })),
  });
}

// POST /api/stripe/reconcile
// Owner/staff (finances:edit) — pull the club's connected-account subscriptions,
// refresh snapshots on matched members, and queue unmatched ones for review.
// Safe: never cancels/recreates/reschedules a live subscription.
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "edit");
  if (denied) return denied;

  const summary = await reconcileClubBilling(session.user.clubId);
  if (!summary.ok) {
    return NextResponse.json({ error: summary.error || "Reconcile failed" }, { status: 400 });
  }
  return NextResponse.json(summary);
}
