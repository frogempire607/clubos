import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { newActivationToken } from "@/lib/migration";
import { resolveOfferPricing, type ResolvedPricing } from "@/lib/billingAdmin";
import { resolveStaffDiscount, quotePayment } from "@/lib/staffPayments";
import { applyProcessingFee } from "@/lib/fees";

// Membership reactivation offers — server helpers shared by the owner-side
// composer (create/preview/send) and the public token page (view/confirm).
// The offer snapshot is built HERE from server data only; nothing about
// price/dates ever comes from a client payload.

export const REACTIVATION_TTL_DAYS = 14;

export type ReactivationOffer = {
  membershipId: string | null;
  planName: string;
  optionLabel: string | null;
  price: number;
  billingPeriod: string;
  startDate: string | null; // ISO
  firstChargeDate: string | null; // ISO; null only for FREE/OFFLINE offers
  commitmentEndDate: string | null; // ISO
  paymentMode: "CARD" | "OFFLINE" | "FREE";
  payerUserId: string | null;
  // Owner's plan-level Auto Renew setting, frozen into the offer. false ⇒ the
  // subscription ends after the commitment date (or the first billing period
  // when no commitment is set) instead of renewing.
  autoRenew: boolean;
  // Staff-selected payment method (shared vocabulary, lib/staffPayments.ts).
  // CASH/CHECK ⇒ paymentMode OFFLINE with the receipt-confirmation flow.
  paymentMethod: "SAVED_CARD" | "NEW_CARD" | "CASH" | "CHECK" | null;
  // Staff-selected discount, server-resolved and FROZEN with its math. The
  // client is charged finalPrice; `price` above stays the pre-discount price.
  discount: {
    code: string;
    name: string; // description || code — receipt shows "<name> Discount Applied"
    type: "PERCENT" | "FIXED";
    value: number;
    amountOff: number;
    finalPrice: number;
  } | null;
};

export type OfferMember = {
  id: string;
  clubId: string;
  membershipStartDate: Date | null;
  commitmentEndDate: Date | null;
  requestedCancellationDate: Date | null;
  requestedPaymentMethod: string | null;
  migrationMembershipId: string | null;
  legacyMembershipName: string | null;
  legacyMembershipPrice: Prisma.Decimal | number | null;
  legacyBillingFrequency: string | null;
  migrationSelectedOption: unknown;
  migrationPriceOverride: Prisma.Decimal | number | null;
  migrationDiscountCode?: string | null;
  responsiblePayerUserId: string | null;
};

/**
 * Build the server-side offer snapshot for a member. `firstChargeDate` is the
 * owner-approved date (already validated by the caller). Pricing follows the
 * same precedence as migration approval.
 */
