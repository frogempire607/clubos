import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe, calculatePlatformFee, billingPeriodToStripeInterval } from "@/lib/stripe";
import { processingFeeLineItem, recurringUnitWithFee } from "@/lib/fees";
import { recomputeMemberStatus } from "@/lib/memberStatus";
import { getAppBaseUrl } from "@/lib/baseUrl";

const schema = z.object({
  memberId:      z.string(),
  membershipId:  z.string(),
  optionLabel:   z.string(),
  // Billing overrides (owner-set)
  billingType:   z.enum(["RECURRING", "ONE_TIME", "MANUAL"]).optional(),
  autoRenew:     z.boolean().optional(),
  billingDay:    z.number().int().min(1).max(28).optional().nullable(),
  startDate:     z.string().optional().nullable(), // ISO date string
  endDate:       z.string().optional().nullable(),
  notes:         z.string().optional().nullable(),
  discountCode:  z.string().optional().nullable(),
});

type Option = { label: string; price: number; billingPeriod: string };

/** Compute endDate from startDate + billingPeriod for one-time purchases */
function computeEndDate(start: Date, billingPeriod: string): Date {
  const d = new Date(start);
  switch (billingPeriod) {
    case "WEEKLY":      d.setDate(d.getDate() + 7);   break;
    case "MONTHLY":     d.setMonth(d.getMonth() + 1); break;
    case "QUARTERLY":   d.setMonth(d.getMonth() + 3); break;
    case "SEMI_ANNUAL": d.setMonth(d.getMonth() + 6); break;
    case "ANNUAL":      d.setFullYear(d.getFullYear() + 1); break;
    default:            d.setFullYear(d.getFullYear() + 1); break; // fallback 1 year
  }
  return d;
}

