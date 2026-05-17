import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { stripe, calculatePlatformFee, billingPeriodToStripeInterval } from "@/lib/stripe";
import { MIGRATION_STATUS, PAYMENT_SETUP, resolveBillingAnchor } from "@/lib/migration";
import { recurringUnitWithFee } from "@/lib/fees";

// NO AUTH — token-gated public activation endpoint.

async function loadByToken(token: string) {
  const member = await prisma.member.findFirst({
    where: { activationToken: token, deletedAt: null },
    include: { club: true },
  });
  if (!member) return { error: "This activation link is invalid." as const };
  if (member.activationTokenExpires && member.activationTokenExpires < new Date()) {
    return { error: "This activation link has expired. Ask your club to resend it." as const };
  }
  return { member };
}

// GET — render data for the activation page.
export async function GET(_req: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const r = await loadByToken(token);
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: 404 });
  const m = r.member;

  const requiredDoc = await prisma.document.findFirst({
    where: {
      clubId: m.clubId,
      deletedAt: null,
      required: true,
      OR: [{ publishAt: null }, { publishAt: { lte: new Date() } }],
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, title: true, body: true },
  });

  return NextResponse.json({
    completed: m.migrationStatus === MIGRATION_STATUS.COMPLETED,
    member: {
      firstName: m.firstName,
      lastName: m.lastName,
      email: m.email,
      phone: m.phone,
      isMinor: m.isMinor,
      guardianName: m.guardianName,
      guardianEmail: m.guardianEmail,
    },
    club: { name: m.club.name, slug: m.club.slug, logoUrl: m.club.logoUrl, primaryColor: m.club.primaryColor },
    membership: {
      name: m.legacyMembershipName,
      price: m.legacyMembershipPrice ? Number(m.legacyMembershipPrice) : null,
      frequency: m.legacyBillingFrequency,
      nextBillingDate: m.billingAnchorDate ? m.billingAnchorDate.toISOString() : null,
      commitmentEndDate: m.commitmentEndDate ? m.commitmentEndDate.toISOString() : null,
    },
    paymentEnabled: !!(m.club.stripeAccountId && m.club.stripeChargesEnabled),
    requiredDocument: requiredDoc,
  });
}

const postSchema = z.object({
  password: z.string().min(8),
  phone: z.string().optional().nullable(),
  autopayAccepted: z.literal(true),
  signedDocumentId: z.string().optional().nullable(),
});