export async function buildOffer(
  member: OfferMember,
  club: { stripeAccountId: string | null; stripeChargesEnabled: boolean },
  firstChargeDate: Date | null,
): Promise<{ offer: ReactivationOffer; pricing: ResolvedPricing; discountError: string | null }> {
  const plan = member.migrationMembershipId
    ? await prisma.membership.findFirst({
        where: { id: member.migrationMembershipId, clubId: member.clubId, deletedAt: null },
        select: { id: true, name: true, options: true, autoRenewDefault: true },
      })
    : null;

  const pricing = resolveOfferPricing(
    {
      legacyMembershipName: member.legacyMembershipName,
      legacyMembershipPrice: member.legacyMembershipPrice as number | string | null,
      legacyBillingFrequency: member.legacyBillingFrequency,
      migrationSelectedOption: member.migrationSelectedOption,
      migrationPriceOverride: member.migrationPriceOverride as number | string | null,
    },
    plan ? { name: plan.name, options: plan.options } : null,
  );

  // Staff-selected payment method (member.requestedPaymentMethod, shared
  // vocabulary). CASH/CHECK ⇒ OFFLINE mode with the receipt-confirmation flow;
  // LATER ⇒ the client adds a NEW card on the offer page.
  const paymentMethod: ReactivationOffer["paymentMethod"] =
    member.requestedPaymentMethod === "CASH"
      ? "CASH"
      : member.requestedPaymentMethod === "CHECK"
        ? "CHECK"
        : member.requestedPaymentMethod === "LATER"
          ? "NEW_CARD"
          : "SAVED_CARD";
  const offline =
    !club.stripeAccountId || !club.stripeChargesEnabled || paymentMethod === "CASH" || paymentMethod === "CHECK";
  const paymentMode: ReactivationOffer["paymentMode"] =
    pricing.price <= 0 ? "FREE" : offline ? "OFFLINE" : "CARD";

  // Staff-selected discount — server-resolved against the discount engine and
  // FROZEN with its math. An invalid stored code never silently disappears:
  // it's surfaced as discountError and offer creation is blocked upstream.
  let discount: ReactivationOffer["discount"] = null;
  let discountError: string | null = null;
  if (member.migrationDiscountCode && pricing.configured && pricing.price > 0) {
    const resolved = await resolveStaffDiscount(member.clubId, member.migrationDiscountCode, {
      type: "MEMBERSHIP",
      membershipId: plan?.id ?? null,
    });
    if (!resolved.ok) {
      discountError = resolved.error;
    } else if (resolved.discount) {
      const q = quotePayment({
        originalPrice: pricing.price,
        discount: resolved.discount,
        method: paymentMethod,
        passProcessingFees: false, // fee display handled separately; math here is discount-only
      });
      if (!q.ok) {
        discountError = q.error;
      } else {
        discount = {
          code: resolved.discount.code,
          name: resolved.discount.description || resolved.discount.code,
          type: resolved.discount.type,
          value: resolved.discount.value,
          amountOff: q.quote.discountAmount,
          finalPrice: q.quote.finalPrice,
        };
      }
    }
  }

  const commitment = member.requestedCancellationDate ?? member.commitmentEndDate ?? null;

  return {
    pricing,
    discountError,
    offer: {
      membershipId: plan?.id ?? null,
      planName: pricing.planName,
      optionLabel: pricing.optionLabel,
      price: pricing.price,
      billingPeriod: pricing.period,
      startDate: (member.membershipStartDate ?? new Date()).toISOString(),
      firstChargeDate: paymentMode === "CARD" ? firstChargeDate?.toISOString() ?? null : null,
      commitmentEndDate: commitment ? commitment.toISOString() : null,
      paymentMode,
      payerUserId: member.responsiblePayerUserId ?? null,
      autoRenew: plan?.autoRenewDefault ?? true,
      paymentMethod,
      discount,
    },
  };
}

/** The amount the client actually pays: discounted price when a discount applies. */
export function offerEffectivePrice(offer: Pick<ReactivationOffer, "price" | "discount">): number {
  return offer.discount ? offer.discount.finalPrice : offer.price;
}

/**
 * Create a new reactivation offer for a member, superseding any open one
 * (DRAFT/SENT). History is never deleted — superseded rows keep their token
 * (now unusable via the status check) and their send/consent trail.
 */
export async function createReactivation(args: {
  clubId: string;
  memberId: string;
  offer: ReactivationOffer;
  personalNote: string | null;
  createdById: string | null;
}) {
  const open = await prisma.membershipReactivation.findMany({
    where: { clubId: args.clubId, memberId: args.memberId, status: { in: ["DRAFT", "SENT"] } },
    select: { id: true, offerVersion: true },
  });
  if (open.length) {
    await prisma.membershipReactivation.updateMany({
      where: { id: { in: open.map((o) => o.id) } },
      data: { status: "SUPERSEDED" },
    });
  }
  const latest = await prisma.membershipReactivation.findFirst({
    where: { clubId: args.clubId, memberId: args.memberId },
    orderBy: { offerVersion: "desc" },
    select: { offerVersion: true },
  });

  return prisma.membershipReactivation.create({
    data: {
      clubId: args.clubId,
      memberId: args.memberId,
      token: newActivationToken(),
      tokenExpires: new Date(Date.now() + REACTIVATION_TTL_DAYS * 24 * 60 * 60 * 1000),
      offerVersion: (latest?.offerVersion ?? 0) + 1,
      offer: args.offer as unknown as Prisma.InputJsonValue,
      personalNote: args.personalNote,
      status: "DRAFT",
      createdById: args.createdById,
    },
  });
}

