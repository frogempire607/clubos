import { anchorGrant } from "@/lib/billingAnchor";
import { writeBillingAudit } from "@/lib/billingAudit";
import { addBillingPeriod, addUTCMonths } from "@/lib/billingAdmin";
import { optionIdForPurchase, parseOptions } from "@/lib/membershipOptions";
import { minimumTermEnd, resolveTerms } from "@/lib/membershipOptions";
import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
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
import {
  recordSubscriptionCreated,
  recordSubscriptionEvent,
  SUBSCRIPTION_EVENT_KIND,
  SUBSCRIPTION_EVENT_SOURCE,
} from "@/lib/subscriptionEvents";


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

/**
 * Next occurrence of `day`-of-month, strictly in the future, at 00:00Z.
 *
 * Two things were wrong here. It built LOCAL midnight and stored that in
 * `billingAnchorDate`, a date-only column whose convention is 00:00Z — so the
 * value sat in a different frame from every other date on the row and read
 * back as the previous day in a negative-offset zone. And it let the day of
 * month overflow: asking for day 31 during February produced March 3, silently
 * moving the anchor into the wrong month entirely.
 *
 * Now: UTC throughout, and the day clamps to the length of the target month
 * (31 in February means the 28th/29th, which is what "bill me on the last day"
 * has to mean).
 */