/** Compute next billing anchor for a given day of month */
function billingAnchorForDay(day: number): Date {
  const now = new Date();
  const anchor = new Date(now.getFullYear(), now.getMonth(), day, 0, 0, 0, 0);
  if (anchor <= now) anchor.setMonth(anchor.getMonth() + 1);
  return anchor;
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  try {
    const body = schema.parse(await req.json());
    const { memberId, membershipId, optionLabel } = body;

    const club = await prisma.club.findUnique({ where: { id: session.user.clubId } });
    if (!club) return NextResponse.json({ error: "Club not found" }, { status: 404 });

    const member = await prisma.member.findFirst({
      where: { id: memberId, clubId: club.id, deletedAt: null },
    });
    if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

    const membership = await prisma.membership.findFirst({
      where: { id: membershipId, clubId: club.id, deletedAt: null },
    });
    if (!membership) return NextResponse.json({ error: "Membership not found" }, { status: 404 });

    let options: Option[] = [];
    try { options = JSON.parse(String(membership.options)); } catch {}
    const option = options.find((o) => o.label === optionLabel);
    if (!option) return NextResponse.json({ error: "Option not found" }, { status: 404 });

    // Resolve billing type: explicit override > ONE_TIME if period is ONE_TIME > plan default
    const resolvedBillingType =
      body.billingType ??
      (option.billingPeriod === "ONE_TIME" ? "ONE_TIME" : "RECURRING");

    const resolvedAutoRenew = body.autoRenew ?? membership.autoRenewDefault;
    const resolvedStartDate = body.startDate ? new Date(body.startDate) : new Date();

    // Compute endDate for one-time purchases if not explicitly provided
    let resolvedEndDate: Date | null = body.endDate ? new Date(body.endDate) : null;
    if (!resolvedEndDate && resolvedBillingType === "ONE_TIME") {
      resolvedEndDate = computeEndDate(resolvedStartDate, option.billingPeriod);
    }

    // Resolve billing anchor
    const billingDay = body.billingDay ?? membership.defaultBillingDay ?? null;
    const billingAnchorDate = billingDay ? billingAnchorForDay(billingDay) : null;

    // ── MANUAL assignment (cash / migration — no Stripe) ─────────────────────
    if (resolvedBillingType === "MANUAL") {
      const memberSub = await prisma.memberSubscription.create({
        data: {
          memberId,
          membershipId,
          optionLabel,
          price: option.price,
          billingPeriod: option.billingPeriod,
          billingType: "MANUAL",
          startDate: resolvedStartDate,
          endDate: resolvedEndDate,
          autoRenew: false,
          billingDay,
          billingAnchorDate,
          status: "active",
          startedAt: new Date(),
          notes: body.notes || null,
          discountCode: body.discountCode || null,
        },
      });
      // Manual assignment is active immediately — flip member status to ACTIVE
      await recomputeMemberStatus(memberId);
      return NextResponse.json({ memberSub, type: "manual" }, { status: 201 });
    }

    // ── Stripe required for RECURRING and ONE_TIME ───────────────────────────
    if (!club.stripeAccountId || !club.stripeChargesEnabled) {
      return NextResponse.json({ error: "Connect Stripe first, or use manual assignment" }, { status: 400 });
    }

    const amountInCents = Math.round(option.price * 100);
    const platformFee = calculatePlatformFee(amountInCents, club.tier);
    const stripeInterval = billingPeriodToStripeInterval(option.billingPeriod);

    // Create the MemberSubscription record first
    const memberSub = await prisma.memberSubscription.create({
      data: {
        memberId,
        membershipId,
        optionLabel,
        price: option.price,
        billingPeriod: option.billingPeriod,
        billingType: resolvedBillingType,
        startDate: resolvedStartDate,
        endDate: resolvedEndDate,
        autoRenew: resolvedAutoRenew,
        billingDay,
        billingAnchorDate,
        status: "pending",
        notes: body.notes || null,
        discountCode: body.discountCode || null,
      },
    });

    const baseUrl = getAppBaseUrl();
    const isRecurring = resolvedBillingType === "RECURRING" && stripeInterval !== null;

    const checkoutMode: "subscription" | "payment" = isRecurring ? "subscription" : "payment";
    const passFees = club.passProcessingFees;
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

    // Trial rules: if the membership has a trial and either the member has no
    // prior active sub on this plan OR the plan allows returning trials, grant
    // the configured trial period before the first charge.
    let trialPeriodDays: number | null = null;
    if (membership.trialEnabled && (membership.trialDays ?? 0) > 0 && isRecurring) {
      const priorActive = await prisma.memberSubscription.findFirst({
        where: { memberId, membershipId, status: { in: ["active", "past_due", "canceled", "expired"] } },
        select: { id: true },
      });
      if (!priorActive || membership.trialAppliesToReturning) {
        trialPeriodDays = membership.trialDays!;
      }
    }

    // Build subscription_data with optional billing anchor. AthletixOS takes
    // no per-transaction platform cut on any plan.
    const appFeePercent = 0;
    const subscriptionData: Record<string, unknown> = {
      application_fee_percent: appFeePercent,
      metadata: { memberSubscriptionId: memberSub.id, memberId, clubId: club.id },
      // auto-cancel at period end if auto-renew is off
      ...(isRecurring && !resolvedAutoRenew ? { cancel_at_period_end: true } : {}),
      ...(trialPeriodDays ? { trial_period_days: trialPeriodDays } : {}),
    };
    if (billingAnchorDate) {
      subscriptionData.billing_cycle_anchor = Math.floor(billingAnchorDate.getTime() / 1000);
      subscriptionData.proration_behavior = "create_prorations";
    }

    const checkoutSession = await stripe.checkout.sessions.create(
      {
        mode: checkoutMode,
        line_items: feeItem ? [lineItem, feeItem] : [lineItem],
        success_url: `${baseUrl}/dashboard/members?subscribed=true`,
        cancel_url:  `${baseUrl}/dashboard/members?canceled=true`,
        metadata: {
          memberSubscriptionId: memberSub.id,
          memberId,
          clubId: club.id,
        },
        ...(checkoutMode === "subscription"
          ? { subscription_data: subscriptionData }
          : {
              payment_intent_data: {
                application_fee_amount: platformFee,
                metadata: { memberSubscriptionId: memberSub.id, memberId, clubId: club.id },
              },
            }),
      },
      { stripeAccount: club.stripeAccountId }
    );

    await prisma.memberSubscription.update({
      where: { id: memberSub.id },
      data: { stripeCheckoutSessionId: checkoutSession.id },
    });

    return NextResponse.json({ url: checkoutSession.url, memberSubId: memberSub.id });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