/** Parse an offer JSON back into a typed shape (defensive against bad rows). */
export function parseOffer(raw: unknown): ReactivationOffer | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.planName !== "string" || typeof o.price !== "number") return null;
  return {
    membershipId: typeof o.membershipId === "string" ? o.membershipId : null,
    planName: o.planName,
    optionLabel: typeof o.optionLabel === "string" ? o.optionLabel : null,
    price: o.price,
    billingPeriod: typeof o.billingPeriod === "string" ? o.billingPeriod : "MONTHLY",
    startDate: typeof o.startDate === "string" ? o.startDate : null,
    firstChargeDate: typeof o.firstChargeDate === "string" ? o.firstChargeDate : null,
    commitmentEndDate: typeof o.commitmentEndDate === "string" ? o.commitmentEndDate : null,
    paymentMode: o.paymentMode === "OFFLINE" || o.paymentMode === "FREE" ? o.paymentMode : "CARD",
    payerUserId: typeof o.payerUserId === "string" ? o.payerUserId : null,
    // Offers created before the Auto Renew setting existed renew (the only
    // behavior that existed then).
    autoRenew: typeof o.autoRenew === "boolean" ? o.autoRenew : true,
    paymentMethod:
      o.paymentMethod === "SAVED_CARD" || o.paymentMethod === "NEW_CARD" || o.paymentMethod === "CASH" || o.paymentMethod === "CHECK"
        ? o.paymentMethod
        : null,
    discount: (() => {
      const d = o.discount as Record<string, unknown> | null | undefined;
      if (!d || typeof d !== "object" || typeof d.code !== "string" || typeof d.finalPrice !== "number") return null;
      return {
        code: d.code,
        name: typeof d.name === "string" ? d.name : d.code,
        type: d.type === "FIXED" ? ("FIXED" as const) : ("PERCENT" as const),
        value: typeof d.value === "number" ? d.value : 0,
        amountOff: typeof d.amountOff === "number" ? d.amountOff : 0,
        finalPrice: d.finalPrice,
      };
    })(),
  };
}

/** Reactivation link for a token. */
export function reactivationUrl(baseUrl: string, token: string): string {
  return `${baseUrl}/reactivate/${token}`;
}

// ── Offer ↔ current-setup synchronization ──────────────────────────────────
// An offer is an IMMUTABLE snapshot: editing billing afterwards never mutates
// what a sent token represents. Instead, staleness is COMPUTED — the current
// setup is rebuilt and compared field-by-field. An out-of-date offer is shown
// as such to the owner and is BLOCKED at confirmation; the owner regenerates
// (new version, new token) and resends.

const dateOnly = (iso: string | null) => (iso ? iso.slice(0, 10) : null);

/** Field-by-field comparison of a stored offer against a freshly-built one. */
export function diffOffer(stored: ReactivationOffer, current: ReactivationOffer): string[] {
  const changed: string[] = [];
  if (stored.planName !== current.planName) changed.push("plan");
  if ((stored.optionLabel ?? null) !== (current.optionLabel ?? null)) changed.push("purchase option");
  if (stored.price !== current.price) changed.push("price");
  if (stored.billingPeriod !== current.billingPeriod) changed.push("billing frequency");
  if (stored.paymentMode !== current.paymentMode) changed.push("payment mode");
  if (dateOnly(stored.firstChargeDate) !== dateOnly(current.firstChargeDate)) changed.push("first billing date");
  if (dateOnly(stored.commitmentEndDate) !== dateOnly(current.commitmentEndDate)) changed.push("commitment end date");
  if ((stored.payerUserId ?? null) !== (current.payerUserId ?? null)) changed.push("responsible payer");
  if (stored.autoRenew !== current.autoRenew) changed.push("auto-renew");
  // Changing payment method (card ↔ cash/check) or the discount supersedes any
  // open offer: the old token goes stale and a new version must be sent.
  if ((stored.paymentMethod ?? null) !== (current.paymentMethod ?? null)) changed.push("payment method");
  if ((stored.discount?.code ?? null) !== (current.discount?.code ?? null)) changed.push("discount");
  if ((stored.discount?.finalPrice ?? null) !== (current.discount?.finalPrice ?? null)) changed.push("discounted price");
  return changed;
}

