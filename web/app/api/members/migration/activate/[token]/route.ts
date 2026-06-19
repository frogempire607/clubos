import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { MIGRATION_STATUS, PAYMENT_SETUP } from "@/lib/migration";
import { getAppBaseUrl } from "@/lib/baseUrl";
import { publicClubLogoUrl } from "@/lib/clubLogo";

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

  // Documents that must be signed during onboarding — the legacy `required`
  // flag OR the explicit ONBOARDING surface (Document.requiredAt). All of them
  // are returned so the page can render and require each one.
  const onboardingDocs = await prisma.document.findMany({
    where: {
      clubId: m.clubId,
      deletedAt: null,
      OR: [{ required: true }, { requiredAt: { has: "ONBOARDING" } }],
      AND: [{ OR: [{ publishAt: null }, { publishAt: { lte: new Date() } }] }],
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, title: true, body: true },
  });
  const requiredDoc = onboardingDocs[0] ?? null;

  // Does a portal account already exist for the contact (e.g. a guardian
  // activating a second child)? If so the activation page skips the
  // "create a password" step — the existing password is never overwritten.
  const checkEmail =
    (m.isMinor ? m.guardianEmail || m.email : m.email || m.guardianEmail)?.toLowerCase() || null;
  // A SOFT-DELETED login does NOT count as an existing account. It can't sign
  // in (NextAuth rejects users with deletedAt) and must be resurrected with a
  // fresh password during activation. Treating it as "has account" would hide
  // the password field and strand the member with no working credentials —
  // exactly the "onboarding completes but login says invalid password" bug.
  const existingActivationUser = checkEmail
    ? await prisma.user.findUnique({
        where: { clubId_email: { clubId: m.clubId, email: checkEmail } },
        select: { deletedAt: true },
      })
    : null;
  const hasAccount = !!(existingActivationUser && !existingActivationUser.deletedAt);

  // FAMILY ONBOARDING. When a guardian manages this minor (their guardian email
  // is the contact), surface the guardian's OTHER pending children so the
  // parent can set them all up in one flow — entering their account once and
  // (optionally) reusing one card across the family.
  const guardianEmailLc = m.guardianEmail?.toLowerCase() || null;
  const isGuardianManaged = m.isMinor && !!guardianEmailLc && checkEmail === guardianEmailLc;
  type FamilyMember = {
    id: string; firstName: string; lastName: string;
    token: string | null; done: boolean; current: boolean;
  };
  let family: FamilyMember[] = [];
  let familyCardOnFile = false;
  if (isGuardianManaged && guardianEmailLc) {
    const siblings = await prisma.member.findMany({
      where: {
        clubId: m.clubId,
        deletedAt: null,
        isMinor: true,
        guardianEmail: { equals: guardianEmailLc, mode: "insensitive" },
        activationKind: { not: "JOIN" },
      },
      orderBy: { createdAt: "asc" },
      select: {
        id: true, firstName: true, lastName: true,
        activationToken: true, activationTokenExpires: true,
        migrationStatus: true, stripeSetupCustomerId: true, stripeSetupPaymentMethodId: true,
      },
    });
    if (siblings.length > 1) {
      const nowMs = Date.now();
      family = siblings.map((s) => {
        const done =
          s.migrationStatus === MIGRATION_STATUS.ACTIVATED ||
          s.migrationStatus === MIGRATION_STATUS.COMPLETED;
        const tokenValid =
          !!s.activationToken &&
          (!s.activationTokenExpires || s.activationTokenExpires.getTime() > nowMs);
        return {
          id: s.id,
          firstName: s.firstName,
          lastName: s.lastName,
          // Only expose a sibling's token (so the parent can continue to it)
          // while it's still pending — never for one that's already done.
          token: !done && tokenValid ? s.activationToken : null,
          done,
          current: s.id === m.id,
        };
      });
      familyCardOnFile = siblings.some(
        (s) => s.id !== m.id && !!s.stripeSetupCustomerId && !!s.stripeSetupPaymentMethodId,
      );
    }
  }

  return NextResponse.json({
    completed: m.migrationStatus === MIGRATION_STATUS.COMPLETED,
    hasAccount,
    accountEmail: checkEmail,
    // Card on file & waiting for the club to review/approve billing.
    pendingApproval: m.approvalStatus === "PENDING_APPROVAL",
    // #6: owner marked this member already paid through their final period —
    // the page shows "active through end date" and collects no card.
    finalPeriodPaid: m.migrationFinalPeriodPaid,
    // #7: JOIN = a non-member free-join link (create a free account, browse options).
    kind: m.activationKind,
    joined: m.activationKind === "JOIN" && !!m.activatedAt,
    member: {
      firstName: m.firstName,
      lastName: m.lastName,
      email: m.email,
      phone: m.phone,
      isMinor: m.isMinor,
      guardianName: m.guardianName,
      guardianEmail: m.guardianEmail,
    },
    club: { name: m.club.name, slug: m.club.slug, logoUrl: publicClubLogoUrl(m.clubId, m.club.logoUrl), primaryColor: m.club.primaryColor },
    membership: {
      name: plan.name,
      price: plan.price,
      frequency: plan.frequency,
      // Owner-configured options the member may choose from. Suppressed when
      // the owner locked a specific price override (priceLocked).
      options: m.migrationPriceOverride != null ? [] : plan.options,
      priceLocked: m.migrationPriceOverride != null,
      selectedOption: m.migrationSelectedOption ?? null,
      // #5 v2: the member's imported/grandfathered rate — shown as the default
      // "continue at your current rate" choice. Null when the owner locked a
      // price override (that override is then the single price shown).
      currentRate:
        m.migrationPriceOverride == null && m.legacyMembershipPrice != null
          ? { price: Number(m.legacyMembershipPrice), billingPeriod: m.legacyBillingFrequency || "MONTHLY" }
          : null,
      nextBillingDate: m.billingAnchorDate ? m.billingAnchorDate.toISOString() : null,
      commitmentEndDate: m.commitmentEndDate ? m.commitmentEndDate.toISOString() : null,
    },
    editable: resolveEditable(m.activationEditableFields),
    paymentEnabled: !!(m.club.stripeAccountId && m.club.stripeChargesEnabled),
    requiredDocument: requiredDoc,
    requiredDocuments: onboardingDocs,
    family,
    familyCardOnFile,
  });
}

