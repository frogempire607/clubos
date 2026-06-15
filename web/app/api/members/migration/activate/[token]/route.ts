import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { MIGRATION_STATUS, PAYMENT_SETUP } from "@/lib/migration";
import { getAppBaseUrl } from "@/lib/baseUrl";

// NO AUTH — token-gated public activation endpoint.

type EditableFields = {
  phone: boolean; email: boolean; billingDateRequest: boolean; notes: boolean;
  cancellationDate: boolean; paymentChoice: boolean;
};
const DEFAULT_EDITABLE: EditableFields = {
  phone: true, email: false, billingDateRequest: true, notes: true,
  cancellationDate: true, paymentChoice: true,
};

function resolveEditable(raw: unknown): EditableFields {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    phone: o.phone === undefined ? DEFAULT_EDITABLE.phone : !!o.phone,
    email: o.email === undefined ? DEFAULT_EDITABLE.email : !!o.email,
    billingDateRequest:
      o.billingDateRequest === undefined ? DEFAULT_EDITABLE.billingDateRequest : !!o.billingDateRequest,
    notes: o.notes === undefined ? DEFAULT_EDITABLE.notes : !!o.notes,
    cancellationDate:
      o.cancellationDate === undefined ? DEFAULT_EDITABLE.cancellationDate : !!o.cancellationDate,
    paymentChoice: o.paymentChoice === undefined ? DEFAULT_EDITABLE.paymentChoice : !!o.paymentChoice,
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
type PlanOption = { label: string; price: number; billingPeriod: string };

async function resolvePlan(m: LoadedMember) {
  if (m.migrationMembershipId) {
    const plan = await prisma.membership.findFirst({
      where: { id: m.migrationMembershipId, clubId: m.clubId, deletedAt: null },
      select: { id: true, name: true, options: true },
    });
    if (plan) {
      let price: number | null = m.legacyMembershipPrice ? Number(m.legacyMembershipPrice) : null;
      let frequency = m.legacyBillingFrequency || "MONTHLY";
      let options: PlanOption[] = [];
      try {
        const opts = JSON.parse((plan.options as unknown as string) || "[]");
        if (Array.isArray(opts)) {
          options = opts
            .filter((o) => o && typeof o.price === "number")
            .map((o) => ({
              label: String(o.label ?? "Membership"),
              price: Number(o.price),
              billingPeriod: String(o.billingPeriod || "MONTHLY"),
            }));
          if (opts[0]) {
            if (price == null && typeof opts[0].price === "number") price = opts[0].price;
            if (opts[0].billingPeriod) frequency = opts[0].billingPeriod;
          }
        }
      } catch {
        /* options not JSON — fall back to legacy snapshot */
      }
      return { membershipId: plan.id, name: plan.name, price, frequency, options };
    }
  }
  return {
    membershipId: null as string | null,
    name: m.legacyMembershipName,
    price: m.legacyMembershipPrice ? Number(m.legacyMembershipPrice) : null,
    frequency: m.legacyBillingFrequency || "MONTHLY",
    options: [] as PlanOption[],
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
    // #6: owner marked this member already paid through their final period —
    // the page shows "active through end date" and collects no card.
    finalPeriodPaid: m.migrationFinalPeriodPaid,
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
      // Owner-configured options the member may choose from. Suppressed when
      // the owner locked a specific price override (priceLocked).
      options: m.migrationPriceOverride != null ? [] : plan.options,
      priceLocked: m.migrationPriceOverride != null,
      selectedOption: m.migrationSelectedOption ?? null,
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
  autopayAccepted: z.boolean().optional().default(false),
  signedDocumentId: z.string().optional().nullable(),
  // Client requests — owner reviews these before billing starts.
  requestedBillingDate: z.string().optional().nullable(),
  requestedBillingNote: z.string().max(500).optional().nullable(),
  activationNote: z.string().max(1000).optional().nullable(),
  // #5: member-chosen plan option, cancellation date, and payment method.
  requestedCancellationDate: z.string().optional().nullable(),
  selectedOptionLabel: z.string().max(200).optional().nullable(),
  paymentMethod: z.enum(["CARD", "CASH", "CHECK"]).optional().default("CARD"),
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

  // Replay guard. A successful activation sets status to ACTIVATED (NOT
  // COMPLETED), so we must reject BOTH — otherwise the link could be
  // re-POSTed after activation to reset the member's portal password
  // (account takeover). The atomic claim below closes the concurrent race.
  if (
    member.migrationStatus === MIGRATION_STATUS.COMPLETED ||
    member.migrationStatus === MIGRATION_STATUS.ACTIVATED
  ) {
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
  //
  // SECURITY: if a portal User already exists for this email, NEVER overwrite
  // its passwordHash from a migration token — that is the account-takeover
  // vector. An existing user already has a login and the normal reset flow.
  // A password is set ONLY when the account is created for the first time.
  let user = await prisma.user.findUnique({
    where: { clubId_email: { clubId: club.id, email: contactEmail } },
  });
  if (!user) {
    const passwordHash = await bcrypt.hash(body.password, 12);
    try {
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
    } catch {
      // A concurrent request raced us to the unique (clubId, email). Re-fetch
      // and continue WITHOUT touching the existing password.
      user = await prisma.user.findUnique({
        where: { clubId_email: { clubId: club.id, email: contactEmail } },
      });
      if (!user) {
        return NextResponse.json({ error: "Could not complete activation." }, { status: 500 });
      }
    }
  }

  const requestedDate = body.requestedBillingDate ? new Date(body.requestedBillingDate) : null;
  const validRequested = requestedDate && !isNaN(requestedDate.getTime()) ? requestedDate : null;

  // #6: a member the owner marked as already paid through their final period
  // collects no card and creates no subscription — they just activate.
  const finalPaid = !!member.migrationFinalPeriodPaid;

  // #5: how the member chose to pay. CASH/CHECK collect no card and send the
  // whole registration to the owner to approve. CARD keeps the secure redirect.
  const method = finalPaid ? "CARD" : body.paymentMethod;

  // The connected account we collect the card on — null when the club hasn't
  // finished Stripe onboarding (the owner then bills manually).
  const stripeAccount = club.stripeChargesEnabled ? club.stripeAccountId : null;
  // Collect a card only for the CARD method on a Stripe-enabled club, and never
  // for a fully-paid final period.
  const collectCard = !finalPaid && method === "CARD" && !!stripeAccount;

  // Autopay consent is only meaningful for card billing. Cash/check and
  // fully-paid members aren't on autopay.
  if (method === "CARD" && !finalPaid && !body.autopayAccepted) {
    return NextResponse.json(
      { error: "You must accept the autopay terms to continue." },
      { status: 400 },
    );
  }

  // #5: member's requested cancellation/end date (owner reviews on approval).
  const cancelDate = body.requestedCancellationDate ? new Date(body.requestedCancellationDate) : null;
  const validCancel =
    !finalPaid && editable.cancellationDate && cancelDate && !isNaN(cancelDate.getTime())
      ? cancelDate
      : null;

  // #5: validate the member's chosen plan option against the REAL options on
  // the assigned membership — never trust a client-sent price. Skipped when the
  // owner locked a specific price override.
  let selectedOption: { label: string; price: number; billingPeriod: string } | null = null;
  if (
    !finalPaid &&
    body.selectedOptionLabel &&
    member.migrationPriceOverride == null &&
    member.migrationMembershipId
  ) {
    const plan = await prisma.membership.findFirst({
      where: { id: member.migrationMembershipId, clubId: club.id, deletedAt: null },
      select: { options: true },
    });
    if (plan) {
      try {
        const opts = JSON.parse((plan.options as unknown as string) || "[]");
        const match = Array.isArray(opts)
          ? opts.find(
              (o) =>
                o && String(o.label ?? "") === body.selectedOptionLabel && typeof o.price === "number",
            )
          : null;
        if (match) {
          selectedOption = {
            label: String(match.label ?? "Membership"),
            price: Number(match.price),
            billingPeriod: String(match.billingPeriod || "MONTHLY"),
          };
        }
      } catch {
        /* options not JSON — leave unselected */
      }
    }
  }

  // Set up the Stripe Customer + SETUP-mode Checkout session BEFORE we mutate
  // any membership state. If Stripe fails we return a clean error and the
  // member row is untouched, so the member can simply retry.
  //
  // Why ordering matters: the old code flipped migrationStatus to ACTIVATED
  // first and only THEN called Stripe. An unguarded Stripe error (restricted
  // connected account, transient API failure, …) threw an opaque 500 the page
  // rendered as the generic "Could not complete activation." — and because the
  // status was already ACTIVATED, the replay guard above then rejected every
  // retry with "This membership is already active," stranding the member with
  // no card on file. Doing Stripe first closes that trap.
  let checkoutUrl: string | null = null;
  let setupCustomerId: string | null = member.stripeSetupCustomerId ?? null;
  if (collectCard && stripeAccount) {
    try {
      const customer = member.stripeSetupCustomerId
        ? { id: member.stripeSetupCustomerId }
        : await stripe.customers.create(
            {
              email: contactEmail,
              name: `${member.firstName} ${member.lastName}`.trim(),
              metadata: { migrationMemberId: member.id, clubId: club.id },
            },
            { stripeAccount },
          );
      setupCustomerId = customer.id;

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
        { stripeAccount },
      );
      checkoutUrl = checkout.url;
    } catch (err) {
      console.error("[activate] Stripe setup failed", err);
      return NextResponse.json(
        { error: "We couldn't open the secure payment step. Please try again in a moment." },
        { status: 502 },
      );
    }
  }

  // Atomically claim the activation — only AFTER any Stripe work above
  // succeeded, so a payment failure never flips the status. Only a member
  // still in a pre-active state can be flipped to ACTIVATED; a concurrent or
  // replayed POST updates 0 rows and 409s below, so profile/password side
  // effects can't be re-applied by a second request even under a race.
  const claimed = await prisma.member.updateMany({
    where: {
      id: member.id,
      migrationStatus: { notIn: [MIGRATION_STATUS.ACTIVATED, MIGRATION_STATUS.COMPLETED] },
    },
    data: {
      ...(member.userId ? {} : { userId: user.id }),
      ...(editable.phone && body.phone?.trim() ? { phone: body.phone.trim() } : {}),
      ...(newEmail ? { email: newEmail } : {}),
      ...(editable.billingDateRequest && validRequested ? { requestedBillingDate: validRequested } : {}),
      ...(editable.billingDateRequest && body.requestedBillingNote
        ? { requestedBillingNote: body.requestedBillingNote.trim() }
        : {}),
      ...(editable.notes && body.activationNote ? { activationNote: body.activationNote.trim() } : {}),
      ...(validCancel ? { requestedCancellationDate: validCancel } : {}),
      ...(selectedOption ? { migrationSelectedOption: selectedOption } : {}),
      ...(setupCustomerId ? { stripeSetupCustomerId: setupCustomerId } : {}),
      ...(finalPaid ? {} : { requestedPaymentMethod: method }),
      paymentSetupStatus: collectCard ? PAYMENT_SETUP.REQUIRED : null,
      activatedAt: new Date(),
      // #6 fully-paid: complete now as a non-renewing membership (nothing to
      // approve, no subscription). Otherwise it enters the owner's review
      // queue and billing does NOT begin until they approve.
      ...(finalPaid
        ? {
            migrationStatus: MIGRATION_STATUS.COMPLETED,
            migrationCompletedAt: new Date(),
            status: "ACTIVE",
            approvalStatus: "APPROVED",
          }
        : {
            migrationStatus: MIGRATION_STATUS.ACTIVATED,
            approvalStatus: "PENDING_APPROVAL",
          }),
    },
  });
  if (claimed.count === 0) {
    return NextResponse.json({ error: "This membership is already active." }, { status: 409 });
  }

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
      type: finalPaid ? "COMPLETED" : "ACTIVATED",
      message: finalPaid
        ? "Activated — final period already paid; no further billing. Membership ends on the commitment date."
        : "Account activated" +
          (collectCard
            ? ", autopay accepted"
            : method === "CASH"
              ? " — paying by cash (awaiting club approval)"
              : method === "CHECK"
                ? " — paying by check (awaiting club approval)"
                : "") +
          (selectedOption ? ` · chose “${selectedOption.label}”` : "") +
          (validRequested ? ` · requested billing on ${validRequested.toLocaleDateString()}` : "") +
          (validCancel ? ` · requested end on ${validCancel.toLocaleDateString()}` : "") +
          (body.activationNote ? " · left a note" : ""),
    },
  });

  // #6 fully-paid final period: activated, nothing due, no subscription.
  if (finalPaid) {
    const endStr = member.commitmentEndDate
      ? new Date(member.commitmentEndDate).toLocaleDateString()
      : null;
    return NextResponse.json({
      ok: true,
      finalPeriod: true,
      message: endStr
        ? `You're all set — your membership is active through ${endStr}. Nothing is due.`
        : "You're all set — your membership is active. Nothing is due.",
    });
  }

  // Card path: collection happens on the Stripe-hosted SETUP page prepared
  // above (before any state was mutated), so a Stripe failure can never strand
  // the member mid-activation.
  if (collectCard) {
    return NextResponse.json({ ok: true, url: checkoutUrl });
  }

  // Cash/check (or a club with no online payments) → activated; the owner
  // confirms payment and approves. No charge, no card collected.
  return NextResponse.json({
    ok: true,
    noPayment: true,
    message:
      method === "CASH" || method === "CHECK"
        ? `Your account is activated. ${club.name} will confirm your ${method.toLowerCase()} payment and approve your membership — you have not been charged.`
        : "Your account is activated. Your club will confirm billing details — you have not been charged.",
  });
}