/**
 * Rebuild the offer from the member's CURRENT billing setup and compare it to
 * a stored offer. The current first-charge date is the member's saved
 * `migrationFinalBillingDate ?? billingAnchorDate` (what a fresh offer would
 * use) — so an owner date edit after sending marks the offer out of date.
 */
export async function compareOfferToCurrent(
  member: OfferMember & { migrationFinalBillingDate: Date | null; billingAnchorDate: Date | null },
  club: { stripeAccountId: string | null; stripeChargesEnabled: boolean },
  stored: ReactivationOffer,
): Promise<{ matches: boolean; changed: string[]; current: ReactivationOffer }> {
  const currentFirstCharge = member.migrationFinalBillingDate ?? member.billingAnchorDate ?? null;
  const { offer: current } = await buildOffer(member, club, currentFirstCharge);
  const changed = diffOffer(stored, current);
  return { matches: changed.length === 0, changed, current };
}

// Billing dates are date-only 00:00-UTC values — format in UTC so the email
// names the same calendar day the owner approved.
const longDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
    : null;

/**
 * Assemble the email params for a reactivation row — shared by the send route
 * and the owner preview so what the owner previews is EXACTLY what goes out.
 */
export function buildReactivationEmailParams(args: {
  to: string;
  reactivation: { token: string; tokenExpires: Date; personalNote: string | null; offer: unknown };
  athleteName: string;
  club: {
    name: string;
    logoUrl?: string | null;
    primaryColor?: string | null;
    contactEmail?: string | null;
    emailFromName?: string | null;
    emailReplyTo?: string | null;
    // Whether the Stripe processing fee is passed to the customer — drives the
    // fee-inclusive "total charged" wording (lib/fees.ts owns the math).
    passProcessingFees?: boolean;
  };
  clubLogoPublicUrl: string | null;
  cardSummary: string | null;
  payerName: string | null;
  baseUrl: string;
}): import("@/lib/email").ReactivationEmailParams | null {
  const offer = parseOffer(args.reactivation.offer);
  if (!offer) return null;
  const firstCharge = offer.firstChargeDate ? new Date(offer.firstChargeDate) : null;
  const immediate = !!firstCharge && firstCharge.getTime() <= Date.now() + 60_000;
  const isFree = offer.paymentMode === "FREE" || offer.price <= 0;
  // Exact card charge when the club passes the processing fee — matches what
  // confirm creates (recurringUnitWithFee on the same cent base).
  const passFees = !isFree && offer.paymentMode === "CARD" && !!args.club.passProcessingFees;
  const fees = applyProcessingFee(Math.round(offer.price * 100), passFees);
  return {
    to: args.to,
    athleteName: args.athleteName,
    clubName: args.club.name,
    clubLogoUrl: args.clubLogoPublicUrl,
    clubPrimaryColor: args.club.primaryColor ?? null,
    membershipName: offer.planName,
    optionLabel: offer.optionLabel,
    priceLabel: isFree ? "Free" : `$${offer.price.toFixed(2)}`,
    totalChargedLabel: isFree ? null : `$${(fees.totalCents / 100).toFixed(2)}`,
    processingFeeLabel: fees.feeCents > 0 ? `$${(fees.feeCents / 100).toFixed(2)}` : null,
    periodLabel: prettyPeriodLabel(offer.billingPeriod),
    startDateLabel: longDate(offer.startDate),
    firstChargeLabel: isFree ? null : longDate(offer.firstChargeDate),
    immediateCharge: immediate,
    commitmentLabel: longDate(offer.commitmentEndDate),
    cardSummary: args.cardSummary,
    payerName: args.payerName,
    personalNote: args.reactivation.personalNote,
    reactivationUrl: reactivationUrl(args.baseUrl, args.reactivation.token),
    expiresLabel:
      longDate(args.reactivation.tokenExpires.toISOString()) ?? "in 14 days",
    supportEmail: args.club.contactEmail ?? null,
    fromName: args.club.emailFromName || args.club.name,
    replyTo: args.club.emailReplyTo || args.club.contactEmail || null,
  };
}

