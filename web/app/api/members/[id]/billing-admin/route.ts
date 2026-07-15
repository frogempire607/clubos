import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { stripe } from "@/lib/stripe";
import { baseUrlFromRequest } from "@/lib/baseUrl";
import {
  deriveBillingState,
  deriveReadiness,
  chargeTiming,
  resolveOfferPricing,
  pmRef,
  prettyPeriod,
  BILLING_STATE_META,
  READINESS_LABELS,
  MIGRATION_GROUPS,
  FINAL_ACTIONS,
} from "@/lib/billingAdmin";
import { writeBillingAudit } from "@/lib/billingAudit";
import { feeBreakdown, describeProcessingFee } from "@/lib/fees";
import { reactivationUrl, parseOffer, compareOfferToCurrent } from "@/lib/reactivation";

export const dynamic = "force-dynamic";

// The billing control center's data + edit endpoint for ONE athlete.
//
//   GET   — everything an authorized owner/staffer needs to see (billing:view).
//   PATCH — corrections to plan/option/price/dates/payer/triage (billing:full
//           for money fields; members:edit suffices for the triage-only
//           fields). `preview: true` returns a before/after diff WITHOUT
//           writing — the UI shows it and re-submits with preview off.
//
// No raw Stripe ids (customer / payment-method / subscription) leave this
// route; payment methods are identified by an opaque server-side ref.

const LIVE_STRIPE = new Set(["active", "trialing", "past_due", "unpaid"]);

type PaymentMethodView = {
  ref: string;
  type: "card" | "link";
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  cardholder: string | null;
  linkEmail: string | null;
  isDefault: boolean;
  customerRole: "SETUP" | "LEGACY";
  customerName: string | null;
  customerEmail: string | null;
  backsLiveSubscription: boolean;
  isCapturedForActivation: boolean;
};