const postSchema = z.object({
  // Optional: only required when creating a NEW account. An existing account
  // (e.g. a guardian activating a second child) keeps its current password.
  password: z.string().min(8).optional(),
  phone: z.string().optional().nullable(),
  email: z.string().email().optional().nullable(),
  autopayAccepted: z.boolean().optional().default(false),
  signedDocumentId: z.string().optional().nullable(),
  // Multiple onboarding documents can be required; the page sends every id it
  // showed. signedDocumentId (singular) is kept for backward compatibility.
  signedDocumentIds: z.array(z.string()).optional(),
  // Family flow: reuse the card a sibling already saved instead of re-entering.
  reuseFamilyCard: z.boolean().optional(),
  // Client requests — owner reviews these before billing starts.
  requestedBillingDate: z.string().optional().nullable(),
  requestedBillingNote: z.string().max(500).optional().nullable(),
  activationNote: z.string().max(1000).optional().nullable(),
  // #5: member-chosen plan option, cancellation date, and payment method.
  requestedCancellationDate: z.string().optional().nullable(),
  selectedOptionLabel: z.string().max(200).optional().nullable(),
  paymentMethod: z.enum(["CARD", "CASH", "CHECK"]).optional().default("CARD"),
  // #5 v2: continue at the member's imported/grandfathered rate.
  useCurrentRate: z.boolean().optional(),
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
  // #7: a non-member JOIN link that's already been used.
  if (member.activationKind === "JOIN" && member.activatedAt) {
    return NextResponse.json({ error: "Your account is already set up — just sign in." }, { status: 409 });
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

  // GUARDIAN-MANAGED vs OWN LOGIN.
  // When a minor's contact is the GUARDIAN's email, the account we create/find
  // belongs to the GUARDIAN — and the guardian reaches the minor through the
  // guardian-link system (MemberGuardianUser), NOT the minor's member.userId.
  // (member.userId is a member's OWN login; pointing a minor's userId at the
  // guardian inverts parental controls and — because userId is unique — makes a
  // second child invisible.) A minor with only their OWN email, or any
  // non-minor, instead gets their own login via member.userId.
  const guardianManaged =
    member.isMinor &&
    !!member.guardianEmail &&
    contactEmail === member.guardianEmail.toLowerCase();

  // When creating the guardian's account, name it after the guardian, not the
  // child. Falls back to the member's name if no guardian name is on file.
  const guardianNameParts = (member.guardianName?.trim() || "").split(/\s+/).filter(Boolean);
  const accountFirstName = guardianManaged ? guardianNameParts[0] || member.firstName : member.firstName;
  const accountLastName = guardianManaged
    ? guardianNameParts.slice(1).join(" ") || member.lastName
    : member.lastName;

  // Create or link the portal User account.
  //
  // SECURITY: if a portal User already exists for this email, NEVER overwrite
  // its passwordHash from a migration token — that is the account-takeover
  // vector. An existing user already has a login and the normal reset flow.
  // A password is set ONLY when the account is created for the first time.
  let user = await prisma.user.findUnique({
    where: { clubId_email: { clubId: club.id, email: contactEmail } },
  });
  if (user && user.deletedAt) {
    // RESURRECT a soft-deleted login. This happens when a member is deleted
    // (which soft-deletes their MEMBER-role login, leaving deletedAt set) and is
    // later re-imported and re-onboarded with the same email. The (clubId,email)
    // unique index is GLOBAL — it ignores deletedAt — so the dead row still
    // reserves the slot and we cannot create a fresh user; we must revive this
    // one. A soft-deleted user has NO active credentials and the owner issued
    // this activation token, so setting a new password and clearing deletedAt is
    // authorized. (The account-takeover guard only protects LIVE accounts.)
    // Without this, activation silently skipped the password — the new password
    // was never stored and login stayed blocked by the deletedAt flag, i.e. the
    // "onboarding completes but login says invalid password" bug.
    if (!body.password) {
      return NextResponse.json(
        { error: "Choose a password (at least 8 characters) to create your account." },
        { status: 400 },
      );
    }
    const passwordHash = await bcrypt.hash(body.password, 12);
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        deletedAt: null,
        firstName: accountFirstName,
        lastName: accountLastName,
        role: "MEMBER",
        resetToken: null,
        resetExpires: null,
      },
    });
  } else if (!user) {
    if (!body.password) {
      return NextResponse.json(
        { error: "Choose a password (at least 8 characters) to create your account." },
        { status: 400 },
      );
    }
    const passwordHash = await bcrypt.hash(body.password, 12);
    try {
      user = await prisma.user.create({
        data: {
          clubId: club.id,
          email: contactEmail,
          passwordHash,
          firstName: accountFirstName,
          lastName: accountLastName,
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

  // Decide whether to link this user as the member's OWN login (member.userId).
  // Guardian-managed minors never do — they're reached via the guardian link
  // created after activation, leaving member.userId free for a future child
  // login. Only own-login members (non-minors, or a minor using their own
  // email) link userId.
  let canLinkUser = false;
  if (!guardianManaged) {
    // The members_userId unique index is GLOBAL — it ignores deletedAt. So a
    // SOFT-DELETED member that still holds this userId silently reserves the
    // slot and makes the claim below 500 with "duplicate key value violates
    // unique constraint members_userId_key" (surfaced as the generic "Could not
    // complete activation."). Happens after a member is deleted and re-imported.
    // A deleted row never needs its login link, so release dead holders first.
    await prisma.member.updateMany({
      where: { userId: user.id, deletedAt: { not: null } },
      data: { userId: null },
    });

    // A User can be the login for only ONE *live* Member. Skip the link when
    // this user already belongs to another live member.
    canLinkUser =
      !member.userId &&
      !(await prisma.member.findFirst({
        where: { userId: user.id, deletedAt: null, id: { not: member.id } },
        select: { id: true },
      }));
  }

  // Owner-vouched guardian link: the owner put guardianEmail on file and the
  // guardian is activating with that exact email, so granting guardian access
  // to this minor is authorized (mirrors lib/guardianLink isOwnerVouched). This
  // is what makes the minor show up under the guardian's account.
  async function linkGuardianIfManaged() {
    if (!guardianManaged) return;
    await prisma.memberGuardianUser.upsert({
      where: { userId_memberId: { userId: user!.id, memberId: member.id } },
      update: {},
      create: {
        userId: user!.id,
        memberId: member.id,
        relationship: member.guardianRelationship || "GUARDIAN",
      },
    });
  }

  // #7: free-join (non-member). Create + link the portal account, mark
  // activated. No membership, no billing; their member status is unchanged.
  // They can then sign in and browse/buy the club's options.
  if (member.activationKind === "JOIN") {
    await prisma.member.update({
      where: { id: member.id },
      data: {
        ...(canLinkUser ? { userId: user.id } : {}),
        ...(editable.phone && body.phone?.trim() ? { phone: body.phone.trim() } : {}),
        ...(newEmail ? { email: newEmail } : {}),
        activatedAt: new Date(),
      },
    });
    await linkGuardianIfManaged();
    await prisma.memberMigrationEvent.create({
      data: {
        clubId: club.id,
        memberId: member.id,
        type: "JOINED",
        message: "Created a free account via registration link",
      },
    });
    return NextResponse.json({
      ok: true,
      joined: true,
      message: `You're in! Your ${club.name} account is ready — sign in to explore memberships, classes, and events.`,
    });
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

  // FAMILY "one card on file": when the guardian already saved a card while
  // activating a sibling, reuse that exact customer + payment method for this
  // child instead of sending the parent through Stripe card entry again.
  let reusedCustomerId: string | null = null;
  let reusedPaymentMethodId: string | null = null;
  if (collectCard && guardianManaged && body.reuseFamilyCard && member.guardianEmail) {
    const sib = await prisma.member.findFirst({
      where: {
        clubId: club.id,
        deletedAt: null,
        isMinor: true,
        guardianEmail: { equals: member.guardianEmail.toLowerCase(), mode: "insensitive" },
        id: { not: member.id },
        stripeSetupCustomerId: { not: null },
        stripeSetupPaymentMethodId: { not: null },
      },
      select: { stripeSetupCustomerId: true, stripeSetupPaymentMethodId: true },
    });
    if (sib?.stripeSetupCustomerId && sib?.stripeSetupPaymentMethodId) {
      reusedCustomerId = sib.stripeSetupCustomerId;
      reusedPaymentMethodId = sib.stripeSetupPaymentMethodId;
    }
  }
  const reuseFamilyCard = !!reusedCustomerId && !!reusedPaymentMethodId;
  // Open a new Stripe SETUP redirect only when collecting a fresh card.
  const collectCardNow = collectCard && !reuseFamilyCard;

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
    body.useCurrentRate &&
    member.migrationPriceOverride == null &&
    member.legacyMembershipPrice != null
  ) {
    // #5 v2: continue at the imported rate. Price comes from the server's
    // legacy snapshot — never a client-sent number.
    selectedOption = {
      label: "Current rate",
      price: Number(member.legacyMembershipPrice),
      billingPeriod: member.legacyBillingFrequency || "MONTHLY",
    };
  } else if (
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
  if (collectCardNow && stripeAccount) {
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
      ...(canLinkUser ? { userId: user.id } : {}),
      ...(editable.phone && body.phone?.trim() ? { phone: body.phone.trim() } : {}),
      ...(newEmail ? { email: newEmail } : {}),
      ...(editable.billingDateRequest && validRequested ? { requestedBillingDate: validRequested } : {}),
      ...(editable.billingDateRequest && body.requestedBillingNote
        ? { requestedBillingNote: body.requestedBillingNote.trim() }
        : {}),
      ...(editable.notes && body.activationNote ? { activationNote: body.activationNote.trim() } : {}),
      ...(validCancel ? { requestedCancellationDate: validCancel } : {}),
      ...(selectedOption ? { migrationSelectedOption: selectedOption } : {}),
      ...(reuseFamilyCard
        ? { stripeSetupCustomerId: reusedCustomerId, stripeSetupPaymentMethodId: reusedPaymentMethodId }
        : setupCustomerId
          ? { stripeSetupCustomerId: setupCustomerId }
          : {}),
      ...(finalPaid ? {} : { requestedPaymentMethod: method }),
      paymentSetupStatus: collectCardNow || reuseFamilyCard ? PAYMENT_SETUP.REQUIRED : null,
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

  // Grant the guardian access to this minor (no-op for own-login members).
  await linkGuardianIfManaged();

  // Required-document signatures (one or many). Record one signature row per
  // acknowledged document, attributed to the signer (guardian for a minor).
  const docIdsToSign = Array.from(
    new Set([
      ...(body.signedDocumentIds ?? []),
      ...(body.signedDocumentId ? [body.signedDocumentId] : []),
    ]),
  );
  if (docIdsToSign.length > 0) {
    const validDocs = await prisma.document.findMany({
      where: { id: { in: docIdsToSign }, clubId: club.id, deletedAt: null },
      select: { id: true },
    });
    const ipHeader = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip");
    const sig = {
      signerUserId: user.id,
      signerName: `${member.firstName} ${member.lastName}`.trim(),
      relationship: member.isMinor ? "GUARDIAN" : "SELF",
      ipAddress: ipHeader ? ipHeader.split(",")[0].trim() : null,
      userAgent: req.headers.get("user-agent"),
    };
    for (const doc of validDocs) {
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
  if (collectCardNow) {
    return NextResponse.json({ ok: true, url: checkoutUrl });
  }

  // Cash/check, a reused family card, or a club with no online payments →
  // activated; the owner confirms payment and approves. No charge here.
  return NextResponse.json({
    ok: true,
    noPayment: true,
    message: reuseFamilyCard
      ? `Activated using the card already on file for your family — no need to re-enter it. ${club.name} will review and confirm billing; you have not been charged.`
      : method === "CASH" || method === "CHECK"
        ? `Your account is activated. ${club.name} will confirm your ${method.toLowerCase()} payment and approve your membership — you have not been charged.`
        : "Your account is activated. Your club will confirm billing details — you have not been charged.",
  });
}
