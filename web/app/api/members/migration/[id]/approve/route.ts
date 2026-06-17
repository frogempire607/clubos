import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { stripe, billingPeriodToStripeInterval } from "@/lib/stripe";
import { recurringUnitWithFee } from "@/lib/fees";
import { MIGRATION_STATUS, resolveBillingAnchor } from "@/lib/migration";
import { sendMembershipActivatedEmail } from "@/lib/email";
import { getAppBaseUrl } from "@/lib/baseUrl";

// Athlete (or guardian for minors) contact email for activation/approval notices.
function memberContactEmail(m: { isMinor: boolean; email: string | null; guardianEmail: string | null }) {
  return m.isMinor ? m.guardianEmail || m.email : m.email || m.guardianEmail;
}

// POST /api/members/migration/[id]/approve
// Owner reviews a PENDING_APPROVAL migration and approves billing. ONLY here
// is the recurring subscription created (off the card the client saved during
// activation), with the first charge anchored to the agreed billing date.
// Owner/staff with members:edit. Never charges on approval day — trial_end
// holds the first charge until the billing anchor.
const schema = z.object({
  // Owner's final billing date (matches old software cycle or manual edit).
  // If omitted we use requestedBillingDate (if accepting it) → billingAnchor.
  billingAnchorDate: z.string().optional().nullable(),
  acceptRequestedDate: z.boolean().optional().default(false),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "members", "edit");
  if (denied) return denied;

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json().catch(() => ({})));
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const member = await prisma.member.findFirst({
    where: { id, clubId: session.user.clubId, deletedAt: null },
    include: { club: true },
  });
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (member.migrationStatus === MIGRATION_STATUS.COMPLETED) {
    return NextResponse.json({ error: "This migration is already complete." }, { status: 409 });
  }
  const club = member.club;

  // Resolve the agreed billing anchor.
  let anchor: Date | null = null;
  if (body.billingAnchorDate) {
    const d = new Date(body.billingAnchorDate);
    if (!isNaN(d.getTime())) anchor = d;
  } else if (body.acceptRequestedDate && member.requestedBillingDate) {
    anchor = member.requestedBillingDate;
  } else {
    anchor = member.billingAnchorDate;
  }
  // No explicit date anywhere → derive one from the imported start date.
  if (!anchor) {
    anchor = resolveBillingAnchor({
      nextBillingDate: null,
      membershipStartDate: member.membershipStartDate,
      frequency: member.legacyBillingFrequency,
      now: new Date(),
    });
  }
  // If the agreed billing date already passed (member activated late), the
  // missed charge is collected NOW and the cycle recurs every frequency from
  // this charge — we do not skip ahead to the next cycle.
  const billsImmediately = !!anchor && anchor.getTime() <= Date.now() + 60_000;
  if (billsImmediately) anchor = new Date();

  // Resolve the plan: owner-assigned Membership first, else legacy snapshot.
  let planName = member.legacyMembershipName || "Continued membership";
  let price = member.legacyMembershipPrice ? Number(member.legacyMembershipPrice) : 0;
  let period = member.legacyBillingFrequency || "MONTHLY";
  let membershipId = member.migrationMembershipId;
  if (membershipId) {
    const plan = await prisma.membership.findFirst({
      where: { id: membershipId, clubId: club.id, deletedAt: null },
      select: { id: true, name: true, options: true },
    });
    if (plan) {
      planName = plan.name;
      try {
        const opts = JSON.parse((plan.options as unknown as string) || "[]");
        if (Array.isArray(opts) && opts[0]) {
          if (typeof opts[0].price === "number") price = opts[0].price;
          if (opts[0].billingPeriod) period = opts[0].billingPeriod;
        }
      } catch {
        /* keep legacy snapshot values */
      }
    } else {
      membershipId = null;
    }
  }

  // #5: honor the option the member chose at registration over the plan
  // default (the owner's explicit price override below still wins).
  if (member.migrationSelectedOption && typeof member.migrationSelectedOption === "object") {
    const sel = member.migrationSelectedOption as { price?: unknown; billingPeriod?: unknown };
    if (typeof sel.price === "number") price = sel.price;
    if (typeof sel.billingPeriod === "string" && sel.billingPeriod) period = sel.billingPeriod;
  }

  // Owner price override set before activation wins over every other source.
  if (member.migrationPriceOverride != null) {
    price = Number(member.migrationPriceOverride);
  }

  if (!membershipId) {
    const created = await prisma.membership.create({
      data: {
        clubId: club.id,
        name: planName,
        options: JSON.stringify([{ label: "Continued", price, billingPeriod: period }]),
      },
    });
    membershipId = created.id;
  }

  // Manual / no-online-payment path: complete without Stripe.
  const canCharge =
    !!club.stripeAccountId &&
    !!club.stripeChargesEnabled &&
    price > 0 &&
    !!member.stripeSetupCustomerId &&
    !!member.stripeSetupPaymentMethodId;

  if (!canCharge) {
    // Free ($0) or manually-billed membership: there's no Stripe charge, but the
    // member is still APPROVED and ACTIVE with their plan attached. Previously
    // this path only flipped the migration flags and left the member as PROSPECT
    // with no membership — so a $0/grandfathered or cash member never went live.
    // Record a MANUAL subscription so the membership shows in their portal and
    // can be canceled like any other.
    await prisma.memberSubscription.create({
      data: {
        memberId: member.id,
        membershipId: membershipId!,
        optionLabel: planName,
        price,
        billingPeriod: period,
        billingType: "MANUAL",
        autoRenew: false,
        status: "active",
        startDate: member.membershipStartDate ?? new Date(),
        billingAnchorDate: anchor,
        ...(member.requestedCancellationDate ? { endDate: member.requestedCancellationDate } : {}),
        notes:
          price <= 0
            ? "Free / grandfathered membership — no recurring charge"
            : `Manual billing — ${club.name} collects payment offline`,
      },
    });
    await prisma.member.update({
      where: { id: member.id },
      data: {
        migrationStatus: MIGRATION_STATUS.COMPLETED,
        approvalStatus: "APPROVED",
        status: "ACTIVE",
        membershipId,
        ...(anchor ? { billingAnchorDate: anchor } : {}),
        ...(member.requestedCancellationDate ? { commitmentEndDate: member.requestedCancellationDate } : {}),
        migrationCompletedAt: new Date(),
      },
    });
    await prisma.memberMigrationEvent.create({
      data: {
        clubId: club.id,
        memberId: member.id,
        type: "COMPLETED",
        message:
          price <= 0
            ? "Approved — free/grandfathered membership; active with no recurring charge."
            : "Approved — active; club handles billing manually (no card on file / online payments off).",
        actorUserId: session.user.id,
      },
    });
    const toNoPay = memberContactEmail(member);
    if (toNoPay) {
      sendMembershipActivatedEmail({
        to: toNoPay,
        firstName: member.firstName,
        clubName: club.name,
        membershipName: planName,
        nextBillingDate: anchor,
        portalUrl: `${getAppBaseUrl()}/member`,
      }).catch((e) => console.error("Approval email failed:", e));
    }
    return NextResponse.json({ ok: true, noPayment: true });
  }

  // Create the recurring subscription off the saved card. trial_end anchors
  // the FIRST charge to the agreed date so nobody is billed on approval day.
  const trialEnd =
    anchor && anchor.getTime() > Date.now() + 60_000 ? Math.floor(anchor.getTime() / 1000) : undefined;
  // #5: if the member requested a cancellation/end date, schedule the Stripe
  // subscription to auto-cancel then. Must be in the future and after any
  // trial_end, or Stripe rejects it.
  const cancelSource = member.requestedCancellationDate ?? member.commitmentEndDate ?? null;
  let cancelAtUnix: number | undefined;
  if (cancelSource && cancelSource.getTime() > Date.now() + 60_000) {
    const ts = Math.floor(cancelSource.getTime() / 1000);
    if (!trialEnd || ts > trialEnd) cancelAtUnix = ts;
  }
  const amountCents = recurringUnitWithFee(Math.round(price * 100), club.passProcessingFees);
  const interval = billingPeriodToStripeInterval(period) || { interval: "month" as const, interval_count: 1 };

  let memberSub;
  try {
    // Subscription price_data needs an existing Product (no inline
    // product_data like Checkout), so create one on the connected account.
    const product = await stripe.products.create(
      { name: `${planName} — continued from ${member.legacySource || "previous club"}` },
      { stripeAccount: club.stripeAccountId! },
    );
    const sub = await stripe.subscriptions.create(
      {
        customer: member.stripeSetupCustomerId!,
        default_payment_method: member.stripeSetupPaymentMethodId!,
        items: [
          {
            price_data: {
              currency: "usd",
              product: product.id,
              unit_amount: amountCents,
              recurring: interval,
            },
          },
        ],
        ...(trialEnd ? { trial_end: trialEnd } : {}),
        ...(cancelAtUnix ? { cancel_at: cancelAtUnix } : {}),
        application_fee_percent: 0,
        metadata: { migrationMemberId: member.id, clubId: club.id },
      },
      { stripeAccount: club.stripeAccountId! },
    );

    memberSub = await prisma.memberSubscription.create({
      data: {
        memberId: member.id,
        membershipId: membershipId!,
        optionLabel: planName,
        price,
        billingPeriod: period,
        billingType: "RECURRING",
        autoRenew: true,
        status: sub.status === "active" || sub.status === "trialing" ? "active" : "pending",
        startDate: member.membershipStartDate ?? new Date(),
        billingAnchorDate: anchor,
        stripeSubscriptionId: sub.id,
        notes: `Migrated from ${member.legacySource || "previous software"} — approved by club`,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: `Could not start the subscription: ${String(e)}` }, { status: 502 });
  }

  await prisma.member.update({
    where: { id: member.id },
    data: {
      migrationStatus: MIGRATION_STATUS.COMPLETED,
      approvalStatus: "APPROVED",
      membershipId,
      ...(anchor ? { billingAnchorDate: anchor } : {}),
      ...(member.requestedCancellationDate ? { commitmentEndDate: member.requestedCancellationDate } : {}),
      migrationCompletedAt: new Date(),
      status: "ACTIVE",
    },
  });
  await prisma.memberMigrationEvent.create({
    data: {
      clubId: club.id,
      memberId: member.id,
      type: "COMPLETED",
      message: billsImmediately
        ? `Approved — billing date had passed, so the cycle charge ran at approval and recurs ${period.toLowerCase()} from today (${planName})`
        : `Approved — billing continues ${anchor ? `from ${anchor.toLocaleDateString()}` : "on file"} (${planName})`,
      actorUserId: session.user.id,
    },
  });

  const toPaid = memberContactEmail(member);
  if (toPaid) {
    sendMembershipActivatedEmail({
      to: toPaid,
      firstName: member.firstName,
      clubName: club.name,
      membershipName: planName,
      amountPaid: billsImmediately ? `$${price.toFixed(2)}` : undefined,
      nextBillingDate: billsImmediately ? null : anchor,
      portalUrl: `${getAppBaseUrl()}/member`,
    }).catch((e) => console.error("Approval email failed:", e));
  }

  return NextResponse.json({ ok: true, subscriptionId: memberSub.stripeSubscriptionId });
}