function billingAnchorForDay(day: number, now: Date = new Date()): Date {
  const anchorIn = (monthOffset: number) => {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + monthOffset; // Date.UTC normalizes overflow into the next year
    const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, month, Math.min(day, lastDayOfMonth)));
  };
  const thisMonth = anchorIn(0);
  return thisMonth.getTime() > now.getTime() ? thisMonth : anchorIn(1);
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

    const planOptionsForTerm = parseOptions(membership.options);
    const soldOptionId = optionIdForPurchase(planOptionsForTerm, {
      label: option.label, billingPeriod: option.billingPeriod, price: option.price,
    });
    const soldOption = planOptionsForTerm.find((o) => o.id === soldOptionId) ?? null;
    // §8.6.5 — auto-renew comes from the OPTION, falling back to the plan.
    //
    // A provable no-op for existing data: every option in production has
    // autoRenewDefault null, so resolveTerms returns exactly the plan value it
    // returned before. It only starts to differ once an option states its own —
    // which is the point, since a month-to-month option and a 12-month one on
    // the same plan do not renew the same way.
    const resolvedAutoRenew =
      body.autoRenew ??
      (soldOption
        ? resolveTerms(soldOption, {
            contractMonths: membership.contractMonths,
            autoRenewDefault: membership.autoRenewDefault,
          }).autoRenewDefault
        : membership.autoRenewDefault);
    const resolvedStartDate = body.startDate ? new Date(body.startDate) : new Date();
    // §8.8.1 — the floor, from the option's own contractMonths (or the plan's).
    // Null when neither sets one, which is most options.
    const termEnd = soldOption
      ? minimumTermEnd(resolvedStartDate, soldOption, { contractMonths: membership.contractMonths }, addUTCMonths)
      : null;

    // Compute endDate for one-time purchases if not explicitly provided
    let resolvedEndDate: Date | null = body.endDate ? new Date(body.endDate) : null;
    if (!resolvedEndDate && resolvedBillingType === "ONE_TIME") {
      resolvedEndDate = addBillingPeriod(resolvedStartDate, option.billingPeriod);
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
          optionId: soldOptionId,
          minimumTermEndsAt: termEnd,
          optionLabel,
          price: finalPrice,
          billingPeriod: option.billingPeriod,
          billingType: "MANUAL",
          startDate: resolvedStartDate,
          endDate: resolvedEndDate,
          // Offline rows carry no Stripe period, so stamp it here: without it
          // nothing knows when this paid-up period expires (renewal alerts, the
          // unused-time credit, "who owes money" were all blind to cash members).
          currentPeriodEnd: addBillingPeriod(resolvedStartDate, option.billingPeriod),
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
      // 4.5.10 — a MANUAL assignment is live immediately, so it is both a
      // CREATED and an ACTIVATED transition. Reports counts activations, not
      // rows, so both have to exist.
      await recordSubscriptionCreated(memberSub, {
        clubId: session.user.clubId,
        source: SUBSCRIPTION_EVENT_SOURCE.OWNER_ACTION,
        actorUserId: session.user.id,
        detail: { route: "POST /api/members/subscribe", billingType: "MANUAL" },
      });
      await recordSubscriptionEvent({
        clubId: session.user.clubId,
        memberSubscriptionId: memberSub.id,
        memberId,
        kind: SUBSCRIPTION_EVENT_KIND.ACTIVATED,
        toPlan: optionLabel,
        toAmount: String(finalPrice),
        actorUserId: session.user.id,
        source: SUBSCRIPTION_EVENT_SOURCE.OWNER_ACTION,
        detail: { route: "POST /api/members/subscribe", billingType: "MANUAL" },
      });
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

    // ── An End date on a card-billed RECURRING subscription is a promise we
    //    cannot keep, so refuse it rather than record it. ──────────────────
    //
    // The row below writes `endDate: resolvedEndDate` locally, and nothing in
    // this route or the checkout webhook ever tells Stripe about it. Checkout
    // has no `cancel_at` / `cancel_at_period_end` in `subscription_data`
    // (Stripe rejects the whole session), so the ONLY mechanism that ends a
    // recurring subscription today is the webhook's `autoRenew === false`
    // branch — which sets `cancel_at_period_end` AND writes the real date back
    // from Stripe. With `autoRenew` true, a typed End date is pure decoration:
    // the app says the membership ends and Stripe bills forever.
    //
    // That is Titus Hall. Staff typed 2027-07-14 into this form on 2026-07-14;
    // the row says he ends then, Stripe holds no cancel_at, and he renews.
    //
    // ONE_TIME is unaffected — `mode: "payment"` has no subscription to cancel
    // and the end date is a local access window the webhook already computes.
    //
    // This is a refusal, not a silent correction: whether "ends on this date"
    // should become a Stripe `cancel_at` is a product decision about what a
    // term means (plan.md §8.12 D11), and until it is made the honest answer
    // is that this form cannot express it.
    if (resolvedEndDate && resolvedBillingType === "RECURRING") {
      return NextResponse.json(
        {
          error:
            "An end date can't be set on a card-billed recurring membership — Stripe would keep billing past it. " +
            "Turn Auto Renew off to end it at the close of its billing period, or assign it as a manual membership " +
            "if the club is collecting offline. Nothing was created.",
          code: "END_DATE_NOT_SUPPORTED_ON_RECURRING",
        },
        { status: 400 },
      );
    }

    const amountInCents = Math.round(finalPrice * 100);
    const platformFee = calculatePlatformFee(amountInCents, club.tier);
    const stripeInterval = billingPeriodToStripeInterval(option.billingPeriod);

    // Create the MemberSubscription record first
    const memberSub = await prisma.memberSubscription.create({
      data: {
        memberId,
        membershipId,
        optionId: soldOptionId,
        minimumTermEndsAt: termEnd,
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

    // 4.5.10 — CREATED only. This row is `pending`; the ACTIVATED transition
    // belongs to the webhook that confirms the money, not to opening a
    // checkout page the client may abandon.
    await recordSubscriptionCreated(memberSub, {
      clubId: session.user.clubId,
      source: SUBSCRIPTION_EVENT_SOURCE.OWNER_ACTION,
      actorUserId: session.user.id,
      detail: { route: "POST /api/members/subscribe", billingType: resolvedBillingType },
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

    // ── The anchor is a free-time grant. Record it and say so. ────────────
    //
    // MANUAL PATH ONLY — do not wire anchorGrant into the reactivation flow.
    // An anchor that came from a confirmed offer is not discretionary: the date
    // was frozen in the offer, the member clicked confirm on it, and the offer
    // row is the record. Orson Chorba's 2026-07-24 anchor was exactly that, and
    // logging it beside Levi's four-week grant would put a legitimate
    // arrangement in a list of things to question. A log that flags correct
    // behaviour is a log that stops being read.
    //
    // Staff pick a billing date; Stripe honours it; the member is not charged
    // until then. That makes the date picker a way to give away membership, and
    // until now it left no audit row and showed no number. Levi Schanzenbach
    // was given 22 days beyond the club's trial — $128.33 — by an anchor set
    // four weeks out, and nothing anywhere said so.
    //
    // The grant is computed ONCE here and both logged and returned, so the
    // number staff are shown is the same number that lands in the audit log.
    const grant = anchorGrant({
      now: new Date(),
      anchor: billingAnchorDate,
      trialDays: trialPeriodDays ?? 0,
      price: Number(option.price),
      billingPeriod: option.billingPeriod ?? "MONTHLY",
    });
    if (grant.grantedDays > 0) {
      await writeBillingAudit({
        clubId: club.id,
        memberId: member.id,
        actorUserId: session.user.id,
        action: "BILLING_ANCHOR_GRANT",
        before: { firstChargeWouldBe: trialPeriodDays ? `${trialPeriodDays}d (trial)` : "immediately" },
        after: {
          anchor: billingAnchorDate?.toISOString() ?? null,
          totalFreeDays: grant.totalFreeDays,
          trialDays: grant.trialDays,
          grantedDays: grant.grantedDays,
          grantedValue: grant.grantedValue,
        },
        note:
          `Billing anchor set to ${billingAnchorDate?.toISOString().slice(0, 10)} on "${option.label}". ` +
          grant.sentence,
      });
    }

    return NextResponse.json({
      url: checkoutSession.url,
      memberSubId: memberSub.id,
      // Surfaced so the confirming screen can state the grant rather than
      // showing a bare date whose cost nobody computes.
      anchorGrant: grant.grantedDays > 0 ? grant : null,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    }
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
