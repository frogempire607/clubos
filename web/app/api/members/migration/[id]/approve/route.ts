import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { stripe, billingPeriodToStripeInterval } from "@/lib/stripe";
import { recurringUnitWithFee } from "@/lib/fees";
import { MIGRATION_STATUS, resolveBillingAnchor } from "@/lib/migration";

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
  anchor = resolveBillingAnchor({
    nextBillingDate: anchor,
    membershipStartDate: member.membershipStartDate,
    frequency: member.legacyBillingFrequency,
    now: new Date(),
  });

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
    await prisma.member.update({
      where: { id: member.id },
      data: {
        migrationStatus: MIGRATION_STATUS.COMPLETED,
        approvalStatus: "APPROVED",
        ...(anchor ? { billingAnchorDate: anchor } : {}),
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
            ? "Approved — no membership price on file; club handles billing manually."
            : "Approved — no card on file / online payments off; club handles billing manually.",
        actorUserId: session.user.id,
      },
    });
    return NextResponse.json({ ok: true, noPayment: true });
  }

  // Create the recurring subscription off the saved card. trial_end anchors
  // the FIRST charge to the agreed date so nobody is billed on approval day.
  const trialEnd =
    anchor && anchor.getTime() > Date.now() + 60_000 ? Math.floor(anchor.getTime() / 1000) : undefined;
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
      migrationCompletedAt: new Date(),
      status: "ACTIVE",
    },
  });
  await prisma.memberMigrationEvent.create({
    data: {
      clubId: club.id,
      memberId: member.id,
      type: "COMPLETED",
      message: `Approved — billing continues ${anchor ? `from ${anchor.toLocaleDateString()}` : "on file"} (${planName})`,
      actorUserId: session.user.id,
    },
  });

  return NextResponse.json({ ok: true, subscriptionId: memberSub.stripeSubscriptionId });
}
