import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe, calculatePlatformFee, billingPeriodToStripeInterval } from "@/lib/stripe";
import { ensureMembershipProduct } from "@/lib/stripeCatalog";
import { processingFeeLineItem, recurringUnitWithFee } from "@/lib/fees";
import { recomputeMemberStatus } from "@/lib/memberStatus";
import { getAppBaseUrl } from "@/lib/baseUrl";
import { discountedPrice, recordDiscountUse } from "@/lib/discounts";
import { resolveStaffDiscount, discountAppliedLabel, type ResolvedStaffDiscount } from "@/lib/staffPayments";
import { trialForMembership, eligibleForSubscriptionTrial } from "@/lib/freeTrial";
import { sendEmail } from "@/lib/email";

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
  // MANUAL path only: email the member a purchase receipt (card purchases get
  // Stripe's own receipt).
  emailReceipt:  z.boolean().optional().default(false),
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

    // Discount codes apply to whichever purchase option was selected; a code
    // scoped to specific memberships only validates against those. Resolved
    // via the shared staff-discount engine (invalid = 400 BLOCK, and the
    // resolved description drives the "<X> Discount Applied" label).
    let discount: ResolvedStaffDiscount | null = null;
    if (body.discountCode?.trim()) {
      const check = await resolveStaffDiscount(club.id, body.discountCode, {
        type: "MEMBERSHIP",
        membershipId,
      });
      if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
      discount = check.discount;
    }
    const finalPrice = discount ? discountedPrice(option.price, discount) : option.price;
    const discountAmount = discount ? Math.round((option.price - finalPrice) * 100) / 100 : null;
    const discountLabel = discountAppliedLabel(discount);

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
          price: finalPrice,
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
          discountCode: discount?.code || null,
          discountAmount,
        },
      });
      if (discount) await recordDiscountUse(discount.id);
      // Manual assignment is active immediately — flip member status to ACTIVE
      await recomputeMemberStatus(memberId, session.user.clubId);

      // Optional receipt for offline/manual purchases (guardian for minors).
      let receiptSent = false;
      if (body.emailReceipt) {
        const to = (member.isMinor ? member.guardianEmail || member.email : member.email || member.guardianEmail) || "";
        if (to.trim()) {
          await sendEmail({
            to: to.trim(),
            subject: `Membership receipt — ${club.name}`,
            fromName: club.emailFromName || club.name || null,
            replyTo: club.emailReplyTo || null,
            html: `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;color:#111">
                <h2 style="margin:0 0 12px">Membership receipt</h2>
                <p style="margin:0 0 16px;color:#444">Hi ${member.firstName}, here's your membership confirmation from ${club.name}.</p>
                <table style="width:100%;border-collapse:collapse;font-size:14px">
                  <tr><td style="padding:6px 0;color:#666">Plan</td><td style="padding:6px 0;text-align:right">${membership.name} — ${option.label}</td></tr>
                  ${
                    discount
                      ? `<tr><td style="padding:6px 0;color:#666">Original price</td><td style="padding:6px 0;text-align:right">$${option.price.toFixed(2)}</td></tr>
                         <tr><td style="padding:6px 0;color:#666">${discountLabel}</td><td style="padding:6px 0;text-align:right">−$${(discountAmount ?? 0).toFixed(2)}</td></tr>`
                      : ""
                  }
                  <tr><td style="padding:6px 0;color:#666">Price</td><td style="padding:6px 0;text-align:right;font-weight:600">$${finalPrice.toFixed(2)}${discount ? ` (code ${discount.code})` : ""}</td></tr>
                  <tr><td style="padding:6px 0;color:#666">Starts</td><td style="padding:6px 0;text-align:right">${resolvedStartDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</td></tr>
                  ${resolvedEndDate ? `<tr><td style="padding:6px 0;color:#666">Ends</td><td style="padding:6px 0;text-align:right">${resolvedEndDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</td></tr>` : ""}
                </table>
              </div>`,
          })
            .then(() => {
              receiptSent = true;
            })
            .catch(() => {});
        }
      }
      return NextResponse.json({ memberSub, type: "manual", receiptSent }, { status: 201 });
    }

    // ── Stripe required for RECURRING and ONE_TIME ───────────────────────────
    if (!club.stripeAccountId || !club.stripeChargesEnabled) {
      return NextResponse.json({ error: "Connect Stripe first, or use manual assignment" }, { status: 400 });
    }

    const amountInCents = Math.round(finalPrice * 100);
    const platformFee = calculatePlatformFee(amountInCents, club.tier);
    const stripeInterval = billingPeriodToStripeInterval(option.billingPeriod);

    // Create the MemberSubscription record first
    const memberSub = await prisma.memberSubscription.create({
      data: {
        memberId,
        membershipId,
        optionLabel,
        price: finalPrice,
        billingPeriod: option.billingPeriod,
        billingType: resolvedBillingType,
        startDate: resolvedStartDate,
        endDate: resolvedEndDate,
        autoRenew: resolvedAutoRenew,
        billingDay,
        billingAnchorDate,
        status: "pending",
        notes: body.notes || null,
        discountCode: discount?.code || null,
        discountAmount,
      },
    });

    const baseUrl = getAppBaseUrl();
    const isRecurring = resolvedBillingType === "RECURRING" && stripeInterval !== null;

    const checkoutMode: "subscription" | "payment" = isRecurring ? "subscription" : "payment";
    const passFees = club.passProcessingFees;
    const recurringAmount =
      checkoutMode === "subscription" ? recurringUnitWithFee(amountInCents, passFees) : amountInCents;

    // Reference the plan's reusable catalog Product (populates the club's Stripe
    // product catalog); fall back to inline product_data if catalog sync isn't
    // ready. Charged amount is identical either way.
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

    // Trial rules: the club's central Free Trial offer decides whether this
    // plan trials (legacy per-membership flags only apply for clubs that never
    // configured it). Repeat use on the same plan is gated by the offer.
    let trialPeriodDays: number | null = null;
    if (isRecurring) {
      const trial = trialForMembership(club.freeTrialConfig, membership);
      if (trial) trialPeriodDays = await eligibleForSubscriptionTrial(memberId, membershipId, trial);
    }

    // Build subscription_data with optional billing anchor. AthletixOS takes
    // no per-transaction platform cut on any plan.
    const appFeePercent = 0;
    const subscriptionData: Record<string, unknown> = {
      application_fee_percent: appFeePercent,
      metadata: { memberSubscriptionId: memberSub.id, memberId, clubId: club.id },
      // NOTE: cancel_at_period_end is NOT a valid Checkout subscription_data
      // param (Stripe rejects the whole session). Auto Renew OFF is applied by
      // the checkout.session.completed webhook using the local row's
      // autoRenew=false.
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
          // Discount identity for the webhook's Transaction (pickup pending —
          // the webhook is a separate workstream and is not modified here).
          ...(discount ? { discountCode: discount.code, discountAmount: String(discountAmount ?? 0) } : {}),
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
    if (discount) await recordDiscountUse(discount.id);

    return NextResponse.json({ url: checkoutSession.url, memberSubId: memberSub.id });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    }
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
