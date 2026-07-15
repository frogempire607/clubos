import { NextResponse } from "next/server";
import { guardianActionBlocked, CONSENT_BLOCK_BODY } from "@/lib/parentalConsent";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe, calculatePlatformFee, billingPeriodToStripeInterval } from "@/lib/stripe";
import { ensureMembershipProduct } from "@/lib/stripeCatalog";
import { processingFeeLineItem, recurringUnitWithFee } from "@/lib/fees";
import { getAppBaseUrl } from "@/lib/baseUrl";
import { applyParentalControls } from "@/lib/parentalControls";
import { resolveFamilyContext } from "@/lib/memberContext";
import { MEMBERSHIP_PURCHASE_KIND } from "@/lib/approvals";
import { findValidDiscount, discountedPrice, recordDiscountUse } from "@/lib/discounts";
import { trialForMembership, eligibleForSubscriptionTrial } from "@/lib/freeTrial";

const schema = z.object({
  membershipId: z.string(),
  optionLabel:  z.string(),
  // Which profile this is for — the guardian's own, or one of their children.
  // Omitted = act on the viewer's default profile (self, else first child).
  memberId: z.string().optional(),
  // CARD → Stripe Checkout (default, unchanged). CASH/CHECK → no Stripe:
  // files a MEMBERSHIP_PURCHASE approval the owner activates manually.
  paymentMethod: z.enum(["CARD", "CASH", "CHECK"]).optional().default("CARD"),
  discountCode: z.string().max(50).optional().nullable(),
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
    const { membershipId, optionLabel, memberId, paymentMethod, discountCode } = schema.parse(await req.json());
    const isOffline = paymentMethod === "CASH" || paymentMethod === "CHECK";

    const club = await prisma.club.findUnique({ where: { id: session.user.clubId } });
    if (!club) return NextResponse.json({ error: "Club not found" }, { status: 404 });
    // Cash/check never touches Stripe, so it works even before the club
    // finishes Stripe Connect onboarding.
    if (!isOffline && (!club.stripeAccountId || !club.stripeChargesEnabled)) {
      return NextResponse.json({ error: "Your club hasn't enabled online payments yet." }, { status: 400 });
    }

    // Family-aware: resolve the profile this purchase is for (self OR a child
    // the viewer guardians). A guardian with no membership of their own can buy
    // for a child by passing that child's memberId.
    const sessionUser = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { email: true },
    });
    const resolved = sessionUser
      ? await resolveFamilyContext(session.user.id, club.id, sessionUser.email, memberId)
      : null;
    if (resolved === "FORBIDDEN") {
      return NextResponse.json({ error: "You can't manage that profile." }, { status: 403 });
    }
    const member = resolved?.context ?? null;
    if (!member) {
      return NextResponse.json(
        { error: "Your account isn't linked to a member profile yet. Contact your club." },
        { status: 400 },
      );
    }

    // COPPA: block a guardian from subscribing a minor until consent is on file.
    if (await guardianActionBlocked(session.user.id, member.id)) {
      return NextResponse.json(CONSENT_BLOCK_BODY, { status: 403 });
    }

    const membership = await prisma.membership.findFirst({
      where: { id: membershipId, clubId: club.id, deletedAt: null, active: true, purchaseAccess: "ANYONE" },
    });
    if (!membership) return NextResponse.json({ error: "Membership not available" }, { status: 404 });

    let options: Option[] = [];
    try { options = JSON.parse(String(membership.options)); } catch {}
    const option = options.find((o) => o.label === optionLabel);
    if (!option) return NextResponse.json({ error: "Option not found" }, { status: 404 });

    // Optional discount code — validated against this membership (a code
    // scoped to specific plans rejects others; unscoped codes apply to all).
    let discount = null as import("@/lib/discounts").ValidDiscount | null;
    if (discountCode?.trim()) {
      const check = await findValidDiscount(club.id, discountCode, membershipId);
      if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
      discount = check.discount;
    }
    const finalPrice = discount ? discountedPrice(option.price, discount) : option.price;

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
      bookerIsGuardian: resolved?.bookerIsGuardian ?? false,
      kind: "MEMBERSHIP_SUBSCRIBE",
      amount: finalPrice,
      payload: { membershipId, optionLabel, memberId: member.id, ...(discount ? { discountCode: discount.code } : {}) },
    });
    if (gate.kind === "block") {
      return NextResponse.json(gate.body, { status: gate.status });
    }
    if (gate.kind === "queue") {
      return NextResponse.json(gate.response, { status: 202 });
    }

    // ── Cash/check: no Stripe, no subscription row yet. File an owner
    // approval; activation happens in /api/approvals/membership-purchase so
    // no pending row can go stale if the club declines. ──
    if (isOffline) {
      const dupe = await prisma.pendingApproval.findFirst({
        where: {
          clubId: club.id,
          memberId: member.id,
          kind: MEMBERSHIP_PURCHASE_KIND,
          status: "PENDING",
        },
        select: { id: true },
      });
      if (dupe) {
        return NextResponse.json(
          { queued: true, message: "You already have a membership request waiting for your club's approval." },
          { status: 202 },
        );
      }
      await prisma.pendingApproval.create({
        data: {
          clubId: club.id,
          memberId: member.id,
          kind: MEMBERSHIP_PURCHASE_KIND,
          amount: finalPrice,
          status: "PENDING",
          payload: {
            membershipId,
            optionLabel,
            paymentMethod,
            memberId: member.id,
            requestingUserId: session.user.id,
            ...(discount ? { discountCode: discount.code } : {}),
          },
        },
      });
      return NextResponse.json(
        {
          queued: true,
          message: `Request sent! Your club will confirm your ${paymentMethod.toLowerCase()} payment and activate the membership.`,
        },
        { status: 202 },
      );
    }

    // Card path from here — re-assert the Stripe account for TS narrowing
    // (the earlier check is conditional on !isOffline).
    if (!club.stripeAccountId) {
      return NextResponse.json({ error: "Your club hasn't enabled online payments yet." }, { status: 400 });
    }

    const memberSub = await prisma.memberSubscription.create({
      data: {
        memberId: member.id,
        membershipId,
        optionLabel,
        price: finalPrice,
        billingPeriod: option.billingPeriod,
        billingType,
        startDate,
        endDate,
        autoRenew: membership.autoRenewDefault,
        status: "pending",
        discountCode: discount?.code || null,
      },
    });

    const amountInCents = Math.round(finalPrice * 100);
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

    // Reference the plan's reusable catalog Product so the charge shows up under
    // a real product in the club's Stripe (instead of an anonymous product_data
    // blob). Falls back to inline product_data if the catalog isn't ready — the
    // amount charged is identical either way.
    const catalogProductId = await ensureMembershipProduct(membership, club);
    const productField = catalogProductId
      ? { product: catalogProductId }
      : {
          product_data: {
            name: `${membership.name} — ${option.label}${discount ? ` (code ${discount.code})` : ""}`,
            ...((() => {
              const d =
                (membership.description ?? "") +
                (checkoutMode === "subscription" && passFees ? " (includes processing fee)" : "");
              return d.trim() ? { description: d.trim() } : {};
            })()),
          },
        };
    const lineItem: Record<string, unknown> = {
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: recurringAmount,
        ...productField,
        ...(isRecurring ? { recurring: stripeInterval } : {}),
      },
    };
    const feeItem =
      checkoutMode === "payment" ? processingFeeLineItem(amountInCents, passFees) : null;

    const appFeePercent = 0;

    // Honor trial rules — same central Free Trial offer as owner-side subscribe.
    let trialPeriodDays: number | null = null;
    if (isRecurring) {
      const trial = trialForMembership(club.freeTrialConfig, membership);
      if (trial) trialPeriodDays = await eligibleForSubscriptionTrial(member.id, membershipId, trial);
    }

    // Reuse the member's existing Stripe customer so every purchase accrues on
    // ONE customer (billing portal, saved methods, invoices) instead of
    // Checkout minting a fresh anonymous customer per purchase. Members with
    // no customer yet get one from Checkout, captured by the webhook.
    const existingCustomerId = member.stripeCustomerId ?? member.stripeSetupCustomerId ?? null;

    const checkoutSession = await stripe.checkout.sessions.create(
      {
        mode: checkoutMode,
        line_items: feeItem ? [lineItem, feeItem] : [lineItem],
        ...(existingCustomerId ? { customer: existingCustomerId } : {}),
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
                // NOTE: cancel_at_period_end is NOT a valid Checkout
                // subscription_data param (Stripe rejects the session with
                // "unknown parameter"). Auto Renew OFF is applied by the
                // checkout.session.completed webhook, which flips
                // cancel_at_period_end on the created subscription (the local
                // MemberSubscription row already carries autoRenew=false).
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
    if (discount) await recordDiscountUse(discount.id);

    return NextResponse.json({ url: checkoutSession.url });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