async function listCustomerPaymentMethods(
  customerId: string,
  stripeAccount: string,
  role: "SETUP" | "LEGACY",
  capturedPmId: string | null,
): Promise<{ methods: PaymentMethodView[]; liveSubCount: number }> {
  const customer = await stripe.customers.retrieve(customerId, { stripeAccount });
  if (!customer || ("deleted" in customer && customer.deleted)) return { methods: [], liveSubCount: 0 };
  const def = (customer as { invoice_settings?: { default_payment_method?: string | { id: string } | null } })
    .invoice_settings?.default_payment_method;
  const defaultPmId = typeof def === "string" ? def : def?.id ?? null;
  const custName = (customer as { name?: string | null }).name ?? null;
  const custEmail = (customer as { email?: string | null }).email ?? null;

  const [cards, links, subs] = await Promise.all([
    stripe.paymentMethods.list({ customer: customerId, type: "card", limit: 20 }, { stripeAccount }),
    stripe.paymentMethods.list({ customer: customerId, type: "link", limit: 20 }, { stripeAccount }).catch(() => ({ data: [] as never[] })),
    stripe.subscriptions.list({ customer: customerId, status: "all", limit: 20 }, { stripeAccount }),
  ]);

  const liveSubs = subs.data.filter((s) => LIVE_STRIPE.has(s.status));
  const liveDefaultPmIds = new Set<string>();
  for (const s of liveSubs) {
    const pm = typeof s.default_payment_method === "string" ? s.default_payment_method : s.default_payment_method?.id;
    // A live sub with no explicit default charges the customer default.
    liveDefaultPmIds.add(pm || defaultPmId || "");
  }

  const methods: PaymentMethodView[] = [];
  for (const pm of [...cards.data, ...links.data]) {
    methods.push({
      ref: pmRef(pm.id),
      type: pm.type === "link" ? "link" : "card",
      brand: pm.card?.brand ?? (pm.type === "link" ? "link" : null),
      last4: pm.card?.last4 ?? null,
      expMonth: pm.card?.exp_month ?? null,
      expYear: pm.card?.exp_year ?? null,
      cardholder: pm.billing_details?.name ?? null,
      linkEmail: pm.type === "link" ? ((pm as { link?: { email?: string | null } }).link?.email ?? null) : null,
      isDefault: pm.id === defaultPmId,
      customerRole: role,
      customerName: custName,
      customerEmail: custEmail,
      backsLiveSubscription: liveDefaultPmIds.has(pm.id),
      isCapturedForActivation: !!capturedPmId && pm.id === capturedPmId,
    });
  }
  return { methods, liveSubCount: liveSubs.length };
}

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "billing", "view");
  if (denied) return denied;

  const member = await prisma.member.findFirst({
    where: { id, clubId: session.user.clubId, deletedAt: null },
    include: {
      club: {
        select: {
          id: true, name: true, stripeAccountId: true, stripeChargesEnabled: true, passProcessingFees: true,
        },
      },
      membership: { select: { id: true, name: true } },
      subscriptions: { orderBy: { createdAt: "desc" } },
      guardianLinks: {
        include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
      },
    },
  });
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const club = member.club;

  // ── Plan / pricing resolution (same precedence as approval) ────────────
  const plan = member.migrationMembershipId
    ? await prisma.membership.findFirst({
        where: { id: member.migrationMembershipId, clubId: club.id, deletedAt: null },
        select: { id: true, name: true, options: true },
      })
    : null;
  const pricing = resolveOfferPricing(
    {
      legacyMembershipName: member.legacyMembershipName,
      legacyMembershipPrice: member.legacyMembershipPrice as unknown as string | null,
      legacyBillingFrequency: member.legacyBillingFrequency,
      migrationSelectedOption: member.migrationSelectedOption,
      migrationPriceOverride: member.migrationPriceOverride as unknown as string | null,
    },
    plan ? { name: plan.name, options: plan.options } : null,
  );

  // ── Subscriptions (cached Stripe snapshots — no live calls here) ───────
  const subs = member.subscriptions.map((s) => {
    const snap = (s.stripeSnapshot ?? null) as {
      defaultPaymentMethod?: { brand?: string; last4?: string } | null;
      latestInvoice?: { amountPaid?: number; paidAt?: string; status?: string } | null;
      cancelAt?: string | null;
    } | null;
    return {
      id: s.id,
      optionLabel: s.optionLabel,
      price: Number(s.price),
      billingPeriod: s.billingPeriod,
      billingType: s.billingType,
      status: s.status,
      stripeStatus: s.stripeStatus,
      hasStripe: !!s.stripeSubscriptionId,
      startDate: s.startDate,
      endDate: s.endDate,
      billingAnchorDate: s.billingAnchorDate,
      currentPeriodEnd: s.currentPeriodEnd,
      cancelAt: snap?.cancelAt ?? null,
      card: snap?.defaultPaymentMethod ?? null,
      lastPayment: snap?.latestInvoice?.paidAt
        ? { amount: (snap.latestInvoice.amountPaid ?? 0) / 100, at: snap.latestInvoice.paidAt }
        : null,
      notes: s.notes,
      autoRenew: s.autoRenew,
      createdAt: s.createdAt,
    };
  });
  const activeSub =
    subs.find((s) => s.status === "active") ??
    subs.find((s) => s.status === "pending") ??
    subs.find((s) => s.status === "past_due") ??
    null;
  const hasLiveStripeSub = subs.some(
    (s) => s.hasStripe && (s.status === "active" || s.status === "past_due") &&
      (!s.stripeStatus || LIVE_STRIPE.has(s.stripeStatus)),
  );

  // ── Payment methods (live read, both customers, graceful degrade) ──────
  let paymentMethods: PaymentMethodView[] = [];
  let stripeReadError = false;
  if (club.stripeAccountId) {
    try {
      const seen = new Set<string>();
      const customers: { id: string; role: "SETUP" | "LEGACY" }[] = [];
      if (member.stripeSetupCustomerId) customers.push({ id: member.stripeSetupCustomerId, role: "SETUP" });
      if (member.stripeCustomerId && member.stripeCustomerId !== member.stripeSetupCustomerId) {
        customers.push({ id: member.stripeCustomerId, role: "LEGACY" });
      }
      for (const c of customers) {
        const { methods } = await listCustomerPaymentMethods(
          c.id, club.stripeAccountId, c.role, member.stripeSetupPaymentMethodId,
        );
        for (const m of methods) {
          const key = `${m.type}:${m.brand}:${m.last4}:${m.expMonth}:${m.expYear}:${m.ref}`;
          if (!seen.has(key)) { seen.add(key); paymentMethods.push(m); }
        }
      }
    } catch (e) {
      console.error("billing-admin: Stripe payment-method read failed", e);
      stripeReadError = true;
      paymentMethods = [];
    }
  }

  // ── Guardians & payer ───────────────────────────────────────────────────
  const guardians = member.guardianLinks.map((l) => ({
    userId: l.user.id,
    name: `${l.user.firstName} ${l.user.lastName}`.trim(),
    email: l.user.email,
    relationship: l.relationship,
    isPayer: member.responsiblePayerUserId === l.user.id,
  }));
  let payer: { userId: string; name: string; email: string } | null = null;
  if (member.responsiblePayerUserId) {
    const u = await prisma.user.findUnique({
      where: { id: member.responsiblePayerUserId },
      select: { id: true, firstName: true, lastName: true, email: true },
    });
    if (u) payer = { userId: u.id, name: `${u.firstName} ${u.lastName}`.trim(), email: u.email };
  }

  // ── Reactivation offer status + synchronization ─────────────────────────
  const reactivation = await prisma.membershipReactivation.findFirst({
    where: { memberId: member.id, clubId: club.id },
    orderBy: { createdAt: "desc" },
  });
  const offerOpen =
    !!reactivation &&
    (reactivation.status === "DRAFT" || reactivation.status === "SENT") &&
    reactivation.tokenExpires > new Date();
  // An offer is an IMMUTABLE snapshot — billing edits after send never change
  // what the token represents. Instead we rebuild the current setup and diff:
  // a mismatch marks the offer "out of date" here and BLOCKS confirmation.
  let offerSync: { matches: boolean; changed: string[] } | null = null;
  if (offerOpen) {
    const stored = parseOffer(reactivation!.offer);
    if (stored) {
      const cmp = await compareOfferToCurrent(member, club, stored);
      offerSync = { matches: cmp.matches, changed: cmp.changed };
    } else {
      offerSync = { matches: false, changed: ["offer snapshot unreadable"] };
    }
  }

  // ── State / readiness / timing derivations ─────────────────────────────
  const offlineIntended =
    !club.stripeAccountId || !club.stripeChargesEnabled ||
    member.requestedPaymentMethod === "CASH" || member.requestedPaymentMethod === "CHECK";
  const hasConfiguredPrice =
    !!plan || !!member.migrationSelectedOption || member.migrationPriceOverride != null || member.legacyMembershipPrice != null;
  const billingState = deriveBillingState({
    sub: activeSub
      ? {
          billingType: activeSub.billingType,
          status: activeSub.status,
          stripeStatus: activeSub.stripeStatus,
          price: activeSub.price,
          hasStripe: activeSub.hasStripe,
        }
      : null,
    configuredPrice: hasConfiguredPrice ? pricing.price : null,
    migrationStatus: member.migrationStatus,
    approvalStatus: member.approvalStatus,
    openOfferStatus: offerOpen ? reactivation!.status : null,
  });
  // Something pending would actually charge the captured card; without it the
  // card is merely on file (drives the payment-method badge wording).
  const hasPendingCharge =
    billingState === "OFFER_SENT" || billingState === "OFFER_DRAFT" || billingState === "PENDING_APPROVAL";
  const finalBillingDate = member.migrationFinalBillingDate ?? member.billingAnchorDate ?? null;
  const readiness = deriveReadiness({
    migrationGroup: member.migrationGroup,
    migrationFinalAction: member.migrationFinalAction,
    migrationStatus: member.migrationStatus,
    approvalStatus: member.approvalStatus,
    price: hasConfiguredPrice ? pricing.price : null,
    hasPlan: !!plan || !!member.legacyMembershipName,
    hasCapturedCard: !!member.stripeSetupPaymentMethodId,
    offlineIntended,
    finalPeriodPaid: member.migrationFinalPeriodPaid,
    finalBillingDate,
    hasLiveStripeSub,
    reactivationStatus: offerOpen ? reactivation!.status : null,
  });
  const timing = chargeTiming(finalBillingDate);
  // The two owner date fields can disagree (imported anchor vs the approved
  // final date). The final date always wins when billing starts — surface the
  // mismatch instead of letting the page show two different "next" dates.
  const anchorMismatch =
    !!member.migrationFinalBillingDate &&
    !!member.billingAnchorDate &&
    member.migrationFinalBillingDate.toISOString().slice(0, 10) !== member.billingAnchorDate.toISOString().slice(0, 10);

  // ── Who last changed billing ────────────────────────────────────────────
  let lastChangedBy: { name: string; at: Date } | null = null;
  if (member.billingUpdatedAt && member.billingUpdatedById) {
    const u = await prisma.user.findUnique({
      where: { id: member.billingUpdatedById },
      select: { firstName: true, lastName: true },
    });
    lastChangedBy = { name: u ? `${u.firstName} ${u.lastName}`.trim() : "Unknown", at: member.billingUpdatedAt };
  }

  // ── Merged history (billing audit + migration events) ──────────────────
  const [auditRows, migrationEvents] = await Promise.all([
    prisma.billingAuditLog.findMany({
      where: { memberId: member.id, clubId: club.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.memberMigrationEvent.findMany({
      where: { memberId: member.id, clubId: club.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);
  const actorIds = Array.from(
    new Set(
      [...auditRows.map((r) => r.actorUserId), ...migrationEvents.map((e) => e.actorUserId)].filter(
        (x): x is string => !!x,
      ),
    ),
  );
  const actors = actorIds.length
    ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, firstName: true, lastName: true } })
    : [];
  const actorName = (uid: string | null) => {
    if (!uid) return null;
    const u = actors.find((a) => a.id === uid);
    return u ? `${u.firstName} ${u.lastName}`.trim() : null;
  };
  const history = [
    ...auditRows.map((r) => ({
      at: r.createdAt, kind: "BILLING" as const, action: r.action, message: r.note,
      actorName: actorName(r.actorUserId), before: r.before, after: r.after,
    })),
    ...migrationEvents.map((e) => ({
      at: e.createdAt, kind: "MIGRATION" as const, action: e.type, message: e.message,
      actorName: actorName(e.actorUserId), before: null, after: null,
    })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 60);

  // What the customer is actually charged for the effective price when the
  // club passes the Stripe processing fee (display only — lib/fees.ts owns
  // the math, and the charge paths use recurringUnitWithFee on the same base).
  const fees = feeBreakdown(pricing.price, club.passProcessingFees);

  // Plans for the edit modal.
  const plans = await prisma.membership.findMany({
    where: { clubId: club.id, deletedAt: null, active: true },
    select: { id: true, name: true, options: true },
    orderBy: { name: "asc" },
  });

  return NextResponse.json({
    member: {
      id: member.id, firstName: member.firstName, lastName: member.lastName,
      isMinor: member.isMinor, status: member.status, email: member.email, phone: member.phone,
      guardianName: member.guardianName, guardianEmail: member.guardianEmail,
    },
    guardians,
    payer,
    // ONE authoritative state with strict precedence (live Stripe > pending
    // offer/approval > paid draft config > manual > free > settled) so the
    // page can never show contradictory chips without explanation.
    billingState: {
      key: billingState,
      label: BILLING_STATE_META[billingState].label,
      explanation: BILLING_STATE_META[billingState].explanation,
    },
    hasPendingCharge,
    anchorMismatch,
    feeBreakdown: {
      passFees: club.passProcessingFees,
      feePercentLabel: describeProcessingFee(),
      base: fees.base,
      fee: fees.fee,
      totalCharged: fees.total,
    },
    billing: {
      planId: plan?.id ?? null,
      planName: pricing.planName,
      optionLabel: pricing.optionLabel,
      price: pricing.price,
      period: pricing.period,
      periodLabel: prettyPeriod(pricing.period),
      priceOverride: member.migrationPriceOverride != null ? Number(member.migrationPriceOverride) : null,
      discountNote: member.migrationDiscountNote,
      startDate: member.membershipStartDate,
      billingAnchorDate: member.billingAnchorDate,
      finalBillingDate: member.migrationFinalBillingDate,
      nextBillingDate: activeSub?.currentPeriodEnd ?? finalBillingDate,
      commitmentEndDate: member.commitmentEndDate,
      requestedPaymentMethod: member.requestedPaymentMethod,
      finalPeriodPaid: member.migrationFinalPeriodPaid,
      lastPayment: subs.map((s) => s.lastPayment).find(Boolean) ?? null,
      stripeStatus: activeSub?.stripeStatus ?? null,
      chargeTiming: timing,
      legacy: {
        name: member.legacyMembershipName,
        price: member.legacyMembershipPrice != null ? Number(member.legacyMembershipPrice) : null,
        frequency: member.legacyBillingFrequency,
        source: member.legacySource,
      },
    },
    subscriptions: subs,
    paymentMethods,
    stripeReadError,
    hasSetupCustomer: !!member.stripeSetupCustomerId,
    hasCapturedCard: !!member.stripeSetupPaymentMethodId,
    migration: {
      migrationStatus: member.migrationStatus,
      approvalStatus: member.approvalStatus,
      paymentSetupStatus: member.paymentSetupStatus,
      group: member.migrationGroup,
      finalAction: member.migrationFinalAction,
      groupNote: member.migrationGroupNote,
      activationEmailSentAt: member.activationEmailSentAt,
      activationEmailSendCount: member.activationEmailSendCount,
      requestedBillingDate: member.requestedBillingDate,
      requestedBillingNote: member.requestedBillingNote,
      activationNote: member.activationNote,
    },
    reactivation: reactivation
      ? {
          id: reactivation.id,
          status: reactivation.status,
          offerVersion: reactivation.offerVersion,
          offer: reactivation.offer,
          personalNote: reactivation.personalNote,
          emailSentAt: reactivation.emailSentAt,
          emailSendCount: reactivation.emailSendCount,
          sentToEmail: reactivation.sentToEmail,
          viewedAt: reactivation.viewedAt,
          confirmedAt: reactivation.confirmedAt,
          consent: reactivation.consent,
          tokenExpires: reactivation.tokenExpires,
          createdAt: reactivation.createdAt,
          updatedAt: reactivation.updatedAt,
          open: offerOpen,
          // null when the offer is closed; otherwise whether the snapshot
          // still matches the member's CURRENT billing setup.
          sync: offerSync,
          // Client change request — OPEN locks the client's confirmation
          // until the owner approves (new version) or denies (Approvals tab).
          changeRequest: reactivation.changeRequest,
          changeRequestStatus: reactivation.changeRequestStatus,
          changeRequestAt: reactivation.changeRequestAt,
          url: reactivationUrl(baseUrlFromRequest(req), reactivation.token),
        }
      : null,
    readiness: { state: readiness.state, label: READINESS_LABELS[readiness.state], reasons: readiness.reasons },
    lastChangedBy,
    history,
    plans: plans.map((p) => {
      let options: unknown = [];
      try { options = typeof p.options === "string" ? JSON.parse(p.options) : p.options; } catch { /* [] */ }
      return { id: p.id, name: p.name, options };
    }),
  });
}

// ── PATCH — corrections with preview/diff ─────────────────────────────────

const patchSchema = z.object({
  preview: z.boolean().optional().default(false),
  // Money / plan fields — require billing:full.
  membershipId: z.string().optional().nullable(),
  selectedOptionLabel: z.string().optional().nullable(),
  priceOverride: z.number().nonnegative().max(100000).optional().nullable(),
  discountNote: z.string().max(200).optional().nullable(),
  billingFrequency: z.enum(["WEEKLY", "BIWEEKLY", "MONTHLY", "QUARTERLY", "SEMI_ANNUAL", "ANNUAL"]).optional().nullable(),
  membershipStartDate: z.string().optional().nullable(),
  billingAnchorDate: z.string().optional().nullable(),
  commitmentEndDate: z.string().optional().nullable(),
  responsiblePayerUserId: z.string().optional().nullable(),
  markFree: z.boolean().optional(),
  finalPeriodPaid: z.boolean().optional(),
  // Triage fields — members:edit is enough (planning only, never charges).
  migrationGroup: z.enum(MIGRATION_GROUPS).optional().nullable(),
  migrationFinalAction: z.enum(FINAL_ACTIONS).optional().nullable(),
  migrationGroupNote: z.string().max(500).optional().nullable(),
  migrationFinalBillingDate: z.string().optional().nullable(),
});

const TRIAGE_FIELDS = new Set(["migrationGroup", "migrationFinalAction", "migrationGroupNote", "migrationFinalBillingDate", "preview"]);

const parseDate = (s: string | null | undefined) => {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
};

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let raw: Record<string, unknown>;
  let data: z.infer<typeof patchSchema>;
  try {
    raw = (await req.json()) as Record<string, unknown>;
    data = patchSchema.parse(raw);
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  // Triage-only edits need members:edit; anything touching money needs the
  // explicit billing permission.
  const touchesMoney = Object.keys(raw).some((k) => raw[k] !== undefined && !TRIAGE_FIELDS.has(k));
  const denied = touchesMoney
    ? requirePermission(session, "billing", "full")
    : requirePermission(session, "members", "edit");
  if (denied) return denied;

  const member = await prisma.member.findFirst({
    where: { id, clubId: session.user.clubId, deletedAt: null },
    include: { guardianLinks: { select: { userId: true } } },
  });
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Validate plan + resolve the chosen option server-side.
  let selectedOption: { label: string; price: number; billingPeriod: string } | null | undefined;
  const effectivePlanId = data.membershipId !== undefined ? data.membershipId : member.migrationMembershipId;
  if (data.membershipId) {
    const plan = await prisma.membership.findFirst({
      where: { id: data.membershipId, clubId: member.clubId, deletedAt: null },
      select: { id: true },
    });
    if (!plan) return NextResponse.json({ error: "Membership plan not found" }, { status: 400 });
  }
  if (data.selectedOptionLabel !== undefined) {
    if (!data.selectedOptionLabel || !effectivePlanId) {
      selectedOption = null;
    } else {
      const plan = await prisma.membership.findFirst({
        where: { id: effectivePlanId, clubId: member.clubId, deletedAt: null },
        select: { options: true },
      });
      selectedOption = null;
      try {
        const opts = JSON.parse((plan?.options as unknown as string) || "[]");
        const match = Array.isArray(opts)
          ? opts.find((o) => o && String(o.label ?? "") === data.selectedOptionLabel && typeof o.price === "number")
          : null;
        if (match) {
          selectedOption = {
            label: String(match.label ?? "Membership"),
            price: Number(match.price),
            billingPeriod: String(match.billingPeriod || "MONTHLY"),
          };
        } else {
          return NextResponse.json({ error: "That purchase option doesn't exist on the selected plan." }, { status: 400 });
        }
      } catch {
        return NextResponse.json({ error: "Could not read the plan's purchase options." }, { status: 400 });
      }
    }
  }

  // Payer must be a guardian-linked portal user of THIS member (or its own user).
  if (data.responsiblePayerUserId) {
    const allowed =
      data.responsiblePayerUserId === member.userId ||
      member.guardianLinks.some((l) => l.userId === data.responsiblePayerUserId);
    if (!allowed) {
      return NextResponse.json(
        { error: "The payer must be this athlete's own account or a linked guardian. Link the guardian first." },
        { status: 400 },
      );
    }
  }

  // Build the update + a human-readable before/after diff of provided fields.
  const update: Prisma.MemberUncheckedUpdateInput = {};
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const set = (field: string, prev: unknown, next: unknown) => {
    before[field] = prev instanceof Date ? prev.toISOString() : prev ?? null;
    after[field] = next instanceof Date ? next.toISOString() : next ?? null;
  };

  if (data.membershipId !== undefined) {
    set("membershipPlan", member.migrationMembershipId, data.membershipId || null);
    update.migrationMembershipId = data.membershipId || null;
  }
  if (selectedOption !== undefined) {
    set("purchaseOption", member.migrationSelectedOption, selectedOption);
    update.migrationSelectedOption = selectedOption === null ? Prisma.JsonNull : selectedOption;
    if (selectedOption) {
      set("billingFrequency", member.legacyBillingFrequency, selectedOption.billingPeriod);
      update.legacyBillingFrequency = selectedOption.billingPeriod;
    }
  }
  if (data.markFree) {
    set("priceOverride", member.migrationPriceOverride != null ? Number(member.migrationPriceOverride) : null, 0);
    set("discountNote", member.migrationDiscountNote, data.discountNote ?? "Free / grandfathered membership");
    update.migrationPriceOverride = 0;
    update.migrationDiscountNote = data.discountNote ?? "Free / grandfathered membership";
  } else {
    if (data.priceOverride !== undefined) {
      set("priceOverride", member.migrationPriceOverride != null ? Number(member.migrationPriceOverride) : null, data.priceOverride);
      update.migrationPriceOverride = data.priceOverride;
    }
    if (data.discountNote !== undefined) {
      set("discountNote", member.migrationDiscountNote, data.discountNote?.trim() || null);
      update.migrationDiscountNote = data.discountNote?.trim() || null;
    }
  }
  if (data.billingFrequency !== undefined) {
    set("billingFrequency", member.legacyBillingFrequency, data.billingFrequency || null);
    update.legacyBillingFrequency = data.billingFrequency || null;
  }
  if (data.membershipStartDate !== undefined) {
    const d = parseDate(data.membershipStartDate);
    set("startDate", member.membershipStartDate, d);
    update.membershipStartDate = d;
  }
  if (data.billingAnchorDate !== undefined) {
    const d = parseDate(data.billingAnchorDate);
    set("billingAnchorDate", member.billingAnchorDate, d);
    update.billingAnchorDate = d;
  }
  if (data.commitmentEndDate !== undefined) {
    const d = parseDate(data.commitmentEndDate);
    set("commitmentEndDate", member.commitmentEndDate, d);
    update.commitmentEndDate = d;
  }
  if (data.finalPeriodPaid !== undefined) {
    set("finalPeriodPaid", member.migrationFinalPeriodPaid, data.finalPeriodPaid);
    update.migrationFinalPeriodPaid = data.finalPeriodPaid;
  }
  if (data.responsiblePayerUserId !== undefined) {
    set("responsiblePayer", member.responsiblePayerUserId, data.responsiblePayerUserId || null);
    update.responsiblePayerUserId = data.responsiblePayerUserId || null;
  }
  if (data.migrationGroup !== undefined) {
    set("group", member.migrationGroup, data.migrationGroup || null);
    update.migrationGroup = data.migrationGroup || null;
  }
  if (data.migrationFinalAction !== undefined) {
    set("finalAction", member.migrationFinalAction, data.migrationFinalAction || null);
    update.migrationFinalAction = data.migrationFinalAction || null;
  }
  if (data.migrationGroupNote !== undefined) {
    set("groupNote", member.migrationGroupNote, data.migrationGroupNote?.trim() || null);
    update.migrationGroupNote = data.migrationGroupNote?.trim() || null;
  }
  if (data.migrationFinalBillingDate !== undefined) {
    const d = parseDate(data.migrationFinalBillingDate);
    set("finalBillingDate", member.migrationFinalBillingDate, d);
    update.migrationFinalBillingDate = d;
  }

  const changed = Object.keys(after).filter(
    (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
  );

  if (data.preview) {
    return NextResponse.json({ preview: true, before, after, changed });
  }
  if (!changed.length) {
    return NextResponse.json({ ok: true, changed: [] });
  }

  update.billingUpdatedAt = new Date();
  update.billingUpdatedById = session.user.id;

  await prisma.member.update({ where: { id: member.id }, data: update });

  await writeBillingAudit({
    clubId: member.clubId,
    memberId: member.id,
    actorUserId: session.user.id,
    action: "BILLING_SETUP_UPDATED",
    before,
    after,
    note: `Updated: ${changed.join(", ")}`,
  });
  // Keep the migration roster's "Set up by" badge in sync (it reads this note).
  await prisma.memberMigrationEvent.create({
    data: {
      clubId: member.clubId,
      memberId: member.id,
      type: "NOTE",
      message: "Migration setup updated (billing control center)",
      actorUserId: session.user.id,
    },
  }).catch(() => {});

  return NextResponse.json({ ok: true, changed });
}
