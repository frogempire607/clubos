import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { stripe, billingPeriodToStripeInterval } from "@/lib/stripe";
import { ensureMembershipProduct } from "@/lib/stripeCatalog";
import { recurringUnitWithFee } from "@/lib/fees";
import { getAppBaseUrl } from "@/lib/baseUrl";
import { sendMembershipActivatedEmail } from "@/lib/email";
import { writeBillingAudit } from "@/lib/billingAudit";
import { parseOffer, compareOfferToCurrent } from "@/lib/reactivation";
import { chargeTiming, addBillingPeriod } from "@/lib/billingAdmin";
import { MIGRATION_STATUS } from "@/lib/migration";

export const dynamic = "force-dynamic";

// POST /api/reactivate/[token]/confirm — the client accepts the owner-approved
// offer. Safety properties, in order:
//   • The offer is RE-READ server-side; the request body carries no price/date.
//   • Live-subscription preflight against Stripe on every known customer — a
//     member who already has a live sub can never be double-subscribed.
//   • Charge timing is recomputed NOW: a promised future date that has since
//     passed downgrades to an immediate charge and requires the explicit
//     acknowledgement flag (the page re-words the button accordingly).
//   • Idempotent: an atomic status claim (DRAFT/SENT → CONFIRMING) makes
//     double-clicks/refreshes no-ops, and the Stripe create carries an
//     idempotency key per offer version.
//   • Consent (timestamp, account, email, offer version, IP, user-agent,
//     button label) is stored on the reactivation row.

const schema = z.object({
  // Required whenever the recomputed charge timing is immediate.
  acknowledgeImmediateCharge: z.boolean().optional().default(false),
});

const LIVE = new Set(["active", "trialing", "past_due", "unpaid"]);

async function customerHasLiveSub(customerId: string, stripeAccount: string): Promise<boolean> {
  const subs = await stripe.subscriptions.list(
    { customer: customerId, status: "all", limit: 20 },
    { stripeAccount },
  );
  return subs.data.some((s) => LIVE.has(s.status));
}