// POST — complete activation: set password, confirm profile, accept autopay,
// (optionally) sign a waiver, then open Stripe to add the payment method.
// Billing NEVER starts here — Stripe collects the card and only charges on the
// member's existing billing date (trial_end = billingAnchorDate).
export async function POST(req: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const r = await loadByToken(token);
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: 404 });
  const member = r.member;
  const club = member.club;

  if (member.migrationStatus === MIGRATION_STATUS.COMPLETED) {
    return NextResponse.json({ error: "This membership is already active." }, { status: 409 });
  }

  let body: z.infer<typeof postSchema>;
  try {
    body = postSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      const msg = err.errors[0]?.message || "Invalid request";
      return NextResponse.json(
        { error: msg.includes("autopay") ? "You must accept the autopay terms to continue." : msg },
        { status: 400 },
      );
    }
    throw err;
  }

  const contactEmail = (member.isMinor ? member.guardianEmail || member.email : member.email)?.toLowerCase() || null;
  if (!contactEmail) {
    return NextResponse.json(
      { error: "No email on file. Contact your club to finish setup." },
      { status: 400 },
    );
  }

  // Create or link the portal User account.
  const passwordHash = await bcrypt.hash(body.password, 10);
  let user = await prisma.user.findUnique({
    where: { clubId_email: { clubId: club.id, email: contactEmail } },
  });
  if (user) {
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
  } else {
    user = await prisma.user.create({
      data: {
        clubId: club.id,
        email: contactEmail,
        passwordHash,
        firstName: member.firstName,
        lastName: member.lastName,
        role: "MEMBER",
      },
    });
  }
  if (!member.userId) {
    await prisma.member.update({ where: { id: member.id }, data: { userId: user.id } });
  }

  // Confirm profile + record acceptance / activation.
  await prisma.member.update({
    where: { id: member.id },
    data: {
      phone: body.phone?.trim() || member.phone,
      migrationStatus: MIGRATION_STATUS.ACTIVATED,
      activatedAt: new Date(),
    },
  });

  // Optional required-document signature.
  if (body.signedDocumentId) {
    const doc = await prisma.document.findFirst({
      where: { id: body.signedDocumentId, clubId: club.id, deletedAt: null },
      select: { id: true },
    });
    if (doc) {
      const ipHeader = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip");
      await prisma.documentSignature.upsert({
        where: { documentId_memberId: { documentId: doc.id, memberId: member.id } },
        update: {
          signerUserId: user.id,
          signerName: `${member.firstName} ${member.lastName}`.trim(),
          relationship: member.isMinor ? "GUARDIAN" : "SELF",
          signedAt: new Date(),
          ipAddress: ipHeader ? ipHeader.split(",")[0].trim() : null,
          userAgent: req.headers.get("user-agent"),
        },
        create: {
          documentId: doc.id,
          memberId: member.id,
          signerUserId: user.id,
          signerName: `${member.firstName} ${member.lastName}`.trim(),
          relationship: member.isMinor ? "GUARDIAN" : "SELF",
          ipAddress: ipHeader ? ipHeader.split(",")[0].trim() : null,
          userAgent: req.headers.get("user-agent"),
        },
      });
    }
  }

  await prisma.memberMigrationEvent.create({
    data: {
      clubId: club.id,
      memberId: member.id,
      type: "ACTIVATED",
      message: "Account activated, profile confirmed, autopay accepted",
    },
  });

  const price = member.legacyMembershipPrice ? Number(member.legacyMembershipPrice) : 0;
  const period = member.legacyBillingFrequency || "MONTHLY";

  // No online payment possible (club not connected) or no price on file →
  // account is activated; the club follows up on billing. Never auto-charge.
  if (!club.stripeAccountId || !club.stripeChargesEnabled || price <= 0) {
    await prisma.memberMigrationEvent.create({
      data: {
        clubId: club.id,
        memberId: member.id,
        type: "NOTE",
        message: price <= 0
          ? "No membership price on file — club to confirm billing manually."
          : "Club has no online payments — billing to be set up by the club.",
      },
    });
    return NextResponse.json({
      ok: true,
      noPayment: true,
      message:
        "Your account is activated. Your club will confirm your billing details — you have not been charged.",
    });
  }

  // Find or create the membership plan this continues.
  let membership = await prisma.membership.findFirst({
    where: {
      clubId: club.id,
      deletedAt: null,
      name: { equals: member.legacyMembershipName || "Membership", mode: "insensitive" },
    },
  });
  if (!membership) {
    membership = await prisma.membership.create({
      data: {
        clubId: club.id,
        name: member.legacyMembershipName || "Continued membership",
        options: JSON.stringify([{ label: "Continued", price, billingPeriod: period }]),
      },
    });
  }

  const memberSub = await prisma.memberSubscription.create({
    data: {
      memberId: member.id,
      membershipId: membership.id,
      optionLabel: member.legacyMembershipName || "Continued",
      price,
      billingPeriod: period,
      billingType: "RECURRING",
      autoRenew: true,
      status: "pending",
      startDate: member.membershipStartDate ?? new Date(),
      billingAnchorDate: member.billingAnchorDate,
      notes: `Migrated from ${member.legacySource || "previous software"}`,
    },
  });

  // Re-resolve the anchor at activation so we never bill retroactively.
  const anchor = resolveBillingAnchor({
    nextBillingDate: member.billingAnchorDate,
    membershipStartDate: member.membershipStartDate,
    frequency: period,
    now: new Date(),
  });
  const trialEnd =
    anchor && anchor.getTime() > Date.now() + 60_000 ? Math.floor(anchor.getTime() / 1000) : undefined;

  const amountInCents = Math.round(price * 100);
  const stripeInterval = billingPeriodToStripeInterval(period);
  const appFeePercent = 0;
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3001";
  const recurringAmount = recurringUnitWithFee(amountInCents, club.passProcessingFees);

  const checkout = await stripe.checkout.sessions.create(
    {
      mode: "subscription",
      customer_email: contactEmail,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: recurringAmount,
            product_data: {
              name: `${membership.name} — continued from ${member.legacySource || "previous club"}`,
              ...(club.passProcessingFees ? { description: "Includes processing fee" } : {}),
            },
            ...(stripeInterval ? { recurring: stripeInterval } : { recurring: { interval: "month" } }),
          },
        },
      ],
      success_url: `${baseUrl}/activate/${token}?done=true`,
      cancel_url: `${baseUrl}/activate/${token}?canceled=true`,
      metadata: {
        memberSubscriptionId: memberSub.id,
        memberId: member.id,
        clubId: club.id,
        migrationMemberId: member.id,
      },
      subscription_data: {
        application_fee_percent: appFeePercent,
        metadata: {
          memberSubscriptionId: memberSub.id,
          memberId: member.id,
          clubId: club.id,
          migrationMemberId: member.id,
        },
        // Card is collected now; first charge waits until the member's
        // existing billing date, so service continues without interruption
        // and nobody is charged on import/activation day.
        ...(trialEnd ? { trial_end: trialEnd } : {}),
      },
    },
    { stripeAccount: club.stripeAccountId },
  );

  await prisma.memberSubscription.update({
    where: { id: memberSub.id },
    data: { stripeCheckoutSessionId: checkout.id },
  });

  return NextResponse.json({ ok: true, url: checkout.url });
}
