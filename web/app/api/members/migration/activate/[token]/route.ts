import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { MIGRATION_STATUS, PAYMENT_SETUP } from "@/lib/migration";
import { getAppBaseUrl } from "@/lib/baseUrl";

// NO AUTH — token-gated public activation endpoint.

type EditableFields = { phone: boolean; email: boolean; billingDateRequest: boolean; notes: boolean };
const DEFAULT_EDITABLE: EditableFields = { phone: true, email: false, billingDateRequest: true, notes: true };

function resolveEditable(raw: unknown): EditableFields {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    phone: o.phone === undefined ? DEFAULT_EDITABLE.phone : !!o.phone,
    email: o.email === undefined ? DEFAULT_EDITABLE.email : !!o.email,
    billingDateRequest:
      o.billingDateRequest === undefined ? DEFAULT_EDITABLE.billingDateRequest : !!o.billingDateRequest,
    notes: o.notes === undefined ? DEFAULT_EDITABLE.notes : !!o.notes,
  };
}

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

type LoadedMember = Extract<Awaited<ReturnType<typeof loadByToken>>, { member: unknown }>["member"];

// Resolve the plan this migration continues: owner-assigned Membership first,
// else the legacy snapshot captured at import.
async function resolvePlan(m: LoadedMember) {
  if (m.migrationMembershipId) {
    const plan = await prisma.membership.findFirst({
      where: { id: m.migrationMembershipId, clubId: m.clubId, deletedAt: null },
      select: { id: true, name: true, options: true },
    });
    if (plan) {
      let price: number | null = m.legacyMembershipPrice ? Number(m.legacyMembershipPrice) : null;
      let frequency = m.legacyBillingFrequency || "MONTHLY";
      try {
        const opts = JSON.parse((plan.options as unknown as string) || "[]");
        if (Array.isArray(opts) && opts[0]) {
          if (price == null && typeof opts[0].price === "number") price = opts[0].price;
          if (opts[0].billingPeriod) frequency = opts[0].billingPeriod;
        }
      } catch {
        /* options not JSON — fall back to legacy snapshot */
      }
      return { membershipId: plan.id, name: plan.name, price, frequency };
    }
  }
  return {
    membershipId: null as string | null,
    name: m.legacyMembershipName,
    price: m.legacyMembershipPrice ? Number(m.legacyMembershipPrice) : null,
    frequency: m.legacyBillingFrequency || "MONTHLY",
  };
}

// GET — render data for the activation page.
export async function GET(_req: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const r = await loadByToken(token);
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: 404 });
  const m = r.member;
  const plan = await resolvePlan(m);
  // Owner price override (set before the link was sent) is what the client
  // sees and agrees to.
  if (m.migrationPriceOverride != null) {
    plan.price = Number(m.migrationPriceOverride);
  }

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
    // Card on file & waiting for the club to review/approve billing.
    pendingApproval: m.approvalStatus === "PENDING_APPROVAL",
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
      name: plan.name,
      price: plan.price,
      frequency: plan.frequency,
      nextBillingDate: m.billingAnchorDate ? m.billingAnchorDate.toISOString() : null,
      commitmentEndDate: m.commitmentEndDate ? m.commitmentEndDate.toISOString() : null,
    },
    editable: resolveEditable(m.activationEditableFields),
    paymentEnabled: !!(m.club.stripeAccountId && m.club.stripeChargesEnabled),
    requiredDocument: requiredDoc,
  });
}

const postSchema = z.object({
  password: z.string().min(8),
  phone: z.string().optional().nullable(),
  email: z.string().email().optional().nullable(),
  autopayAccepted: z.literal(true),
  signedDocumentId: z.string().optional().nullable(),
  // Client requests — owner reviews these before billing starts.
  requestedBillingDate: z.string().optional().nullable(),
  requestedBillingNote: z.string().max(500).optional().nullable(),
  activationNote: z.string().max(1000).optional().nullable(),
});