/**
 * Load everything the reactivation email needs for a member's latest open
 * offer (DRAFT/SENT): the row, the recipient, club branding, card summary,
 * payer name. Used by BOTH the send route and the owner preview so they can
 * never drift apart. Returns an error string on any precondition failure.
 */
export async function loadReactivationEmailContext(memberId: string, clubId: string, baseUrl?: string) {
  const { resolveCardSnapshot, prettyBrand } = await import("@/lib/memberCard");
  const { publicClubLogoUrl } = await import("@/lib/clubLogo");
  const { getAppBaseUrl } = await import("@/lib/baseUrl");

  const member = await prisma.member.findFirst({
    where: { id: memberId, clubId, deletedAt: null },
    select: {
      id: true, firstName: true, lastName: true, isMinor: true, email: true, guardianEmail: true,
      stripeSetupCustomerId: true, stripeCustomerId: true, responsiblePayerUserId: true,
      club: {
        select: {
          id: true, name: true, logoUrl: true, primaryColor: true, contactEmail: true,
          emailFromName: true, emailReplyTo: true, stripeAccountId: true, passProcessingFees: true,
        },
      },
    },
  });
  if (!member) return { error: "Member not found" as const };

  const reactivation = await prisma.membershipReactivation.findFirst({
    where: { memberId, clubId, status: { in: ["DRAFT", "SENT"] } },
    orderBy: { createdAt: "desc" },
  });
  if (!reactivation) return { error: "No open reactivation offer — create one first." as const };
  if (reactivation.tokenExpires < new Date()) {
    return { error: "The offer's link has expired — regenerate it first." as const };
  }

  const to = member.isMinor ? member.guardianEmail || member.email : member.email || member.guardianEmail;
  if (!to) return { error: "This member has no email (or guardian email) on file." as const };

  const card = await resolveCardSnapshot(
    member.stripeSetupCustomerId ?? member.stripeCustomerId,
    member.club.stripeAccountId,
  );
  const cardSummary = card
    ? `${prettyBrand(card.brand)} ···· ${card.last4}${card.cardholder ? ` (${card.cardholder})` : ""}`
    : null;

  let payerName: string | null = null;
  if (member.responsiblePayerUserId) {
    const u = await prisma.user.findUnique({
      where: { id: member.responsiblePayerUserId },
      select: { firstName: true, lastName: true },
    });
    if (u) payerName = `${u.firstName} ${u.lastName}`.trim();
  }

  const params = buildReactivationEmailParams({
    to,
    reactivation,
    athleteName: `${member.firstName} ${member.lastName}`.trim(),
    club: member.club,
    clubLogoPublicUrl: publicClubLogoUrl(member.club.id, member.club.logoUrl),
    cardSummary,
    payerName,
    // Caller passes the request-derived origin so links in the email point
    // at the deployment the owner is actually working on (preview or prod).
    baseUrl: baseUrl || getAppBaseUrl(),
  });
  if (!params) return { error: "The offer snapshot is unreadable — regenerate the offer." as const };

  return { member, reactivation, params };
}

function prettyPeriodLabel(period: string): string {
  switch ((period || "").toUpperCase()) {
    case "WEEKLY": return "weekly";
    case "BIWEEKLY": return "every 2 weeks";
    case "MONTHLY": return "monthly";
    case "QUARTERLY": return "quarterly";
    case "SEMI_ANNUAL": return "every 6 months";
    case "ANNUAL": return "yearly";
    default: return (period || "recurring").toLowerCase();
  }
}
