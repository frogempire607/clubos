import { NextResponse } from "next/server";
import { publicMediaUrl } from "@/lib/publicMedia";
import { autoDiscountView } from "@/lib/eventAutoDiscounts";
import { prisma } from "@/lib/prisma";
import { publicClubLogoUrl } from "@/lib/clubLogo";
import {
  eventAllowedPaymentMethods,
  capacityWhere,
  resolveEventPolicy,
  publicSignupRequiresAccount,
  publicPaymentMethods,
} from "@/lib/eventPayments";
import { registrationListPrice } from "@/lib/eventRepricing";
import { documentsForEvent } from "@/lib/eventDocuments";
import { rosterForSignup } from "@/lib/eventRosterServer";
import { maxEntriesFor } from "@/lib/eventEntries";

// GET /api/public/events/[slug]
// NO AUTH. Returns the public-safe view of an event for the /e/[slug] page:
// image, info, owner-defined registration form, and the price a non-member
// would pay. Only resolves events that have a publicSlug and are within their
// publish window.
export async function GET(_req: Request, context: { params: Promise<{ slug: string }> }) {
  const params = await context.params;
  const event = await prisma.event.findUnique({
    where: { publicSlug: params.slug },
    select: {
      id: true,
      name: true,
      description: true,
      startsAt: true,
      endsAt: true,
      imageUrl: true,
      imagePositionX: true,
      imagePositionY: true,
      capacity: true,
      memberPrice: true,
      nonMemberPrice: true,
      dropInFee: true,
      publicRegistration: true,
      signupAccess: true,
      pricingModel: true,
      sellIndividualSessions: true,
      publicFormIntro: true,
      publicPricingOption: true,
      registrationForm: true,
      isTournament: true,
      tournamentMode: true,
      variableCostEnabled: true,
      variableCostMode: true,
      variableCostTotal: true,
      variableCostEstimatedSignups: true,
      variableCostEstimatedTotal: true,
      paymentMethods: true,
      autoChargeDate: true,
      allowMultipleEntries: true,
      maxEntries: true,
      additionalEntryPrice: true,
      allowSameRosterTwice: true,
      entriesOnPublicLink: true,
      autoDiscounts: true,
      // Whether the portal can register for it too (same filter the member
      // events route and register route apply).
      visibility: true,
      purchaseAccess: true,
      // Phase 5 §5.3.3 — the public page must say, before the pay picker, that
      // a coach still has to review this. Resolved through the policy walker,
      // never read off the column directly.
      requiresCoachApproval: true,
      approvalPaymentIntent: true,
      cancellationPolicyText: true,
      customEventType: { select: { defaultPolicy: true } },
      publishAt: true,
      unpublishAt: true,
      deletedAt: true,
      registrationDeadline: true,
      location: { select: { name: true, address: true, latitude: true, longitude: true } },
      // Stripe fields are read to decide what the page can offer and are never
      // returned — the response names each club field it sends.
      club: {
        select: {
          id: true,
          name: true,
          slug: true,
          logoUrl: true,
          primaryColor: true,
          stripeAccountId: true,
          stripeChargesEnabled: true,
        },
      },
      // Spot-holding registrations only — see capacityWhere: an in-flight
      // card checkout still holds its spot, an abandoned one has released it.
      _count: {
        select: {
          registrations: { where: capacityWhere() },
          bookings: { where: { status: { notIn: ["CANCELED"] } } },
        },
      },
    },
  });

  if (!event || event.deletedAt) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }

  const now = new Date();
  if (event.publishAt && event.publishAt > now) {
    return NextResponse.json({ error: "Registration is not open yet" }, { status: 403 });
  }
  if (event.unpublishAt && event.unpublishAt < now) {
    return NextResponse.json({ error: "Registration has closed" }, { status: 403 });
  }
  if (event.registrationDeadline && event.registrationDeadline < now) {
    return NextResponse.json({ error: "The registration deadline has passed" }, { status: 403 });
  }

  // Compute the price a public registrant pays.
  let price: number | null = null;
  let priceLabel = "Free";
  if (
    event.variableCostEnabled &&
    event.variableCostMode === "ESTIMATED" &&
    event.variableCostTotal &&
    event.variableCostEstimatedSignups
  ) {
    price = +(Number(event.variableCostTotal) / event.variableCostEstimatedSignups).toFixed(2);
    priceLabel = `$${price.toFixed(2)} (estimated split)`;
  } else if (registrationListPrice(event) > 0) {
    // The same resolver the register route quotes from, so the page and the
    // POST can't disagree. It honors publicPricingOption and then falls
    // through to whatever price the owner set — an event priced for members
    // only used to render here as "Free" and then register walk-ins for $0.
    price = registrationListPrice(event);
    priceLabel = `$${price.toFixed(2)}`;
  } else if (
    event.variableCostEnabled &&
    event.variableCostMode === "OFFICIAL"
  ) {
    if (event.variableCostEstimatedTotal && Number(event.variableCostEstimatedTotal) > 0) {
      priceLabel = `Billed after the tournament — estimated ~$${Number(event.variableCostEstimatedTotal).toFixed(2)} total, split across attendees`;
    } else {
      priceLabel = "Cost billed after the tournament";
    }
  }

  const publicPolicy = resolveEventPolicy(event);

  const capacityReached =
    event.capacity != null &&
    event._count.registrations + event._count.bookings >= event.capacity;

  // Documents attached to this event (specific links + All Events). Anonymous
  // visitors can read and acknowledge them; full signatures need an account.
  const documents = (await documentsForEvent(event.club.id, event.id)).map((d) => ({
    id: d.id,
    title: d.title,
    type: d.type,
    body: d.body,
    requirement: d.requirement,
  }));

  return NextResponse.json({
    id: event.id,
    name: event.name,
    description: event.description,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    // Session-free image path — /api/files 401s for a logged-out visitor.
    imageUrl: publicMediaUrl("event", event.id, event.imageUrl),
    imagePositionX: event.imagePositionX,
    imagePositionY: event.imagePositionY,
    location: event.location,
    // Public page — rewrite the session-gated logo path to the public endpoint.
    club: {
      id: event.club.id,
      name: event.club.name,
      slug: event.club.slug,
      primaryColor: event.club.primaryColor,
      logoUrl: publicClubLogoUrl(event.club.id, event.club.logoUrl),
    },
    isTournament: event.isTournament,
    tournamentMode: event.tournamentMode,
    publicFormIntro: event.publicFormIntro,
    registrationForm: event.registrationForm ?? [],
    price,
    priceLabel,
    // Variable-cost events bill later, so the page can still offer a discount
    // code field even though it has no total to quote yet.
    variableCost: !!event.variableCostEnabled,
    capacityReached,
    // Since 2026-09-25 a guest can save a card here too (charged on the
    // event's date, after approval when a coach reviews). Card and saved card
    // both need Stripe connected.
    paymentMethods: publicPaymentMethods(
      eventAllowedPaymentMethods(event),
      !!event.club.stripeAccountId && !!event.club.stripeChargesEnabled,
    ),
    // Coach approval, resolved event → type → off. APPROVAL_CHARGE is never
    // reachable here (it needs a saved card, which needs an account — §5.12
    // item 7), so the page only needs to know THAT approval applies and, when
    // the policy is INVOICE, that no payment choice is coming.
    requiresCoachApproval: publicPolicy.requiresCoachApproval,
    // Mirrors the register route exactly: INVOICE by configuration, and
    // APPROVAL_CHARGE because a saved-card charge is impossible on an
    // anonymous path and invoicing on approval is its fallback (§5.4.5).
    billOnApproval:
      publicPolicy.requiresCoachApproval &&
      (publicPolicy.approvalPaymentIntent === "INVOICE" ||
        publicPolicy.approvalPaymentIntent === "APPROVAL_CHARGE"),
    cancellationPolicyText: publicPolicy.cancellationPolicyText,
    documents,
    autoChargeDate: event.autoChargeDate,
    // B16 — the roster's labels and open counts (never names), or null.
    roster: await rosterForSignup(event.id, publicPolicy.holdSpotDuringReview),
    // B16 slice 3 — how many entries this link takes, and what extras cost.
    entryRules: {
      max: maxEntriesFor(event, "PUBLIC"),
      additionalEntryPrice: event.additionalEntryPrice != null ? Number(event.additionalEntryPrice) : null,
      allowSameRosterTwice: event.allowSameRosterTwice,
    },
    // B3 slice 1 — sibling / group-rate lines and the group question.
    autoDiscounts: autoDiscountView(event.autoDiscounts),
    // The only way to pay is a card saved on an account (AUTO_CARD), so the
    // family signs in and registers from the portal. Same rule the register
    // route answers ACCOUNT_REQUIRED with — lib/eventPayments.
    accountRequired: publicSignupRequiresAccount({
      allowed: eventAllowedPaymentMethods(event),
      stripeReady: !!event.club.stripeAccountId && !!event.club.stripeChargesEnabled,
      owesMoney: !event.variableCostEnabled && registrationListPrice(event) > 0,
      billOnApproval:
        publicPolicy.requiresCoachApproval &&
        (publicPolicy.approvalPaymentIntent === "INVOICE" || publicPolicy.approvalPaymentIntent === "APPROVAL_CHARGE"),
    }),
    // The portal lists and registers events with these two settings; when
    // either is off, "sign in to register" would lead nowhere.
    portalAvailable:
      (event.visibility === "PUBLIC" || event.visibility === "MEMBERS_ONLY") && event.purchaseAccess === "ANYONE",
    // Slice 2: signupAccess is the answer; STAFF_ONLY closes the link even on a
    // hosted tournament, PUBLIC_LINK opens it. The legacy flag is kept in sync
    // by every write, so this reads the same as before for untouched events.
    registrationOpen:
      event.signupAccess !== "STAFF_ONLY" &&
      (event.signupAccess === "PUBLIC_LINK" || event.publicRegistration || event.tournamentMode === "HOST") &&
      !capacityReached,
  });
}
