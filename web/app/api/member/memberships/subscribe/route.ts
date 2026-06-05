import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe, calculatePlatformFee, billingPeriodToStripeInterval } from "@/lib/stripe";
import { processingFeeLineItem, recurringUnitWithFee } from "@/lib/fees";
import { getAppBaseUrl } from "@/lib/baseUrl";
import { applyParentalControls } from "@/lib/parentalControls";

const schema = z.object({
  membershipId: z.string(),
  optionLabel:  z.string(),
});

type Option = { label: string; price: number; billingPeriod: string };

function computeEndDate(start: Date, billingPeriod: string): Date {
  const d = new Date(start);
  switch (billingPeriod) {
    case "WEEKLY":      d.setDate(d.getDate() + 7);   break;
    case "MONTHLY":     d.setMonth(d.getMonth() + 1); break;
    case "QUARTERLY":   d.setMonth(d.getMonth() + 3); break;
    case "SEMI_ANNUAL": d.setMonth(d.getMonth() + 6); break;
    case "ANNUAL":      d.setFullYear(d.getFullYear() + 1); break;
    default:            d.setFullYear(d.getFullYear() + 1); break;
  }
  return d;
}

// POST /api/member/memberships/subscribe
// Member-driven subscribe. Always Stripe Checkout (no MANUAL path here).
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { membershipId, optionLabel } = schema.parse(await req.json());

    const club = await prisma.club.findUnique({ where: { id: session.user.clubId } });
    if (!club) return NextResponse.json({ error: "Club not found" }, { status: 404 });
    if (!club.stripeAccountId || !club.stripeChargesEnabled) {
      return NextResponse.json({ error: "Your club hasn't enabled online payments yet." }, { status: 400 });
    }

    const member = await prisma.member.findFirst({
      where: { userId: session.user.id, clubId: club.id, deletedAt: null },
    });
    if (!member) {
      return NextResponse.json(
        { error: "Your account isn't linked to a member profile yet. Contact your club." },
        { status: 400 },
      );
    }

    const membership = await prisma.membership.findFirst({
      where: { id: membershipId, clubId: club.id, deletedAt: null, active: true, purchaseAccess: "ANYONE" },
    });
    if (!membership) return NextResponse.json({ error: "Membership not available" }, { status: 404 });

    let options: Option[] = [];
    try { options = JSON.parse(String(membership.options)); } catch {}
    const option = options.find((o) => o.label === optionLabel);
    if (!option) return NextResponse.json({ error: "Option not found" }, { status: 404 });

    const billingType: "RECURRING" | "ONE_TIME" =
      option.billingPeriod === "ONE_TIME" ? "ONE_TIME" : "RECURRING";
    const startDate = new Date();
    const endDate: Date | null = billingType === "ONE_TIME" ? computeEndDate(startDate, option.billingPeriod) : null;

    // P4 parental gate. Memberships are an ongoing commitment, not a
    // one-off charge — even more important than class booking that a
    // controlled minor can't subscribe themselves without guardian
    // approval. Run BEFORE we create the pending MemberSubscription
    // row so a queued/declined request doesn't leave a stale row.
    const gate = await applyParentalControls({
      member: {
        id: member.id,
        clubId: club.id,
        userId: member.userId,
        isMinor: member.isMinor,
        parentControls: member.parentControls,
      },
      bookerUserId: session.user.id,
      kind: "MEMBERSHIP_SUBSCRIBE",
      amount: option.price,
      payload: { membershipId, optionLabel },
    });
    if (gate.kind === "block") {
      return NextResponse.json(gate.body, { status: gate.status });
    }
    if (gate.kind === "queue") {
      return NextResponse.json(gate.response, { status: 202 });
    }

    const memberSub = await prisma.memberSubscription.create({
      data: {
        memberId: member.id,
        membershipId,
        optionLabel,
        price: option.price,
        billingPeriod: option.billingPeriod,
        billingType,
        startDate,
        endDate,
        autoRenew: membership.autoRenewDefault,
        status: "pending",
      },
    });

    const amountInCents = Math.round(option.price * 100);
    const platformFee = calculatePlatformFee(amountInCents, club.tier);
    const stripeInterval = billingPeriodToStripeInterval(option.billingPeriod);
    const isRecurring = billingType === "RECURRING" && stripeInterval !== null;

    const baseUrl = getAppBaseUrl();
    const checkoutMode: "subscription" | "payment" = isRecurring ? "subscription" : "payment";
    const passFees = club.passProcessingFees;

    // Subscription line items can't carry a one-time add-on, so fold the
    // optional processing fee into the recurring amount. One-time payments get
    // a separate, clearly labeled "Processing fee" line.
    const recurringAmount =
      checkoutMode === "subscription" ? recurringUnitWithFee(amountInCents, passFees) : amountInCents;
    const lineItem: Record<string, unknown> = {
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: recurringAmount,
        product_data: {
          name: `${membership.name} — ${option.label}`,
          ...((() => {
            const d =
              (membership.description ?? "") +
              (checkoutMode === "subscription" && passFees ? " (includes processing fee)" : "");
            return d.trim() ? { description: d.trim() } : {};
          })()),
        },
        ...(isRecurring ? { recurring: stripeInterval } : {}),
      },
    };
    const feeItem =
      checkoutMode === "payment" ? processingFeeLineItem(amountInCents, passFees) : null;

    const appFeePercent = 0;

    // Honor trial rules — same logic as owner-side subscribe
    let trialPeriodDays: number | null = null;
    if (membership.trialEnabled && (membership.trialDays ?? 0) > 0 && isRecurring) {
      const priorActive = await prisma.memberSubscription.findFirst({
        where: { memberId: member.id, membershipId, status: { in: ["active", "past_due", "canceled", "expired"] } },
        select: { id: true },
      });
      if (!priorActive || membership.trialAppliesToReturning) {
        trialPeriodDays = membership.trialDays!;
      }
    }

    const checkoutSession = await stripe.checkout.sessions.create(
      {
        mode: checkoutMode,
        line_items: feeItem ? [lineItem, feeItem] : [lineItem],
        success_url: `${baseUrl}/member/memberships?subscribed=true`,
        cancel_url:  `${baseUrl}/member/memberships?canceled=true`,
        metadata: {
          memberSubscriptionId: memberSub.id,
          memberId: member.id,
          clubId: club.id,
        },
        ...(checkoutMode === "subscription"
          ? {
              subscription_data: {
                application_fee_percent: appFeePercent,
                metadata: { memberSubscriptionId: memberSub.id, memberId: member.id, clubId: club.id },
                ...(!membership.autoRenewDefault ? { cancel_at_period_end: true } : {}),
                ...(trialPeriodDays ? { trial_period_days: trialPeriodDays } : {}),
              },
            }
          : {
              payment_intent_data: {
                application_fee_amount: platformFee,
                metadata: { memberSubscriptionId: memberSub.id, memberId: member.id, clubId: club.id },
              },
            }),
      },
      { stripeAccount: club.stripeAccountId }
    );

    await prisma.memberSubscription.update({
      where: { id: memberSub.id },
      data: { stripeCheckoutSessionId: checkoutSession.id },
    });

    return NextResponse.json({ url: checkoutSession.url });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
