import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { MEMBER_EVENT_INCLUDE, loadMemberEventContext, memberVisibleEventWhere, shapeForMember } from "@/lib/memberEventsServer";
import { documentsForEvent, missingSignedEventDocs, EVENT_DOC_REQUIREMENT_LABELS } from "@/lib/eventDocuments";
import { eventFormFields } from "@/lib/eventForm";
import { eventAllowedPaymentMethods, eventScheduledChargeAt, resolveEventPolicy } from "@/lib/eventPayments";
import { applyProcessingFee, feePolicyFor } from "@/lib/fees";
import { mapsDirectionsUrl } from "@/lib/maps";
import type { PaymentMethodKey, PricingKind } from "@/lib/eventDetailsView";

// GET /api/member/events/[id]?memberId=<athlete>
//
// Everything a family needs to decide before registering, for ONE event. The
// event itself comes in exactly the shape the Events list sends (so the one
// register flow reads the same fields wherever it starts), plus `details`.
//
// Visibility: lib/memberEventsServer, the same rules as the list. An event the
// family can't see answers 404 — the same answer as one that doesn't exist,
// so the address reveals nothing. Nothing about other families is read or
// sent: spots are a count, and the athletes listed are this login's own.

const ACTIVE_REG = ["REGISTERED", "PENDING_REVIEW", "PENDING_PAYMENT", "SCHEDULED", "AWAITING_CASH", "AWAITING_CHECK", "PAYMENT_FAILED", "PAID"];

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const clubId = session.user.clubId;
  const now = new Date();
  const requestedMemberId = new URL(req.url).searchParams.get("memberId");

  const [row, ctx, club] = await Promise.all([
    prisma.event.findFirst({ where: { id, ...memberVisibleEventWhere(clubId, now, { upcomingOnly: false }) }, include: MEMBER_EVENT_INCLUDE }),
    loadMemberEventContext(session, requestedMemberId),
    prisma.club.findUnique({ where: { id: clubId }, select: { name: true, timezone: true, passProcessingFees: true, passPlatformFee: true, tier: true, stripeAccountId: true, stripeChargesEnabled: true } }),
  ]);
  if (ctx.forbidden) return NextResponse.json({ error: "You can't view events for that athlete." }, { status: 403 });
  // Same audience rule as the list: shapeForMember drops it when no athlete fits.
  const [event] = row ? await shapeForMember(clubId, [row], ctx) : [];
  if (!event || !club) return NextResponse.json({ error: "This event isn't available to your account." }, { status: 404 });

  const familyIds = ctx.accessible.map((a: { id: string }) => a.id);
  const [location, staff, docs, missingForContext, familyBookings, familyRegs] = await Promise.all([
    event.locationId
      ? prisma.location.findFirst({ where: { id: event.locationId, clubId }, select: { name: true, address: true, latitude: true, longitude: true } })
      : Promise.resolve(null),
    prisma.eventStaffAssignment.findMany({
      where: { eventId: event.id, clubId, user: { deletedAt: null } },
      select: { role: true, user: { select: { firstName: true, lastName: true } } },
    }),
    documentsForEvent(clubId, event.id),
    ctx.member ? missingSignedEventDocs(clubId, event.id, ctx.member.id) : Promise.resolve([]),
    familyIds.length
      ? prisma.booking.findMany({ where: { eventId: event.id, memberId: { in: familyIds }, status: { in: ["CONFIRMED", "WAITLISTED"] } }, select: { memberId: true, status: true } })
      : Promise.resolve([]),
    familyIds.length
      ? prisma.eventRegistration.findMany({ where: { eventId: event.id, memberId: { in: familyIds }, status: { in: ACTIVE_REG } }, select: { memberId: true, status: true } })
      : Promise.resolve([]),
  ]);

  // ── This athlete's price and how they'd pay ──────────────────────────────
  const policy = resolveEventPolicy(row as NonNullable<typeof row>);
  const num = (v: unknown) => (v == null ? null : Number(v));
  const memberPrice = num(event.memberPrice);
  const nonMemberPrice = num(event.nonMemberPrice);
  const dropInFee = num(event.dropInFee);
  const accepted = ((event.pricingOptions as unknown as Array<{ type?: string; membershipId?: string }> | null) ?? [])
    .filter((o) => o?.type === "membership" && o.membershipId)
    .map((o) => o.membershipId as string);
  const covered = accepted.length > 0 && ctx.subscriptions.some((s) => accepted.includes(s.membershipId));
  const varTotal = num(event.variableCostTotal) ?? num(event.variableCostEstimatedTotal) ?? 0;
  const split = !!event.variableCostEnabled && varTotal > 0;
  const hasPrice = memberPrice != null || nonMemberPrice != null || dropInFee != null;
  const pricing: PricingKind = covered ? "COVERED" : split ? "SPLIT" : hasPrice ? "PAID" : "FREE";
  const yours = ctx.isActiveMember ? memberPrice ?? nonMemberPrice ?? dropInFee : nonMemberPrice ?? memberPrice ?? dropInFee;
  const fee = yours != null ? applyProcessingFee(Math.round(yours * 100), feePolicyFor(club)) : null;
  const allowed = eventAllowedPaymentMethods(event);
  const intent = policy.approvalPaymentIntent;
  const methods: PaymentMethodKey[] = policy.requiresCoachApproval && intent && intent !== "PARENT_CHOOSES"
    ? (intent === "CASH_CHECK" ? ["CASH", "CHECK"] : [intent as PaymentMethodKey])
    : (allowed as PaymentMethodKey[]);
  const perHead =
    split && event.variableCostMode === "ESTIMATED" && event.variableCostEstimatedSignups
      ? +(varTotal / event.variableCostEstimatedSignups).toFixed(2)
      : null;

  // ── Their own athletes, and where each one stands ────────────────────────
  const family = ctx.accessible.map((a: { id: string; firstName: string; lastName: string | null }) => {
    const b = familyBookings.find((x) => x.memberId === a.id);
    const r = familyRegs.find((x) => x.memberId === a.id);
    return { memberId: a.id, firstName: a.firstName, lastName: a.lastName ?? "", status: b?.status ?? r?.status ?? null };
  });

  const missingIds = new Set(missingForContext.map((d) => d.id));
  const taken = event._count.bookings;
  const deadline = event.registrationDeadline;
  const started = event.startsAt.getTime() <= now.getTime();

  return NextResponse.json(
    {
      event,
      accessible: ctx.accessible,
      contextMemberId: ctx.member?.id ?? null,
      isActiveMember: ctx.isActiveMember,
      activeMembershipIds: ctx.subscriptions.map((s) => s.membershipId),
      family,
      details: {
        clubName: club.name,
        timezone: club.timezone,
        typeLabel: event.customEventType?.name ?? (event.type.charAt(0) + event.type.slice(1).toLowerCase()),
        location: location
          ? { name: location.name, address: location.address, mapUrl: mapsDirectionsUrl(location) }
          : null,
        staff: staff.map((s) => ({ name: `${s.user.firstName} ${s.user.lastName}`.trim(), role: s.role })),
        audience: event.audienceLabel,
        pricing,
        price: { member: memberPrice, nonMember: nonMemberPrice, dropIn: dropInFee, yours, cardFee: fee ? fee.feeCents / 100 : 0, cardTotal: fee ? fee.totalCents / 100 : null, passFees: !!club.passProcessingFees },
        methods,
        chargeOn: methods.includes("AUTO_CARD") ? eventScheduledChargeAt(event).toISOString() : null,
        split: split ? { mode: event.variableCostMode ?? "ESTIMATED", perHead } : null,
        approval: policy.requiresCoachApproval,
        onlinePaymentsReady: !!club.stripeAccountId && !!club.stripeChargesEnabled,
        capacity: event.capacity,
        taken,
        deadline: deadline ? deadline.toISOString() : null,
        registrationClosed: event.registrationOpen === false || (!!deadline && deadline.getTime() <= now.getTime()) || started,
        started,
        cancellationPolicy: event.cancellationPolicyText?.trim() || null,
        questions: eventFormFields(event.registrationForm).map((f) => ({ label: f.label, type: f.type, required: f.required, options: f.options, perEntry: f.perEntry })),
        documents: docs.map((d) => ({
          id: d.id,
          title: d.title,
          requirement: d.requirement,
          requirementLabel: EVENT_DOC_REQUIREMENT_LABELS[d.requirement],
          needsSignature: missingIds.has(d.id),
        })),
        sessions: event.sessions.map((s) => ({
          id: s.id,
          name: s.name,
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          price: num(s.price),
          pickable: !!event.sellIndividualSessions && num(s.price) != null && (num(s.price) as number) > 0 && s.startsAt.getTime() > now.getTime(),
        })),
        divisions: event.divisions?.trim() || null,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}