export async function POST(req: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  if (!token || token.length < 20) return NextResponse.json({ error: "Invalid link" }, { status: 400 });

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json().catch(() => ({})));
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const r = await prisma.membershipReactivation.findUnique({
    where: { token },
    include: {
      member: true,
      club: true,
    },
  });
  if (!r) return NextResponse.json({ error: "This link isn't valid." }, { status: 404 });
  if (r.status === "CONFIRMED") {
    // Refresh/double-click after success — report success, change nothing.
    return NextResponse.json({ ok: true, alreadyConfirmed: true });
  }
  if (r.status !== "DRAFT" && r.status !== "SENT") {
    return NextResponse.json({ error: "This offer is no longer open. Ask the club for a fresh link." }, { status: 410 });
  }
  if (r.tokenExpires < new Date()) {
    return NextResponse.json({ error: "This link has expired. Ask the club to resend it.", code: "EXPIRED" }, { status: 410 });
  }
  // An open client change request LOCKS confirmation: the club is reviewing
  // the requested changes, so the old terms must not be accepted meanwhile.
  if (r.changeRequestStatus === "OPEN") {
    return NextResponse.json(
      {
        error: "You asked the club for changes to this offer — it can't be confirmed while they review. They'll send an updated offer or respond shortly. Nothing was charged.",
        code: "CHANGE_REQUEST_PENDING",
      },
      { status: 409 },
    );
  }

  const member = r.member;
  const club = r.club;
  if (member.deletedAt) return NextResponse.json({ error: "This member record is no longer active." }, { status: 410 });

  // The latest server-side offer — never anything from the client.
  const offer = parseOffer(r.offer);
  if (!offer) return NextResponse.json({ error: "This offer can't be loaded. Contact the club." }, { status: 500 });

  // The offer is an immutable snapshot: if the club edited billing after it
  // was sent, this token is out of date and MUST NOT confirm the old terms.
  // Fail closed if the comparison itself errors.
  try {
    const cmp = await compareOfferToCurrent(member, club, offer);
    if (!cmp.matches) {
      return NextResponse.json(
        {
          error:
            "This offer was updated by the club after it was sent, so it can no longer be confirmed. Ask the club to resend the latest version. Nothing was charged.",
          code: "OFFER_OUT_OF_DATE",
        },
        { status: 409 },
      );
    }
  } catch (e) {
    console.error("reactivate confirm: staleness check failed", e);
    return NextResponse.json(
      { error: "The offer can't be verified right now. Nothing was charged — try again in a minute." },
      { status: 503 },
    );
  }

  const isFree = offer.paymentMode === "FREE" || offer.price <= 0;
  const isOffline = offer.paymentMode === "OFFLINE";
  const isCard = !isFree && !isOffline;

  // ── Existing-subscription preflight ─────────────────────────────────────
  const localLive = await prisma.memberSubscription.findFirst({
    where: {
      memberId: member.id,
      stripeSubscriptionId: { not: null },
      status: { in: ["active", "past_due"] },
    },
    select: { id: true },
  });
  if (localLive) {
    return NextResponse.json(
      { error: "A live subscription already exists for this membership — nothing was charged. Contact the club.", code: "ALREADY_SUBSCRIBED" },
      { status: 409 },
    );
  }
  if (isCard && club.stripeAccountId) {
    for (const custId of [member.stripeSetupCustomerId, member.stripeCustomerId]) {
      if (!custId) continue;
      try {
        if (await customerHasLiveSub(custId, club.stripeAccountId)) {
          return NextResponse.json(
            { error: "A live subscription already exists in the club's billing system — nothing was charged. Contact the club.", code: "ALREADY_SUBSCRIBED" },
            { status: 409 },
          );
        }
      } catch (e) {
        console.error("Reactivation live-sub preflight failed:", e);
        return NextResponse.json(
          { error: "Billing couldn't be verified right now. Nothing was charged — try again in a minute." },
          { status: 502 },
        );
      }
    }
  }

  // ── Payment method requirement ──────────────────────────────────────────
  if (isCard && (!club.stripeAccountId || !club.stripeChargesEnabled)) {
    return NextResponse.json({ error: "The club doesn't accept online payments right now. Contact the club." }, { status: 409 });
  }
  // The captured-method pointer is normally set by the card-save webhook, but
  // webhooks only reach the PRODUCTION deployment — a card saved while
  // testing on a preview (or during a webhook outage) is attached to the
  // Stripe customer without the pointer. Fall back to reading the customer's
  // default/only card live from Stripe and persist it, so a genuinely saved
  // card never dead-ends the confirmation.
  let paymentMethodId = member.stripeSetupPaymentMethodId;
  if (isCard && member.stripeSetupCustomerId && !paymentMethodId && club.stripeAccountId) {
    try {
      const customer = await stripe.customers.retrieve(member.stripeSetupCustomerId, {
        stripeAccount: club.stripeAccountId,
      });
      if (customer && !("deleted" in customer && customer.deleted)) {
        const def = (customer as { invoice_settings?: { default_payment_method?: string | { id: string } | null } })
          .invoice_settings?.default_payment_method;
        paymentMethodId = typeof def === "string" ? def : def?.id ?? null;
      }
      if (!paymentMethodId) {
        const cards = await stripe.paymentMethods.list(
          { customer: member.stripeSetupCustomerId, type: "card", limit: 2 },
          { stripeAccount: club.stripeAccountId },
        );
        // Only when unambiguous — never guess between multiple cards.
        if (cards.data.length === 1) paymentMethodId = cards.data[0].id;
      }
      if (paymentMethodId) {
        await prisma.member.update({
          where: { id: member.id },
          data: { stripeSetupPaymentMethodId: paymentMethodId, paymentSetupStatus: "COMPLETE" },
        });
      }
    } catch (e) {
      console.error("reactivate confirm: PM fallback resolve failed", e);
    }
  }
  if (isCard && (!member.stripeSetupCustomerId || !paymentMethodId)) {
    return NextResponse.json(
      { error: "Add a payment method first.", code: "NEEDS_PAYMENT_METHOD" },
      { status: 409 },
    );
  }

  // ── Charge timing, recomputed NOW ───────────────────────────────────────
  const firstCharge = offer.firstChargeDate ? new Date(offer.firstChargeDate) : null;
  const timing = chargeTiming(firstCharge);
  const chargesNow = isCard && timing.immediate;
  // Exact card charge — fee-inclusive when the club passes the processing fee.
  // Every user-facing amount below states THIS (it's what Stripe bills), never
  // the base price alone. Same lib/fees.ts math as the subscription created.
  const totalCharged = recurringUnitWithFee(Math.round(offer.price * 100), isCard && club.passProcessingFees) / 100;
  if (chargesNow && !body.acknowledgeImmediateCharge) {
    return NextResponse.json(
      {
        error: `Confirming will charge $${totalCharged.toFixed(2)} immediately.`,
        code: "IMMEDIATE_CHARGE_CONFIRM_REQUIRED",
        price: offer.price,
        totalCharged,
      },
      { status: 409 },
    );
  }

  // ── Atomic claim (idempotency) ──────────────────────────────────────────
  const claimed = await prisma.membershipReactivation.updateMany({
    where: { id: r.id, status: { in: ["DRAFT", "SENT"] } },
    data: { status: "CONFIRMING" },
  });
  if (claimed.count === 0) {
    const fresh = await prisma.membershipReactivation.findUnique({ where: { id: r.id }, select: { status: true } });
    if (fresh?.status === "CONFIRMED") return NextResponse.json({ ok: true, alreadyConfirmed: true });
    return NextResponse.json({ error: "This confirmation is already being processed. Give it a few seconds." }, { status: 409 });
  }

  const revert = () =>
    prisma.membershipReactivation
      .updateMany({ where: { id: r.id, status: "CONFIRMING" }, data: { status: r.status } })
      .catch(() => {});

  try {
    // Consent metadata.
    const session = await getServerSession(authOptions).catch(() => null);
    const fwd = req.headers.get("x-forwarded-for");
    const consent = {
      at: new Date().toISOString(),
      userId: session?.user?.id ?? null,
      email: r.sentToEmail ?? (member.isMinor ? member.guardianEmail : member.email) ?? null,
      offerVersion: r.offerVersion,
      ip: fwd ? fwd.split(",")[0].trim() : null,
      userAgent: req.headers.get("user-agent")?.slice(0, 300) ?? null,
      buttonLabel: chargesNow
        ? `Confirm membership — $${totalCharged.toFixed(2)} charged today`
        : isFree
          ? "Confirm membership"
          : `Confirm membership — first payment ${firstCharge?.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })}`,
      acknowledgedImmediateCharge: chargesNow ? true : undefined,
    };

    // Ensure a Membership row exists to attach the subscription to.
    let membershipId = offer.membershipId;
    if (membershipId) {
      const exists = await prisma.membership.findFirst({
        where: { id: membershipId, clubId: club.id },
        select: { id: true },
      });
      if (!exists) membershipId = null;
    }
    if (!membershipId) {
      const created = await prisma.membership.create({
        data: {
          clubId: club.id,
          name: offer.planName,
          options: JSON.stringify([{ label: offer.optionLabel || "Continued", price: offer.price, billingPeriod: offer.billingPeriod }]),
        },
      });
      membershipId = created.id;
    }

    let memberSubId: string;
    let stripeSubCreated = false;

    if (isCard) {
      // trial_end anchors the FIRST charge to the promised date; a past date
      // (explicitly acknowledged above) charges now.
      const trialEnd =
        firstCharge && firstCharge.getTime() > Date.now() + 60_000
          ? Math.floor(firstCharge.getTime() / 1000)
          : undefined;
      let cancelSource = offer.commitmentEndDate ? new Date(offer.commitmentEndDate) : null;
      // Plan-level Auto Renew OFF with no explicit commitment: the
      // subscription ends after its FIRST billing period (measured from the
      // first charge) instead of renewing.
      if (!cancelSource && offer.autoRenew === false) {
        cancelSource = addBillingPeriod(firstCharge ?? new Date(), offer.billingPeriod);
      }
      let cancelAtUnix: number | undefined;
      if (cancelSource && cancelSource.getTime() > Date.now() + 60_000) {
        const ts = Math.floor(cancelSource.getTime() / 1000);
        if (!trialEnd || ts > trialEnd) cancelAtUnix = ts;
      }
      const amountCents = recurringUnitWithFee(Math.round(offer.price * 100), club.passProcessingFees);
      const interval = billingPeriodToStripeInterval(offer.billingPeriod) || { interval: "month" as const, interval_count: 1 };

      const catalogMembership = await prisma.membership.findFirst({
        where: { id: membershipId, clubId: club.id },
        select: { id: true, clubId: true, name: true, description: true, stripeProductId: true, stripePriceIds: true },
      });
      let productId = catalogMembership ? await ensureMembershipProduct(catalogMembership, club) : null;
      if (!productId) {
        const product = await stripe.products.create(
          { name: offer.planName, metadata: { athletixMembershipId: membershipId, clubId: club.id, kind: "membership" } },
          { stripeAccount: club.stripeAccountId! },
        );
        productId = product.id;
      }

      const sub = await stripe.subscriptions.create(
        {
          customer: member.stripeSetupCustomerId!,
          default_payment_method: paymentMethodId!,
          items: [
            {
              price_data: {
                currency: "usd",
                product: productId,
                unit_amount: amountCents,
                recurring: interval,
              },
            },
          ],
          ...(trialEnd ? { trial_end: trialEnd } : {}),
          ...(cancelAtUnix ? { cancel_at: cancelAtUnix } : {}),
          proration_behavior: "none",
          application_fee_percent: 0,
          metadata: { reactivationId: r.id, migrationMemberId: member.id, clubId: club.id },
        },
        {
          stripeAccount: club.stripeAccountId!,
          idempotencyKey: `aox-reactivation-${r.id}-v${r.offerVersion}`,
        },
      );
      stripeSubCreated = true;

      const memberSub = await prisma.memberSubscription.create({
        data: {
          memberId: member.id,
          membershipId,
          optionLabel: offer.optionLabel || offer.planName,
          price: offer.price,
          billingPeriod: offer.billingPeriod,
          billingType: "RECURRING",
          autoRenew: offer.autoRenew !== false,
          status: sub.status === "active" || sub.status === "trialing" ? "active" : "pending",
          startDate: offer.startDate ? new Date(offer.startDate) : new Date(),
          billingAnchorDate: firstCharge ?? new Date(),
          ...(cancelSource ? { endDate: cancelSource } : {}),
          stripeSubscriptionId: sub.id,
          stripePriceId: sub.items?.data?.[0]?.price?.id ?? null,
          stripeProductId: productId,
          stripeStatus: sub.status,
          notes: `Reactivated via secure confirmation link (offer v${r.offerVersion})`,
        },
      });
      memberSubId = memberSub.id;
    } else {
      const memberSub = await prisma.memberSubscription.create({
        data: {
          memberId: member.id,
          membershipId,
          optionLabel: offer.optionLabel || offer.planName,
          price: offer.price,
          billingPeriod: offer.billingPeriod,
          billingType: "MANUAL",
          autoRenew: false,
          status: "active",
          startDate: offer.startDate ? new Date(offer.startDate) : new Date(),
          // Explicit commitment wins; otherwise a non-renewing plan ends after
          // its first billing period (expireEndedManualSubscriptions sweeps it).
          ...(offer.commitmentEndDate
            ? { endDate: new Date(offer.commitmentEndDate) }
            : offer.autoRenew === false
              ? { endDate: addBillingPeriod(offer.startDate ? new Date(offer.startDate) : new Date(), offer.billingPeriod) }
              : {}),
          notes: isFree
            ? "Free / grandfathered membership — no recurring charge (confirmed via reactivation link)"
            : `Manual billing — ${club.name} collects payment offline (confirmed via reactivation link)`,
        },
      });
      memberSubId = memberSub.id;
    }

    // Supersede any standing non-Stripe subscription (e.g. the placeholder
    // MANUAL/free row from the original migration) so the member doesn't end
    // up with two "active" memberships. Rows are kept — canceled with a
    // breadcrumb, never deleted.
    await prisma.memberSubscription.updateMany({
      where: {
        memberId: member.id,
        id: { not: memberSubId },
        stripeSubscriptionId: null,
        status: { in: ["active", "pending", "past_due"] },
      },
      data: {
        status: "canceled",
        canceledAt: new Date(),
        autoRenew: false,
      },
    });

    await prisma.member.update({
      where: { id: member.id },
      data: {
        status: "ACTIVE",
        membershipId,
        migrationStatus: MIGRATION_STATUS.COMPLETED,
        approvalStatus: "APPROVED",
        migrationCompletedAt: new Date(),
        ...(firstCharge ? { billingAnchorDate: firstCharge } : {}),
        ...(offer.commitmentEndDate ? { commitmentEndDate: new Date(offer.commitmentEndDate) } : {}),
      },
    });

    await prisma.membershipReactivation.update({
      where: { id: r.id },
      data: {
        status: "CONFIRMED",
        confirmedAt: new Date(),
        confirmedByUserId: session?.user?.id ?? null,
        consent: consent as unknown as Prisma.InputJsonValue,
        memberSubscriptionId: memberSubId,
      },
    });

    await writeBillingAudit({
      clubId: club.id,
      memberId: member.id,
      action: "REACTIVATION_CONFIRMED",
      after: {
        offerVersion: r.offerVersion,
        plan: offer.planName,
        price: offer.price,
        period: offer.billingPeriod,
        firstChargeDate: offer.firstChargeDate,
        chargedImmediately: chargesNow,
        stripeSubscription: stripeSubCreated,
      },
      note: chargesNow
        ? "Client confirmed with an explicitly acknowledged immediate charge."
        : "Client confirmed — first charge anchored to the promised date.",
    });
    await prisma.memberMigrationEvent.create({
      data: {
        clubId: club.id,
        memberId: member.id,
        type: "COMPLETED",
        message: chargesNow
          ? `Client confirmed the reactivation offer — cycle charge ran at confirmation (${offer.planName})`
          : `Client confirmed the reactivation offer — billing ${firstCharge ? `starts ${firstCharge.toLocaleDateString()}` : "on file"} (${offer.planName})`,
      },
    }).catch(() => {});

    // Confirmation / receipt email (best-effort).
    const to = r.sentToEmail ?? (member.isMinor ? member.guardianEmail || member.email : member.email || member.guardianEmail);
    if (to) {
      sendMembershipActivatedEmail({
        to,
        firstName: member.firstName,
        clubName: club.name,
        membershipName: offer.planName,
        amountPaid: chargesNow ? `$${totalCharged.toFixed(2)}` : undefined,
        nextBillingDate: chargesNow ? null : firstCharge,
        portalUrl: `${getAppBaseUrl()}/member`,
      }).catch((e) => console.error("Reactivation confirmation email failed:", e));
    }

    return NextResponse.json({
      ok: true,
      chargedNow: chargesNow,
      firstChargeDate: chargesNow ? null : offer.firstChargeDate,
    });
  } catch (e) {
    console.error("Reactivation confirm failed:", e);
    await revert();
    return NextResponse.json(
      { error: "The confirmation couldn't be completed. Nothing was finalized — try again in a minute." },
      { status: 502 },
    );
  }
}
