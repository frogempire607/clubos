import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { recomputeMemberStatus } from "@/lib/memberStatus";

const patchSchema = z.object({
  startDate: z.string().optional().nullable(),
  endDate: z.string().optional().nullable(),
  status: z.enum(["pending", "active", "past_due", "canceled", "expired"]).optional(),
  notes: z.string().max(500).optional().nullable(),
  // Manual price override (owner/staff can change anyone's membership price
  // directly, not only via a discount code).
  price: z.number().nonnegative().optional(),
});

// PATCH /api/members/subscriptions/[subId]
// Owner/staff edits a subscription's effective start/end dates, status, or
// notes. This adjusts the AthletixOS record only — Stripe's own billing cycle
// is unchanged (use the Stripe portal for that). Recomputes member status.
export async function PATCH(req: Request, context: { params: Promise<{ subId: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sub = await prisma.memberSubscription.findFirst({
    where: { id: params.subId, member: { clubId: session.user.clubId } },
    include: { member: { select: { id: true } } },
  });
  if (!sub) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let data: z.infer<typeof patchSchema>;
  try {
    data = patchSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  if (data.startDate && data.endDate && new Date(data.startDate) > new Date(data.endDate)) {
    return NextResponse.json({ error: "Start date must be before end date." }, { status: 400 });
  }

  await prisma.memberSubscription.update({
    where: { id: sub.id },
    data: {
      ...(data.startDate !== undefined ? { startDate: data.startDate ? new Date(data.startDate) : null } : {}),
      ...(data.endDate !== undefined ? { endDate: data.endDate ? new Date(data.endDate) : null } : {}),
      ...(data.status !== undefined
        ? {
            status: data.status,
            ...(data.status === "canceled" ? { canceledAt: new Date() } : {}),
          }
        : {}),
      ...(data.notes !== undefined ? { notes: data.notes || null } : {}),
      ...(data.price !== undefined ? { price: data.price } : {}),
    },
  });
  await recomputeMemberStatus(sub.member.id);

  // Local price is updated immediately. A live Stripe subscription keeps
  // billing its own amount until changed in Stripe — flag that to the caller.
  const stripeNote =
    data.price !== undefined && sub.stripeSubscriptionId
      ? "Price updated in AthletixOS. This subscription bills through Stripe — update the amount in the Stripe portal so future charges match."
      : null;

  return NextResponse.json({ ok: true, stripeNote });
}

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
