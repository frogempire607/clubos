import { NextResponse } from "next/server";
import { quoteSessions } from "@/lib/eventPricingModel";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import type { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe, calculatePlatformFee } from "@/lib/stripe";
import { processingFeeLineItem } from "@/lib/fees";
import { sendBookingConfirmationEmail } from "@/lib/email";
import { findOrAutoLinkMember } from "@/lib/memberLink";
import { getAppBaseUrl, baseUrlFromRequest } from "@/lib/baseUrl";
import { registrationReturnUrl, registrationUrl } from "@/lib/registrationUrl";
import { applyParentalControls } from "@/lib/parentalControls";
import { guardianActionBlocked, CONSENT_BLOCK_BODY } from "@/lib/parentalConsent";
import { findValidDiscountFor, discountedPrice, recordDiscountUse, type ValidDiscount } from "@/lib/discounts";
import { resolveChargeablePaymentMethodId } from "@/lib/memberCard";
import {
  eventAllowedPaymentMethods,
  offlineStatusForMethod,
  eventScheduledChargeAt,
  resolveEventPolicy,
  EVENT_PAYMENT_METHOD_LABELS,
  approvalOptionsFromEventMethods,
  type EventPaymentMethod,
} from "@/lib/eventPayments";
import { eventFormFields, validateFormResponses, type FormAnswers } from "@/lib/eventForm";
import { rosterActive, type SpotPick } from "@/lib/eventRoster";
import { checkEntries, entriesTotalCents, type CheckedEntry } from "@/lib/eventEntries";
import { loadRosterDef, checkPicks, writeEntries } from "@/lib/eventRosterServer";
import { confirmationCodeFor } from "@/lib/confirmationCode";
import { sendRegistrationLifecycleEmail } from "@/lib/eventLifecycleEmails";
import { createEventOfflinePendingTx } from "@/lib/eventOfflinePayments";
import { missingSignedEventDocs, acknowledgementDocs, documentsForEvent, EVENT_DOC_REQUIREMENT_LABELS } from "@/lib/eventDocuments";
import { chargeEventRegistration } from "@/lib/eventAutoCharge";
import { resolveCardSnapshot, prettyBrand } from "@/lib/memberCard";
import { applyProcessingFee } from "@/lib/fees";
import { ACTIVE_GUARDIAN_LINK } from "@/lib/familyAccess";

async function emailBookingConfirmation(args: {
  memberId: string;
  clubName: string;
  eventName: string;
  startsAt: Date;
  endsAt: Date;
  coveredByMembership: boolean;
}) {
  const m = await prisma.member.findUnique({
    where: { id: args.memberId },
    select: {
      firstName: true,
      email: true,
      isMinor: true,
      guardianEmail: true,
      guardian: { select: { email: true } },
    },
  });
  if (!m) return;
  const to = m.isMinor
    ? (m.guardian?.email || m.guardianEmail || m.email)
    : (m.email || m.guardianEmail);
  if (!to) return;
  const baseUrl = getAppBaseUrl();
  try {
    await sendBookingConfirmationEmail({
      to,
      firstName: m.firstName,
      clubName: args.clubName,
      eventName: args.eventName,
      startsAt: args.startsAt,
      endsAt: args.endsAt,
      coveredByMembership: args.coveredByMembership,
      portalUrl: `${baseUrl}/member/bookings`,
    });
  } catch (e) {
    console.error("Booking email failed:", e);
  }
}

const schema = z.object({
  pricingType: z.enum(["MEMBER", "NON_MEMBER", "DROP_IN"]).default("MEMBER"),
  // B11 slice 2 — DROP_IN with sessionIds = a per-session purchase: the sum of
  // those sessions' prices, recorded on the registration. DROP_IN without
  // sessionIds keeps the old meaning (one unnamed session at the drop-in fee).
  sessionIds: z.array(z.string().min(1)).max(50).optional(),
  memberId: z.string().optional(),
  discountCode: z.string().max(50).optional().nullable(),
  // The registrant's payment decision, when the event offers a choice.
  paymentMethod: z
    .enum(["CARD", "SAVED_CARD", "AUTO_CARD", "CASH", "CHECK", "APPROVAL_CHARGE", "INVOICE"])
    .optional(),
  // AUTO_CARD only: the exact consent the client agreed to. Required so the
  // stored audit reflects what they actually saw on the button.
  autoChargeConsent: z
    .object({ agreed: z.literal(true), buttonLabel: z.string().max(200).optional() })
    .optional(),
  // Set once the client has ticked acknowledgement for the event's
  // ACKNOWLEDGE-level documents.
  acknowledgeDocuments: z.boolean().optional(),
  // The event's own questions (Event.registrationForm — weight class,
  // division, …). Validated by lib/eventForm exactly as the public link
  // validates them; before 2026-09-24 this route never asked.
  formResponses: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
  // B16 — the athlete's entries: a roster spot each (when the event has a
  // roster) and the answers to the questions asked for each entry.
  entries: z
    .array(
      z.object({
        rosterId: z.string().optional().nullable(),
        positionId: z.string().optional().nullable(),
        answers: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
      }),
    )
    .max(20)
    .optional(),
});

async function resolveBookingMember(args: {
  userId: string;
  clubId: string;
  email: string;
  requestedMemberId?: string;
}) {
  const self = await findOrAutoLinkMember(args.userId, args.clubId, args.email);
  const guardianships = await prisma.memberGuardianUser.findMany({
    where: { ...ACTIVE_GUARDIAN_LINK, userId: args.userId, member: { clubId: args.clubId, deletedAt: null } },
    include: { member: true },
  });
  const accessible = [
    ...(self ? [self] : []),
    ...guardianships.map((g) => g.member),
  ];

  if (args.requestedMemberId) {
    return accessible.find((m) => m.id === args.requestedMemberId) ?? null;
  }

  return self ?? accessible[0] ?? null;
}

