import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { recomputeMemberStatus } from "@/lib/memberStatus";

// DELETE /api/members/subscriptions/[subId]
// Owner/staff cancels a subscription. If there's a Stripe subscription
// attached, we cancel it on Stripe too (so renewals stop). Then we mark the
// row canceled and recompute member status so they flip back to INACTIVE
// automatically when this was their only active sub.
export async function DELETE(_req: Request, context: { params: Promise<{ subId: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sub = await prisma.memberSubscription.findFirst({
    where: { id: params.subId, member: { clubId: session.user.clubId } },
    include: { member: { select: { id: true, clubId: true } } },
  });
  if (!sub) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Cancel on Stripe first if applicable. We surface but don't fail the local
  // cancel if Stripe rejects (e.g. already canceled).
  if (sub.stripeSubscriptionId) {
    const club = await prisma.club.findUnique({
      where: { id: sub.member.clubId },
      select: { stripeAccountId: true },
    });
    if (club?.stripeAccountId) {
      try {
        await stripe.subscriptions.cancel(sub.stripeSubscriptionId, undefined, {
          stripeAccount: club.stripeAccountId,
        });
      } catch (err) {
        console.error("Stripe cancel failed (continuing with local cancel):", err);
      }
    }
  }

  await prisma.memberSubscription.update({
    where: { id: sub.id },
    data: { status: "canceled", canceledAt: new Date() },
  });
  await recomputeMemberStatus(sub.member.id);

  return NextResponse.json({ ok: true });
}