// POST — complete activation: set password, confirm profile, accept autopay,
// optionally sign a waiver, capture billing-date/notes requests, then collect
// a payment method via Stripe SETUP mode. NO charge, NO subscription is
// created here — billing only starts after the owner approves.
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

  const editable = resolveEditable(member.activationEditableFields);
  const newEmail = editable.email && body.email ? body.email.toLowerCase() : null;
  const contactEmail =
    (member.isMinor ? member.guardianEmail || member.email : newEmail || member.email)?.toLowerCase() || null;
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

  const requestedDate = body.requestedBillingDate ? new Date(body.requestedBillingDate) : null;
  const validRequested = requestedDate && !isNaN(requestedDate.getTime()) ? requestedDate : null;

  await prisma.member.update({
    where: { id: member.id },
    data: {
      ...(member.userId ? {} : { userId: user.id }),
      ...(editable.phone && body.phone?.trim() ? { phone: body.phone.trim() } : {}),
      ...(newEmail ? { email: newEmail } : {}),
      ...(editable.billingDateRequest && validRequested ? { requestedBillingDate: validRequested } : {}),
      ...(editable.billingDateRequest && body.requestedBillingNote
        ? { requestedBillingNote: body.requestedBillingNote.trim() }
        : {}),
      ...(editable.notes && body.activationNote ? { activationNote: body.activationNote.trim() } : {}),
      migrationStatus: MIGRATION_STATUS.ACTIVATED,
      activatedAt: new Date(),
      // Goes into the owner's review queue. Billing does NOT begin.
      approvalStatus: "PENDING_APPROVAL",
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
      const sig = {
        signerUserId: user.id,
        signerName: `${member.firstName} ${member.lastName}`.trim(),
        relationship: member.isMinor ? "GUARDIAN" : "SELF",
        ipAddress: ipHeader ? ipHeader.split(",")[0].trim() : null,
        userAgent: req.headers.get("user-agent"),
      };
      await prisma.documentSignature.upsert({
        where: { documentId_memberId: { documentId: doc.id, memberId: member.id } },
        update: { ...sig, signedAt: new Date() },
        create: { documentId: doc.id, memberId: member.id, ...sig },
      });
    }
  }

  await prisma.memberMigrationEvent.create({
    data: {
      clubId: club.id,
      memberId: member.id,
      type: "ACTIVATED",
      message:
        "Account activated, autopay accepted" +
        (validRequested ? ` · client requested billing on ${validRequested.toLocaleDateString()}` : "") +
        (body.activationNote ? " · left a note" : ""),
    },
  });

  // No online payments on the club → activated; owner handles billing manually.
  if (!club.stripeAccountId || !club.stripeChargesEnabled) {
    await prisma.member.update({
      where: { id: member.id },
      data: { paymentSetupStatus: PAYMENT_SETUP.REQUIRED },
    });
    return NextResponse.json({
      ok: true,
      noPayment: true,
      message:
        "Your account is activated. Your club will confirm billing details — you have not been charged.",
    });
  }

  // Collect a payment method WITHOUT charging. A Customer on the connected
  // account holds the saved card so it can be reused when the owner approves.
  const customer = member.stripeSetupCustomerId
    ? { id: member.stripeSetupCustomerId }
    : await stripe.customers.create(
        {
          email: contactEmail,
          name: `${member.firstName} ${member.lastName}`.trim(),
          metadata: { migrationMemberId: member.id, clubId: club.id },
        },
        { stripeAccount: club.stripeAccountId },
      );

  const baseUrl = getAppBaseUrl();
  const checkout = await stripe.checkout.sessions.create(
    {
      mode: "setup",
      customer: customer.id,
      currency: "usd",
      success_url: `${baseUrl}/activate/${token}?done=true`,
      cancel_url: `${baseUrl}/activate/${token}?canceled=true`,
      metadata: {
        migrationMemberId: member.id,
        clubId: club.id,
        setupCustomerId: customer.id,
      },
      setup_intent_data: {
        metadata: { migrationMemberId: member.id, clubId: club.id },
      },
    },
    { stripeAccount: club.stripeAccountId },
  );

  await prisma.member.update({
    where: { id: member.id },
    data: { stripeSetupCustomerId: customer.id, paymentSetupStatus: PAYMENT_SETUP.REQUIRED },
  });

  return NextResponse.json({ ok: true, url: checkout.url });
}