// POST /api/member/events/[id]/register
// Member self-registers. Free path if active sub matches an accepted membership.
// Otherwise opens Stripe Checkout for the chosen price (defaults to MEMBER).
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  // Note: rate limit applied AFTER session resolution below so the key
  // can be tied to the user. The session check happens 2 statements
  // down — we let it execute then gate the limit on session.user.id.
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // 20 event-registration attempts per minute per user. Same rationale
  // as the class-booking limiter: prevents accidental double-tap +
  // Stripe-checkout-spam.
  const rl = rateLimit({ key: `book:event:${session.user.id}`, limit: 20, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many registration attempts. Try again in a moment.");

  try {
    const body = schema.parse(await req.json().catch(() => ({})));
    const { pricingType, memberId, discountCode, paymentMethod, autoChargeConsent, acknowledgeDocuments } = body;
    const guardianEmail = session.user.email ?? null;

    // COPPA: block a guardian from registering a minor until consent is on file.
    if (memberId && (await guardianActionBlocked(session.user.id, memberId))) {
      return NextResponse.json(CONSENT_BLOCK_BODY, { status: 403 });
    }

    const event = await prisma.event.findFirst({
      where: {
        id: params.id,
        clubId: session.user.clubId,
        deletedAt: null,
        visibility: { in: ["PUBLIC", "MEMBERS_ONLY"] },
        purchaseAccess: "ANYONE",
      },
      include: {
        _count: { select: { bookings: true } },
        sessions: { select: { id: true, price: true, startsAt: true }, orderBy: { sortOrder: "asc" } },
        // Phase 5 §5.3.1 — half of what resolveEventPolicy walks.
        customEventType: { select: { defaultPolicy: true } },
      },
    });
    if (!event) return NextResponse.json({ error: "Event not available" }, { status: 404 });

    // Phase 5 §5.3.2 — event overrides, then the event type's defaults, then
    // all-off. The ONLY reader of the policy columns; nothing below looks at
    // event.requiresCoachApproval directly, because null there means "inherit"
    // and only the resolver knows that.
    const policy = resolveEventPolicy(event);

    const sessionUser = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { email: true },
    });
    const member = sessionUser
      ? await resolveBookingMember({
          userId: session.user.id,
          clubId: session.user.clubId,
          email: sessionUser.email,
          requestedMemberId: memberId,
        })
      : null;
    if (!member) {
      return NextResponse.json(
        { error: "Your account isn't linked to a member profile yet. Contact your club to get added." },
        { status: 400 },
      );
    }

    // ── The event's questions ───────────────────────────────────────────────
    // Asked before every path below (covered, free, paid, approval), because
    // the coach needs the answers whichever way the money goes. No answers at
    // all ⇒ FORM_REQUIRED with the questions, so the portal can ask them; bad
    // answers ⇒ the same message the public link gives.
    // Questions asked once per registration; the per-entry ones are checked
    // with the entries below.
    const allFormFields = eventFormFields(event.registrationForm);
    const formFields = allFormFields.filter((f) => !f.perEntry);
    let formAnswers: FormAnswers = {};
    if (formFields.length > 0) {
      if (body.formResponses === undefined) {
        return NextResponse.json(
          {
            error: "FORM_REQUIRED",
            fields: allFormFields,
            intro: event.publicFormIntro ?? null,
            message: "Answer the event's questions to register.",
          },
          { status: 400 },
        );
      }
      const checked = validateFormResponses(formFields, body.formResponses);
      if (!checked.ok) {
        return NextResponse.json({ error: "FORM_INVALID", fieldId: checked.fieldId, message: checked.message }, { status: 400 });
      }
      formAnswers = checked.answers;
    }
    const formData: { formResponses?: Prisma.InputJsonValue } =
      Object.keys(formAnswers).length > 0 ? { formResponses: formAnswers as Prisma.InputJsonValue } : {};
    // The registration's contact email. A child's member row usually has no
    // email of its own (the guardian's login is the account), which left the
    // row blank and the confirmation email with nowhere to go.
    const contactEmail = member.email || sessionUser?.email || guardianEmail || "";

    // ── B16: the roster spot ────────────────────────────────────────────────
    // Checked against everyone else's registrations before anything is
    // written (their own earlier row doesn't count against them). Full on an
    // event that confirms on signup ⇒ refused; full on an approval-gated
    // event ⇒ a waitlist request the coach sees. No pick at all ⇒ ROSTER_REQUIRED
    // with the roster, so the portal can ask.
    const rosterDef = await loadRosterDef(event.id);
    const usesRoster = rosterActive(rosterDef.rosters, rosterDef.positions);
    const entriesCheck = checkEntries({
      entries: body.entries,
      rules: event,
      channel: "PORTAL",
      rosterActive: usesRoster,
      rosterLabel: (id) => rosterDef.rosters.find((r) => r.id === id)?.label ?? "That roster",
      perEntryFields: allFormFields.filter((f) => f.perEntry),
    });
    if (!entriesCheck.ok) {
      return NextResponse.json(
        {
          error: entriesCheck.code === "ENTRIES_REQUIRED" ? (usesRoster ? "ROSTER_REQUIRED" : "FORM_REQUIRED") : "ENTRIES_INVALID",
          message: entriesCheck.message,
          fields: allFormFields,
          intro: event.publicFormIntro ?? null,
        },
        { status: 400 },
      );
    }
    const entries: CheckedEntry[] = entriesCheck.entries;
    const picks: SpotPick[] = entries.filter((e) => e.rosterId && e.positionId).map((e) => ({ rosterId: e.rosterId!, positionId: e.positionId! }));
    if (picks.length > 0) {
      const earlier = await prisma.eventRegistration.findFirst({
        where: { eventId: event.id, memberId: member.id, status: { not: "CANCELED" } },
        select: { id: true },
      });
      const checked = await checkPicks({
        eventId: event.id,
        picks,
        approvalGated: policy.requiresCoachApproval,
        holdSpotDuringReview: policy.holdSpotDuringReview,
        excludeRegistrationId: earlier?.id ?? null,
      });
      if (!checked.ok) return NextResponse.json({ error: checked.code, message: checked.message }, { status: 409 });
    }
    const placeSpots = async (registrationId: string) => {
      if (entries.length === 0) return;
      await writeEntries({
        eventId: event.id,
        clubId: session.user.clubId,
        registrationId,
        entries,
        approvalGated: policy.requiresCoachApproval,
        holdSpotDuringReview: policy.holdSpotDuringReview,
      });
    };

    // Answers with no money attached (membership-covered or free events that
    // need no coach review) still have to live somewhere the roster reads, so
    // they get a plain REGISTERED row — nothing owed, no payment method.
    const recordAnswersOnly = async () => {
      if (!formData.formResponses && entries.length === 0) return;
      const existingReg = await prisma.eventRegistration.findFirst({
        where: { eventId: event.id, memberId: member.id, status: { not: "CANCELED" } },
        select: { id: true },
      });
      if (existingReg) {
        if (formData.formResponses) await prisma.eventRegistration.update({ where: { id: existingReg.id }, data: formData });
        await placeSpots(existingReg.id);
        return;
      }
      const created = await prisma.eventRegistration.create({
        data: {
          eventId: event.id,
          clubId: session.user.clubId,
          memberId: member.id,
          name: `${member.firstName} ${member.lastName ?? ""}`.trim(),
          email: contactEmail,
          phone: member.phone ?? null,
          status: "REGISTERED",
          confirmationCode: confirmationCodeFor(`${event.id}:${member.id}`),
          ...formData,
        },
      });
      await placeSpots(created.id);
    };

    // Phase 5 §5.4.5 — the no-money-owed paths (membership-covered, free, and
    // variable-cost-billed-later) still need a coach's yes on an approval-gated
    // event, so they record a REQUEST instead of a Booking. Same advisory lock
    // the paid path uses, so a double-tap converges on one row.
    const requestCoachReview = async (amountDue: number | null) => {
      const reg = await prisma.$transaction(async (db) => {
        await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`evreg:${event.id}:${member.id}`}, 0))`;
        const already = await db.eventRegistration.findFirst({
          where: { eventId: event.id, memberId: member.id, status: { not: "CANCELED" } },
          select: { id: true },
        });
        if (already) return already;
        return db.eventRegistration.create({
          data: {
            eventId: event.id,
            clubId: session.user.clubId,
            memberId: member.id,
            name: `${member.firstName} ${member.lastName ?? ""}`.trim(),
            email: contactEmail,
            phone: member.phone ?? null,
            status: "PENDING_REVIEW",
            ...formData,
            approvalStatus: "PENDING",
            approvalRequestedAt: new Date(),
            amountDue,
            confirmationCode: confirmationCodeFor(`${event.id}:${member.id}`),
          },
        });
      });
      await placeSpots(reg.id);
      await sendRegistrationLifecycleEmail({ registrationId: reg.id, transition: "CONFIRMATION" });
      return reg;
    };

    // Already booked?
    const existing = await prisma.booking.findUnique({
      where: { eventId_memberId: { eventId: event.id, memberId: member.id } },
    });
    if (existing) return NextResponse.json({ error: "You're already registered for this event." }, { status: 409 });

    // ── Event documents ─────────────────────────────────────────────────────
    // Enforced before ANY registration path (membership-covered, free, paid):
    // SIGN_REQUIRED docs need a valid signature (existing signing flow,
    // guardian + expiry rules included); ACKNOWLEDGE docs need an explicit
    // tick, recorded as a typed acknowledgement in the same audit trail.
    const missingDocs = await missingSignedEventDocs(session.user.clubId, event.id, member.id);
    if (missingDocs.length > 0) {
      return NextResponse.json(
        {
          error: "DOCUMENTS_REQUIRED",
          documents: missingDocs,
          message: `Before registering, please sign: ${missingDocs.map((d) => d.title).join(", ")}. You can sign in Documents.`,
        },
        { status: 403 },
      );
    }
    const ackDocs = await acknowledgementDocs(session.user.clubId, event.id);
    if (ackDocs.length > 0) {
      if (!acknowledgeDocuments) {
        return NextResponse.json(
          {
            error: "DOCUMENTS_ACKNOWLEDGE_REQUIRED",
            documents: ackDocs,
            message: `Please acknowledge: ${ackDocs.map((d) => d.title).join(", ")}.`,
          },
          { status: 400 },
        );
      }
      // Record the acknowledgement with the same machinery as signatures so
      // the owner's audit modal shows who acknowledged what, when, from where.
      const signerName = `${member.firstName} ${member.lastName ?? ""}`.trim();
      for (const d of ackDocs) {
        await prisma.documentSignature
          .upsert({
            where: { documentId_memberId: { documentId: d.id, memberId: member.id } },
            create: {
              documentId: d.id,
              memberId: member.id,
              signerUserId: session.user.id,
              signerName,
              relationship: member.userId === session.user.id ? "SELF" : "GUARDIAN",
              ipAddress: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
              userAgent: req.headers.get("user-agent") ?? null,
            },
            update: {},
          })
          .catch((e) => console.error("event doc acknowledgement record failed", e));
      }
    }

    const acceptedMembershipIds = (
      (event.pricingOptions as unknown as Array<{ type: string; membershipId?: string }> | null) || []
    )
      .filter((o) => o?.type === "membership" && o.membershipId)
      .map((o) => o.membershipId as string);

    // Membership-covered: free booking
    if (acceptedMembershipIds.length > 0) {
      const activeSub = await prisma.memberSubscription.findFirst({
        where: { memberId: member.id, membershipId: { in: acceptedMembershipIds }, status: "active" },
      });
      if (activeSub) {
        if (policy.requiresCoachApproval) {
          const reg = await requestCoachReview(null);
          return NextResponse.json({
            ok: true,
            pendingReview: true,
            coveredByMembership: true,
            registrationId: reg.id,
            message:
              "Request sent to your coach. Your membership covers this event — nothing is owed either way.",
          });
        }
        const status = event.capacity && event._count.bookings >= event.capacity ? "WAITLISTED" : "CONFIRMED";
        await prisma.booking.create({
          data: { eventId: event.id, memberId: member.id, status, bookedByUserId: session.user.id ?? null },
        });
        await recordAnswersOnly();
        if (status === "CONFIRMED") {
          const club = await prisma.club.findUnique({ where: { id: session.user.clubId }, select: { name: true } });
          emailBookingConfirmation({
            memberId: member.id,
            clubName: club?.name ?? "your club",
            eventName: event.name,
            startsAt: event.startsAt,
            endsAt: event.endsAt,
            coveredByMembership: true,
          });
        }
        return NextResponse.json({ coveredByMembership: true, status });
      }
    }

    // Variable-cost events (shared tournament cost): the member is registered
    // now but billed LATER by the owner via mass-invoice — it is NOT free.
    // Booking is created so they hold a spot; an EventRegistration row is
    // created so the owner can send an invoice/payment link when ready.
    const varTotal =
      event.variableCostTotal != null
        ? Number(event.variableCostTotal)
        : event.variableCostEstimatedTotal != null
          ? Number(event.variableCostEstimatedTotal)
          : 0;
    const hasVariableCost = !!event.variableCostEnabled && varTotal > 0;

    if (hasVariableCost) {
      // Estimated per-head is only known up front in ESTIMATED mode; OFFICIAL
      // splits the real total across actual signups at bill time.
      const estPerHead =
        event.variableCostMode === "ESTIMATED" &&
        event.variableCostEstimatedSignups &&
        event.variableCostEstimatedSignups > 0
          ? +(varTotal / event.variableCostEstimatedSignups).toFixed(2)
          : null;
      if (policy.requiresCoachApproval) {
        const reg = await requestCoachReview(estPerHead);
        return NextResponse.json({
          ok: true,
          pendingReview: true,
          variableCost: true,
          billedLater: true,
          registrationId: reg.id,
          confirmationUrl: registrationUrl(baseUrlFromRequest(req), event, reg.id),
          perHead: estPerHead,
          message: "Request sent to your coach. If they approve, the club bills your share of the shared cost.",
        });
      }
      const status = event.capacity && event._count.bookings >= event.capacity ? "WAITLISTED" : "CONFIRMED";
      await prisma.booking.create({
        data: { eventId: event.id, memberId: member.id, status, bookedByUserId: session.user.id ?? null },
      });

      // OFFICIAL mode splits the real total across actual signups at bill
      // time, so there is no per-head figure to record yet.
      const perHead = estPerHead;

      // Mirror as an EventRegistration so mass-invoice can reach this member.
      const already = await prisma.eventRegistration.findFirst({
        where: { eventId: event.id, memberId: member.id, status: { not: "CANCELED" } },
        select: { id: true },
      });
      if (!already) {
        const mirrored = await prisma.eventRegistration.create({
          data: {
            eventId: event.id,
            clubId: session.user.clubId,
            memberId: member.id,
            name: `${member.firstName} ${member.lastName}`.trim(),
            email: contactEmail,
            status: "REGISTERED",
            amountDue: perHead,
            ...formData,
          },
        });
        await placeSpots(mirrored.id);
      } else {
        await placeSpots(already.id);
      }

      return NextResponse.json({
        variableCost: true,
        billedLater: true,
        mode: event.variableCostMode ?? "ESTIMATED",
        perHead,
        status,
      });
    }

    // Genuinely free — no fixed price AND no variable cost AND no membership gate.
    const hasPrice = !!(event.memberPrice || event.nonMemberPrice || event.dropInFee);
    if (!hasPrice) {
      if (policy.requiresCoachApproval) {
        const reg = await requestCoachReview(null);
        return NextResponse.json({
          ok: true,
          pendingReview: true,
          free: true,
          registrationId: reg.id,
          confirmationUrl: registrationUrl(baseUrlFromRequest(req), event, reg.id),
          message: "Request sent to your coach. This event is free — nothing is owed either way.",
        });
      }
      const status = event.capacity && event._count.bookings >= event.capacity ? "WAITLISTED" : "CONFIRMED";
      await prisma.booking.create({
        data: { eventId: event.id, memberId: member.id, status, bookedByUserId: session.user.id ?? null },
      });
      await recordAnswersOnly();
      if (status === "CONFIRMED") {
        const club = await prisma.club.findUnique({ where: { id: session.user.clubId }, select: { name: true } });
        emailBookingConfirmation({
          memberId: member.id,
          clubName: club?.name ?? "your club",
          eventName: event.name,
          startsAt: event.startsAt,
          endsAt: event.endsAt,
          coveredByMembership: false,
        });
      }
      return NextResponse.json({ free: true, status });
    }

    // Paid path
    const club = await prisma.club.findUnique({ where: { id: session.user.clubId } });
    if (!club || !club.stripeAccountId || !club.stripeChargesEnabled) {
      return NextResponse.json({ error: "Your club hasn't enabled online payments yet." }, { status: 400 });
    }

    // Auto-detect: is this person an active member of the club? We do NOT
    // trust the client's pricingType for member vs non-member — the server
    // decides from real subscription state so a non-member can't pay the
    // member rate. The only client-driven choice is opting into DROP_IN
    // (single-session price), and only on multi-session events.
    //
    // Subscription rows ONLY. Member.status is a label that lags the rows it
    // describes (2026-09-13: three PROSPECT members held active paid
    // subscriptions), and `|| member.status === "ACTIVE"` also let a stale
    // ACTIVE label buy member pricing with no membership behind it. Same rule
    // as lib/attendanceBilling.ts and portalMembershipStatusFor.
    const activeSubCount = await prisma.memberSubscription.count({
      where: { memberId: member.id, status: "active" },
    });
    const isActiveMember = activeSubCount > 0;
    const isMultiSession = event.sessions.length > 1;

    const memberCents = event.memberPrice != null ? Math.round(Number(event.memberPrice) * 100) : null;
    const nonMemberCents =
      event.nonMemberPrice != null ? Math.round(Number(event.nonMemberPrice) * 100) : null;
    const dropInCents = event.dropInFee != null ? Math.round(Number(event.dropInFee) * 100) : null;

    let priceCents = 0;
    let priceLabel = "";

    // Slice 2 — which sessions this registration is for. Empty = whole event.
    let purchasedSessionIds: string[] = [];
    if (pricingType === "DROP_IN" && body.sessionIds && body.sessionIds.length > 0) {
      // Per-session purchase: the price is the sum of the chosen sessions'
      // own prices (lib/eventPricingModel.quoteSessions), never the old
      // single drop-in fee. The chosen sessions are stored on the registration
      // so the roster, the receipt and check-in all know what was bought.
      const quote = quoteSessions({
        pricingModel: (event.pricingModel as "FREE" | "FIXED" | "SPLIT") ?? "FIXED",
        sellIndividualSessions: !!event.sellIndividualSessions,
        sessions: event.sessions,
        requestedIds: body.sessionIds,
      });
      if (!quote.ok) return NextResponse.json({ error: quote.error }, { status: 400 });
      priceCents = quote.cents;
      priceLabel = quote.label;
      purchasedSessionIds = quote.sessionIds;
    } else if (pricingType === "DROP_IN") {
      // Drop-in = pay for a single session. Only valid on multi-session events.
      if (!isMultiSession) {
        return NextResponse.json(
          { error: "Drop-in pricing is only available for events with multiple sessions." },
          { status: 400 },
        );
      }
      if (dropInCents == null) {
        return NextResponse.json(
          { error: "This event doesn't offer a single-session drop-in price." },
          { status: 400 },
        );
      }
      priceCents = dropInCents;
      priceLabel = "Drop-in (single session)";
    } else if (isActiveMember) {
      // Active member → member price (full event). Fall back to non-member
      // price if the club only set one number.
      priceCents = memberCents ?? nonMemberCents ?? dropInCents ?? 0;
      priceLabel = memberCents != null ? "Member" : nonMemberCents != null ? "Non-member" : "Drop-in";
    } else {
      // Non-member → full event (non-member) price.
      priceCents = nonMemberCents ?? memberCents ?? dropInCents ?? 0;
      priceLabel =
        nonMemberCents != null ? "Non-member" : memberCents != null ? "Member" : "Drop-in";
    }

    if (priceCents <= 0) {
      return NextResponse.json({ error: "No price configured" }, { status: 400 });
    }
    // B16 — more than one entry: N × the price, or the first at the price and
    // the rest at the owner's additional-entry price. Before the discount, so
    // a code applies to what the family actually owes.
    if (entries.length > 1) {
      priceCents = entriesTotalCents(
        priceCents,
        entries.length,
        event.additionalEntryPrice != null ? Math.round(Number(event.additionalEntryPrice) * 100) : null,
      );
      priceLabel = `${priceLabel} · ${entries.length} entries`;
    }

    // Optional discount code (EVENT scope) — applied to the server-resolved
    // tier price before the parental gate and Stripe see the amount.
    // The tier price BEFORE any discount — kept so the registration can record
    // how much the code actually took off (amountDue + discountAmount = this).
    const grossPrice = priceCents / 100;
    let discount: ValidDiscount | null = null;
    if (discountCode?.trim()) {
      const check = await findValidDiscountFor(session.user.clubId, discountCode, {
        type: "EVENT",
        // Scoped to THIS event, so a code limited to the College Combine is
        // refused on anything else instead of silently discounting it.
        eventId: event.id,
      });
      if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
      discount = check.discount;
      priceCents = Math.round(discountedPrice(priceCents / 100, discount) * 100);
      priceLabel = `${priceLabel} · code ${discount.code}`;
    }

    // A 100%-off code books directly — same shape as the free path above.
    if (discount && priceCents <= 0) {
      const status = event.capacity && event._count.bookings >= event.capacity ? "WAITLISTED" : "CONFIRMED";
      await prisma.booking.create({
        data: { eventId: event.id, memberId: member.id, status, bookedByUserId: session.user.id ?? null },
      });
      await recordDiscountUse(discount.id);
      if (status === "CONFIRMED") {
        const clubName = (await prisma.club.findUnique({ where: { id: session.user.clubId }, select: { name: true } }))?.name;
        emailBookingConfirmation({
          memberId: member.id,
          clubName: clubName ?? "your club",
          eventName: event.name,
          startsAt: event.startsAt,
          endsAt: event.endsAt,
          coveredByMembership: false,
        });
      }
      return NextResponse.json({ free: true, status });
    }

    // P4 parental gate. Applied after final price is known + before
    // Stripe so a controlled minor sees "Sent to your guardian" instead
    // of a Stripe redirect. Replay payload mirrors the original POST so
    // the approval flow can re-invoke this endpoint cleanly.
    const gate = await applyParentalControls({
      member: {
        id: member.id,
        clubId: session.user.clubId,
        userId: member.userId,
        isMinor: member.isMinor,
        dateOfBirth: member.dateOfBirth,
        parentControls: member.parentControls,
      },
      bookerUserId: session.user.id,
      // The resolved member is a guardianed child when its own login isn't the
      // booker (own profile → userId === booker; child → null or the child's
      // own userId). A guardian booking for their child is the oversight.
      bookerIsGuardian: member.userId !== session.user.id,
      kind: "EVENT_REGISTER",
      amount: priceCents / 100,
      payload: {
        eventId: event.id,
        pricingType,
        memberId: member.id,
        ...(discount ? { discountCode: discount.code } : {}),
      },
    });
    if (gate.kind === "block") {
      return NextResponse.json(gate.body, { status: gate.status });
    }
    if (gate.kind === "queue") {
      return NextResponse.json(gate.response, { status: 202 });
    }

    // ── Payment decision ────────────────────────────────────────────────────
    // The registrant picks a method the owner allows for this event. AUTO_CARD
    // additionally needs a saved card + explicit consent. Everything except
    // CARD confirms the spot now and settles the money later.
    const allowed = eventAllowedPaymentMethods(event);
    const price = priceCents / 100;
    const registrantName = `${member.firstName} ${member.lastName ?? ""}`.trim();

    // Mirror the booking as an EventRegistration so the money is trackable in
    // the same place as public signups (outstanding lists, invoicing, receipts).
    // Locals keep the null-narrowing a hoisted function body would lose.
    const regEventId = event.id;
    const regClubId = session.user.clubId;
    const regMemberId = member.id;
    const regEmail = contactEmail;
    const regPhone = member.phone ?? null;
    const upsertRegistrationRow = async (data: {
      status: string;
      method: EventPaymentMethod | "SAVED_CARD";
      scheduledChargeAt?: Date | null;
      consent?: Prisma.InputJsonValue;
    }) =>
      // event_registrations has NO unique on (eventId, memberId) — historical
      // public rows can legitimately duplicate. So this select-then-write is
      // serialized with a transaction-scoped advisory lock instead: without
      // it, a double-click on "Pay now with saved card" creates TWO SCHEDULED
      // rows, and two registrations means two idempotency keys — a real
      // double charge. With the lock both clicks converge on one row (and the
      // charge engine's PI dedupe covers the rest).
      prisma.$transaction(async (db) => {
        await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`evreg:${regEventId}:${regMemberId}`}, 0))`;
        const existing = await db.eventRegistration.findFirst({
          where: { eventId: regEventId, memberId: regMemberId, status: { not: "CANCELED" } },
          select: { id: true, status: true, transactionId: true },
        });
        // Never re-open a settled registration: replacing a PAID row's payment
        // decision would ask for money that's already been collected.
        if (existing?.status === "PAID") return existing;
        const fields = {
          status: data.status,
          paymentMethod: data.method,
          // `price` is already net of the discount (applied to the tier price
          // above). The rule is stored alongside it so the roster can explain
          // the number and repricing can't erase it — the autoChargeConsent
          // blob is no longer the only record of which code applied.
          amountDue: price,
          discountId: discount?.id ?? null,
          discountCode: discount?.code ?? null,
          discountType: discount?.type ?? null,
          discountValue: discount?.value ?? null,
          discountAmount: discount ? Math.round((grossPrice - price) * 100) / 100 : null,
          scheduledChargeAt: data.scheduledChargeAt ?? null,
          sessionIds: purchasedSessionIds,
          ...(data.consent !== undefined ? { autoChargeConsent: data.consent } : {}),
          // Only when answers exist, so a payment-method change on an existing
          // row never blanks the answers it already has.
          ...formData,
        };
        if (existing) {
          // This row's payment decision is being replaced (e.g. they registered
          // for cash earlier and are now choosing the saved card). Void the
          // PENDING offline row first — otherwise it's orphaned: unreachable
          // from any registration, permanently PENDING, and permanently
          // inflating "money owed". Same rule the webhook applies when a cash
          // registrant pays online instead.
          if (existing.transactionId) {
            await db.transaction.updateMany({
              where: { id: existing.transactionId, clubId: regClubId, status: "PENDING" },
              data: {
                status: "FAILED",
                reconciliationStatus: "VOID",
                notes: "Superseded — the registrant changed how they're paying.",
              },
            });
          }
          return db.eventRegistration.update({
            where: { id: existing.id },
            data: { ...fields, transactionId: null },
          });
        }
        return db.eventRegistration.create({
          data: {
            eventId: regEventId,
            clubId: regClubId,
            memberId: regMemberId,
            name: registrantName,
            email: regEmail,
            phone: regPhone,
            ...fields,
          },
        });
      });

    // Every paid path writes through here, so the roster spot follows the row.
    const upsertRegistration = async (data: Parameters<typeof upsertRegistrationRow>[0]) => {
      const reg = await upsertRegistrationRow(data);
      await placeSpots(reg.id);
      return reg;
    };

    let savedCardAvailable = false;
    if (allowed.includes("AUTO_CARD") || allowed.includes("CARD")) {
      const customerId = member.stripeSetupCustomerId ?? member.stripeCustomerId;
      savedCardAvailable = !!(await resolveChargeablePaymentMethodId(
        customerId,
        club.stripeAccountId,
        member.stripeSetupPaymentMethodId,
      ));
    }
    // ══ Coach approval (§5.4.5) ══════════════════════════════════════════════
    // When the event requires approval, the create path forks BEFORE any
    // charge or Checkout call. Nothing here creates a Booking: Booking is the
    // confirmed-spot primitive that member calendars and rosters read, and a
    // spot no coach has agreed to must not appear on any of them. The approve
    // route creates it.
    if (policy.requiresCoachApproval) {
      const customerId = member.stripeSetupCustomerId ?? member.stripeCustomerId;
      // No approval intent set (the event editor's default) ⇒ the event's own
      // "How people pay" menu decides. Before 2026-09-24 this path offered
      // "Bill me if approved" regardless, so an event set to "saved card,
      // charged Nov 14" registered families as INVOICE (Finger Lakes Duals).
      const followEventMenu = !policy.approvalPaymentIntent;
      const parentPicks = followEventMenu || policy.approvalPaymentIntent === "PARENT_CHOOSES";

      // What the parent may pick. The saved-card options only appear when
      // there is genuinely a chargeable card, so a card charge can never be
      // selected by someone who has none on file.
      const approvalOptions = followEventMenu
        ? approvalOptionsFromEventMethods(allowed, savedCardAvailable)
        : [
            ...(savedCardAvailable ? ["APPROVAL_CHARGE"] : []),
            "INVOICE",
            ...allowed.filter((m) => m === "CASH" || m === "CHECK"),
            ...(allowed.includes("CARD") ? ["CARD"] : []),
          ];

      if (followEventMenu && approvalOptions.length === 0) {
        const chargeOn = eventScheduledChargeAt(event).toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
          timeZone: "UTC",
        });
        return NextResponse.json(
          {
            error: "PAYMENT_SETUP_REQUIRED",
            message: `This event charges a saved card on ${chargeOn} if your coach approves. Add a card first — nothing is charged today.`,
            setupUrl: "/member/profile",
          },
          { status: 402 },
        );
      }

      const intent = parentPicks ? (paymentMethod ?? null) : policy.approvalPaymentIntent;

      if (!intent || (parentPicks && !approvalOptions.includes(intent))) {
        const fee = applyProcessingFee(priceCents, club.passProcessingFees);
        const card = savedCardAvailable ? await resolveCardSnapshot(customerId, club.stripeAccountId) : null;
        return NextResponse.json(
          {
            error: "PAYMENT_METHOD_REQUIRED",
            requiresCoachApproval: true,
            message:
              "Registration isn't confirmed until the coach reviews it. Choose how you'd like to pay if they approve.",
            options: approvalOptions,
            quote: {
              base: price,
              cardFee: fee.feeCents / 100,
              cardTotal: fee.totalCents / 100,
              offlineTotal: price,
            },
            savedCard: card ? { label: `${prettyBrand(card.brand)} ····${card.last4}` } : null,
          },
          { status: 400 },
        );
      }

      const stampCode = async (id: string) => {
        await prisma.eventRegistration
          .updateMany({ where: { id, confirmationCode: null }, data: { confirmationCode: confirmationCodeFor(id) } })
          .catch(() => undefined);
      };

      // Saved card, charged on the event's charge date — but only once a coach
      // approves. Nothing is scheduled while the row is PENDING_REVIEW (the
      // charge engine sweeps SCHEDULED rows only); lib/eventApproval moves it
      // to SCHEDULED at the charge date on approval, and a decline leaves
      // nothing to undo.
      if (intent === "AUTO_CARD") {
        const pmId = await resolveChargeablePaymentMethodId(
          customerId,
          club.stripeAccountId,
          member.stripeSetupPaymentMethodId,
        );
        const chargeAt = eventScheduledChargeAt(event);
        const chargeOn = chargeAt.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
        // What the card will actually see — the processing fee included when
        // the club passes it on, same figure the payment picker quoted.
        const cardTotal = applyProcessingFee(priceCents, club.passProcessingFees).totalCents / 100;
        if (!pmId) {
          return NextResponse.json(
            {
              error: "PAYMENT_SETUP_REQUIRED",
              message: `Add a card first — it's charged on ${chargeOn} only if your coach approves this registration.`,
              setupUrl: "/member/profile",
            },
            { status: 402 },
          );
        }
        if (!autoChargeConsent?.agreed) {
          return NextResponse.json(
            {
              error: "CONSENT_REQUIRED",
              message: `Please confirm you authorize a $${cardTotal.toFixed(2)} charge on ${chargeOn} if your coach approves.`,
            },
            { status: 400 },
          );
        }
        const reg = await upsertRegistration({
          status: "PENDING_REVIEW",
          method: "AUTO_CARD",
          scheduledChargeAt: null,
          consent: {
            at: new Date().toISOString(),
            kind: "AUTO_CARD_AFTER_APPROVAL",
            userId: session.user.id ?? null,
            memberId: regMemberId,
            email: regEmail || null,
            ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
            userAgent: req.headers.get("user-agent") ?? null,
            buttonLabel: autoChargeConsent?.buttonLabel ?? null,
            amount: price,
            chargeOn: chargeAt.toISOString(),
            ...(discount ? { discountCode: discount.code } : {}),
          } as Prisma.InputJsonValue,
        });
        await prisma.eventRegistration.update({
          where: { id: reg.id },
          data: { approvalStatus: "PENDING", approvalRequestedAt: new Date() },
        });
        await stampCode(reg.id);
        if (discount) await recordDiscountUse(discount.id);
        await sendRegistrationLifecycleEmail({ registrationId: reg.id, transition: "CONFIRMATION" });
        return NextResponse.json({
          ok: true,
          pendingReview: true,
          registrationId: reg.id,
          confirmationUrl: registrationUrl(baseUrlFromRequest(req), event, reg.id),
          paymentMethod: "AUTO_CARD",
          amountDue: price,
          message: `Request sent to your coach. Nothing is charged today — if they approve, your card is charged $${cardTotal.toFixed(2)} on ${chargeOn}.`,
        });
      }

      if (intent === "APPROVAL_CHARGE") {
        // The card is verified as chargeable NOW, at the moment consent is
        // given — not at approval time, when the parent is not around to fix
        // it. Families replace cards; a stored pointer goes stale silently.
        const pmId = await resolveChargeablePaymentMethodId(
          customerId,
          club.stripeAccountId,
          member.stripeSetupPaymentMethodId,
        );
        if (!pmId) {
          return NextResponse.json(
            {
              error: "PAYMENT_SETUP_REQUIRED",
              message: "Add a card first — it's charged only if your coach approves this registration.",
              setupUrl: "/member/profile",
            },
            { status: 402 },
          );
        }
        if (!autoChargeConsent?.agreed) {
          return NextResponse.json(
            {
              error: "CONSENT_REQUIRED",
              message: `Please confirm you authorize a $${price.toFixed(2)} charge if your coach approves.`,
            },
            { status: 400 },
          );
        }
        const reg = await upsertRegistration({
          status: "PENDING_REVIEW",
          method: "APPROVAL_CHARGE" as EventPaymentMethod,
          // Deliberately null: nothing is scheduled until a coach approves.
          // The approve route sets it to `now` and hands the row to the
          // existing charge engine (§5.4.6).
          scheduledChargeAt: null,
          consent: {
            at: new Date().toISOString(),
            kind: "APPROVAL_CHARGE",
            userId: session.user.id ?? null,
            memberId: regMemberId,
            email: regEmail || null,
            ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
            userAgent: req.headers.get("user-agent") ?? null,
            buttonLabel: autoChargeConsent?.buttonLabel ?? null,
            amount: price,
            chargeOn: "coach approval",
            ...(discount ? { discountCode: discount.code } : {}),
          } as Prisma.InputJsonValue,
        });
        await prisma.eventRegistration.update({
          where: { id: reg.id },
          data: { approvalStatus: "PENDING", approvalRequestedAt: new Date() },
        });
        await stampCode(reg.id);
        if (discount) await recordDiscountUse(discount.id);
        await sendRegistrationLifecycleEmail({ registrationId: reg.id, transition: "CONFIRMATION" });
        return NextResponse.json({
          ok: true,
          pendingReview: true,
          registrationId: reg.id,
          confirmationUrl: registrationUrl(baseUrlFromRequest(req), event, reg.id),
          paymentMethod: "APPROVAL_CHARGE",
          amountDue: price,
          message: `Request sent to your coach. Nothing is charged yet — your card is charged $${price.toFixed(2)} only if they approve.`,
        });
      }

      if (intent === "INVOICE") {
        const reg = await upsertRegistration({ status: "PENDING_REVIEW", method: "INVOICE" as EventPaymentMethod });
        await prisma.eventRegistration.update({
          where: { id: reg.id },
          data: { approvalStatus: "PENDING", approvalRequestedAt: new Date() },
        });
        await stampCode(reg.id);
        if (discount) await recordDiscountUse(discount.id);
        await sendRegistrationLifecycleEmail({ registrationId: reg.id, transition: "CONFIRMATION" });
        return NextResponse.json({
          ok: true,
          pendingReview: true,
          registrationId: reg.id,
          confirmationUrl: registrationUrl(baseUrlFromRequest(req), event, reg.id),
          paymentMethod: "INVOICE",
          amountDue: price,
          message: `Request sent to your coach. No card needed now — the club emails a payment link for $${price.toFixed(2)} once they approve.`,
        });
      }

      if (intent === "CASH" || intent === "CHECK" || intent === "CASH_CHECK") {
        const method = intent === "CASH_CHECK" ? (paymentMethod === "CHECK" ? "CHECK" : "CASH") : intent;
        // Same as today: acceptance is not payment. One PENDING offline
        // Transaction records what is owed; approval decides whether it is
        // ever collected, and a decline voids it.
        const reg = await upsertRegistration({ status: offlineStatusForMethod(method), method });
        const tx = await createEventOfflinePendingTx({
          clubId: session.user.clubId,
          eventId: event.id,
          memberId: member.id,
          amount: price,
          method,
          eventName: event.name,
          registrantName,
          discountCode: discount?.code ?? null,
        });
        await prisma.eventRegistration.update({
          where: { id: reg.id },
          data: { transactionId: tx.id, approvalStatus: "PENDING", approvalRequestedAt: new Date() },
        });
        await stampCode(reg.id);
        if (discount) await recordDiscountUse(discount.id);
        await sendRegistrationLifecycleEmail({ registrationId: reg.id, transition: "CONFIRMATION" });
        return NextResponse.json({
          ok: true,
          pendingReview: true,
          registrationId: reg.id,
          confirmationUrl: registrationUrl(baseUrlFromRequest(req), event, reg.id),
          offline: true,
          paymentMethod: method,
          amountDue: price,
          message: `Request sent to your coach. If they approve, bring $${price.toFixed(2)} in ${method.toLowerCase()} to the event.`,
        });
      }

      // CARD — pay in full now, still awaiting the coach. This is the one
      // approval branch where money moves before a decision, so the decline
      // path refunds unconditionally (§5.4.6). The registration row is created
      // up front (the non-approval CARD path has none) so the webhook has
      // somewhere to record PAID without inventing a spot.
      const reg = await upsertRegistration({ status: "PENDING_PAYMENT", method: "CARD" });
      await prisma.eventRegistration.update({
        where: { id: reg.id },
        data: { approvalStatus: "PENDING", approvalRequestedAt: new Date() },
      });
      await stampCode(reg.id);
      const feeItem = processingFeeLineItem(priceCents, club.passProcessingFees);
      const checkout = await stripe.checkout.sessions.create(
        {
          mode: "payment",
          customer_email: regEmail || undefined,
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: "usd",
                unit_amount: priceCents,
                product_data: {
                  name: event.name,
                  description: `${priceLabel} price · refunded in full if your coach can't approve`,
                },
              },
            },
            ...(feeItem ? [feeItem] : []),
          ],
          // The live confirmation surface, from the origin the member is
          // actually on (§5.2.3). /member/events?paid=true rendered success
          // from a query parameter and told an approval-gated registrant they
          // were registered when a coach hadn't looked yet.
          success_url: registrationReturnUrl(baseUrlFromRequest(req), event, reg.id, "paid"),
          cancel_url: registrationReturnUrl(baseUrlFromRequest(req), event, reg.id, "canceled"),
          payment_intent_data: {
            application_fee_amount: calculatePlatformFee(priceCents, club.tier),
            metadata: { eventRegistrationId: reg.id, eventId: event.id, clubId: club.id, memberId: member.id },
          },
          metadata: { eventRegistrationId: reg.id, eventId: event.id, clubId: club.id, memberId: member.id },
        },
        { stripeAccount: club.stripeAccountId },
      );
      await prisma.eventRegistration.update({
        where: { id: reg.id },
        data: { stripeCheckoutSessionId: checkout.id },
      });
      if (discount) await recordDiscountUse(discount.id);
      return NextResponse.json({ url: checkout.url, registrationId: reg.id, pendingReview: true });
    }

    // Methods the client can actually complete right now. SAVED_CARD (pay now
    // with the card on file) rides on CARD permission + a verified saved card.
    const selectable: string[] = [
      ...(allowed.includes("CARD") && savedCardAvailable ? ["SAVED_CARD"] : []),
      ...allowed.filter((m) => (m === "AUTO_CARD" ? savedCardAvailable : true)),
    ];

    // A payment decision is required whenever there's more than one way to
    // pay. The old code defaulted to CARD here, which sent members straight to
    // Stripe without ever seeing the choice.
    // APPROVAL_CHARGE and INVOICE only exist on approval-gated events, and
    // that fork returned above — on a normal event they are not offered, so a
    // client sending one falls through to "you have to choose" rather than
    // being honored.
    const standardChoice =
      paymentMethod === "APPROVAL_CHARGE" || paymentMethod === "INVOICE" ? undefined : paymentMethod;
    const chosen: EventPaymentMethod | "SAVED_CARD" | null =
      standardChoice ?? (selectable.length === 1 ? (selectable[0] as EventPaymentMethod) : null);
    if (!chosen) {
      // Exact totals per method so the client confirms the real number: card
      // methods include the processing fee when the club passes it; cash and
      // check owe the sticker price.
      const fee = applyProcessingFee(priceCents, club.passProcessingFees);
      const customerId = member.stripeSetupCustomerId ?? member.stripeCustomerId;
      const card = savedCardAvailable ? await resolveCardSnapshot(customerId, club.stripeAccountId) : null;
      const [allDocs, missingSign, ackDocs2] = await Promise.all([
        documentsForEvent(session.user.clubId, event.id),
        missingSignedEventDocs(session.user.clubId, event.id, member.id),
        acknowledgementDocs(session.user.clubId, event.id),
      ]);
      const missingIds = new Set(missingSign.map((d) => d.id));
      const ackIds = new Set(ackDocs2.map((d) => d.id));
      return NextResponse.json(
        {
          error: "PAYMENT_METHOD_REQUIRED",
          message: "Choose how you'd like to pay.",
          options: selectable,
          quote: {
            base: price,
            cardFee: fee.feeCents / 100,
            cardTotal: fee.totalCents / 100,
            offlineTotal: price,
          },
          savedCard: card ? { label: `${prettyBrand(card.brand)} ····${card.last4}` } : null,
          documents: allDocs.map((d) => ({
            id: d.id,
            title: d.title,
            requirement: d.requirement,
            requirementLabel: EVENT_DOC_REQUIREMENT_LABELS[d.requirement],
            needsSignature: missingIds.has(d.id),
            needsAcknowledgement: ackIds.has(d.id),
          })),
        },
        { status: 400 },
      );
    }
    if (!selectable.includes(chosen)) {
      const reason =
        chosen === "AUTO_CARD" && allowed.includes("AUTO_CARD")
          ? "You don't have a saved card yet — add one in your profile, or choose another way to pay."
          : `${chosen === "SAVED_CARD" ? "Paying now with a saved card" : EVENT_PAYMENT_METHOD_LABELS[chosen]} isn't available for this event.`;
      return NextResponse.json({ error: "PAYMENT_METHOD_NOT_ALLOWED", message: reason }, { status: 400 });
    }

    // ── Pay now with the saved card ─────────────────────────────────────────
    // The client explicitly confirmed the exact total on the button. Reuses
    // the scheduled-charge engine with "now" as the date — same idempotency
    // key discipline, same VERIFIED Transaction, same receipt + audit. The
    // Booking is created ONLY after Stripe confirms: a failed charge books
    // nothing and marks nothing paid.
    if (chosen === "SAVED_CARD") {
      const reg = await upsertRegistration({
        status: "SCHEDULED",
        method: "SAVED_CARD",
        scheduledChargeAt: new Date(),
        // Not a consent record (the click IS the confirmation) — this carries
        // the discount identity the charge engine stamps onto the Transaction.
        consent: discount ? { kind: "SAVED_CARD_NOW", discountCode: discount.code } : { kind: "SAVED_CARD_NOW" },
      });
      if (reg.status === "PAID") {
        return NextResponse.json({ error: "This registration is already paid." }, { status: 409 });
      }
      const result = await chargeEventRegistration(reg.id);
      if (result.outcome !== "succeeded") {
        return NextResponse.json(
          {
            error: "CHARGE_FAILED",
            outcome: result.outcome,
            message:
              result.outcome === "processing"
                ? "Your payment is processing — check back shortly."
                : result.error || "The card charge didn't go through. Choose another way to pay.",
          },
          { status: result.outcome === "processing" ? 202 : 402 },
        );
      }
      const bookingStatus =
        event.capacity && event._count.bookings >= event.capacity ? "WAITLISTED" : "CONFIRMED";
      try {
        await prisma.booking.create({
          data: {
            eventId: event.id,
            memberId: member.id,
            status: bookingStatus,
            // §5.4.8 — who DID the booking, as distinct from who it's for. A
            // guardian registering a child is the common case.
            bookedByUserId: session.user.id ?? null,
          },
        });
      } catch {
        // Unique (eventId, memberId) — a concurrent request already booked it.
      }
      // Redemption is counted inside the charge engine, gated on Transaction
      // creation — route-level counting here double-counted when two
      // concurrent confirms both saw the replayed PaymentIntent succeed.
      return NextResponse.json({
        ok: true,
        paid: true,
        status: bookingStatus,
        message: `Paid — you're ${bookingStatus === "WAITLISTED" ? "on the waitlist" : "registered"}. A receipt is on its way.`,
      });
    }

    if (chosen === "AUTO_CARD" || chosen === "CASH" || chosen === "CHECK") {
      if (chosen === "AUTO_CARD" && !autoChargeConsent?.agreed) {
        return NextResponse.json(
          {
            error: "CONSENT_REQUIRED",
            message: "Please confirm you authorize the charge on the event date.",
          },
          { status: 400 },
        );
      }

      const bookingStatus =
        event.capacity && event._count.bookings >= event.capacity ? "WAITLISTED" : "CONFIRMED";
      await prisma.booking.create({
        data: {
          eventId: event.id,
          memberId: member.id,
          status: bookingStatus,
          bookedByUserId: session.user.id ?? null,
        },
      });

      // Waitlisted = no spot, so no money. Scheduling a card charge or telling
      // someone to bring cash for an event they haven't got into would be an
      // unattended charge against a non-attendee. They're on the list; the
      // payment decision is made when (if) they're promoted.
      if (bookingStatus === "WAITLISTED") {
        return NextResponse.json({
          ok: true,
          waitlisted: true,
          status: bookingStatus,
          message:
            "You're on the waitlist — nothing is owed yet. The club will be in touch if a spot opens up.",
        });
      }

      if (chosen === "AUTO_CARD") {
        const chargeAt = eventScheduledChargeAt(event);
        await upsertRegistration({
          status: "SCHEDULED",
          method: chosen,
          scheduledChargeAt: chargeAt,
          consent: {
            at: new Date().toISOString(),
            userId: session.user.id ?? null,
            memberId: regMemberId,
            email: regEmail || null,
            ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
            userAgent: req.headers.get("user-agent") ?? null,
            buttonLabel: autoChargeConsent?.buttonLabel ?? null,
            amount: price,
            chargeOn: chargeAt.toISOString(),
            ...(discount ? { discountCode: discount.code } : {}),
          } as Prisma.InputJsonValue,
        });
        if (discount) await recordDiscountUse(discount.id);
        if (bookingStatus === "CONFIRMED") {
          emailBookingConfirmation({
            memberId: member.id,
            clubName: club.name,
            eventName: event.name,
            startsAt: event.startsAt,
            endsAt: event.endsAt,
            coveredByMembership: false,
          });
        }
        return NextResponse.json({
          ok: true,
          scheduled: true,
          paymentMethod: chosen,
          status: bookingStatus,
          amountDue: price,
          chargeOn: chargeAt,
        });
      }

      // Cash / check — acceptance is not payment. One PENDING offline
      // Transaction records the amount due; staff records receipt later.
      const reg = await upsertRegistration({ status: offlineStatusForMethod(chosen), method: chosen });
      const tx = await createEventOfflinePendingTx({
        clubId: session.user.clubId,
        eventId: event.id,
        memberId: member.id,
        amount: price,
        method: chosen,
        eventName: event.name,
        registrantName,
        discountCode: discount?.code ?? null,
      });
      await prisma.eventRegistration.update({
        where: { id: reg.id },
        data: { transactionId: tx.id },
      });
      if (discount) await recordDiscountUse(discount.id);
      if (bookingStatus === "CONFIRMED") {
        emailBookingConfirmation({
          memberId: member.id,
          clubName: club.name,
          eventName: event.name,
          startsAt: event.startsAt,
          endsAt: event.endsAt,
          coveredByMembership: false,
        });
      }
      return NextResponse.json({
        ok: true,
        offline: true,
        paymentMethod: chosen,
        status: bookingStatus,
        amountDue: price,
        message: `You're registered. Please bring $${price.toFixed(2)} in ${chosen.toLowerCase()} to the event.`,
      });
    }

    // CARD — pay now. The webhook creates the Booking on confirmed payment.
    //
    // This is the one path that does NOT land on the confirmation surface, and
    // deliberately so: it creates no EventRegistration row (the webhook's
    // memberId+eventId branch books it), so there is no registration to point
    // at. Giving it one would reroute a live, high-traffic money path through
    // the eventRegistrationId webhook branch, which is a different change than
    // the three §5.2.1 bugs and doesn't belong in the same commit. A signed-in
    // member lands in their portal, where the booking now exists.
    //
    // What IS fixed here is the origin: baseUrlFromRequest, so a Netlify
    // preview returns to itself instead of bouncing to production.
    const platformFee = calculatePlatformFee(priceCents, club.tier);
    const baseUrl = baseUrlFromRequest(req);
    const feeItem = processingFeeLineItem(priceCents, club.passProcessingFees);

    // An event that asks questions needs somewhere to keep the answers, and
    // this path otherwise writes no registration until the webhook. So for
    // those events only, the row is created now (PENDING_PAYMENT holds nothing
    // — see capacityWhere) and Checkout completes it through the same
    // eventRegistrationId webhook branch the approval CARD path already uses.
    // Events without questions keep the path exactly as it was.
    if (formData.formResponses || entries.length > 0) {
      const reg = await upsertRegistration({ status: "PENDING_PAYMENT", method: "CARD" });
      await prisma.eventRegistration
        .updateMany({ where: { id: reg.id, confirmationCode: null }, data: { confirmationCode: confirmationCodeFor(reg.id) } })
        .catch(() => undefined);
      const checkout = await stripe.checkout.sessions.create(
        {
          mode: "payment",
          customer_email: regEmail || undefined,
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: "usd",
                unit_amount: priceCents,
                product_data: { name: event.name, description: `${priceLabel} price · ${event.type}` },
              },
            },
            ...(feeItem ? [feeItem] : []),
          ],
          success_url: registrationReturnUrl(baseUrl, event, reg.id, "paid"),
          cancel_url: registrationReturnUrl(baseUrl, event, reg.id, "canceled"),
          payment_intent_data: {
            application_fee_amount: platformFee,
            metadata: { eventRegistrationId: reg.id, clubId: club.id },
          },
          metadata: {
            eventRegistrationId: reg.id,
            clubId: club.id,
            ...(discount ? { discountCode: discount.code } : {}),
          },
        },
        { stripeAccount: club.stripeAccountId },
      );
      await prisma.eventRegistration.update({ where: { id: reg.id }, data: { stripeCheckoutSessionId: checkout.id } });
      if (discount) await recordDiscountUse(discount.id);
      return NextResponse.json({ url: checkout.url, registrationId: reg.id });
    }

    const checkoutSession = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: priceCents,
              product_data: {
                name: event.name,
                description: `${priceLabel} price · ${event.type}`,
              },
            },
          },
          ...(feeItem ? [feeItem] : []),
        ],
        success_url: `${baseUrl}/member/events?paid=true`,
        cancel_url:  `${baseUrl}/member/events?canceled=true`,
        payment_intent_data: {
          application_fee_amount: platformFee,
          metadata: {
            memberId: member.id,
            eventId: event.id,
            eventName: event.name,
            clubId: club.id,
          },
        },
        metadata: {
          memberId: member.id,
          eventId: event.id,
          eventName: event.name,
          clubId: club.id,
          ...(discount ? { discountCode: discount.code } : {}),
        },
      },
      { stripeAccount: club.stripeAccountId }
    );

    if (discount) await recordDiscountUse(discount.id);
    return NextResponse.json({ url: checkoutSession.url });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
