import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe, calculatePlatformFee } from "@/lib/stripe";
import { processingFeeLineItem } from "@/lib/fees";
import { sendBookingConfirmationEmail } from "@/lib/email";
import { trialCoversClass } from "@/lib/freeTrial";
import { findOrAutoLinkMember } from "@/lib/memberLink";
import { getAppBaseUrl } from "@/lib/baseUrl";
import { applyParentalControls } from "@/lib/parentalControls";

// POST /api/member/classes/book
// Member-self booking for a class session. The price tier (member / non-member
// / drop-in) is auto-detected from the booker's subscription state — same
// resolution `/api/member/schedule` already returns to the UI. Members with
// an accepted active membership get the free path; everyone else goes through
// Stripe Checkout on the club's connected account.
const schema = z.object({
  classSessionId: z.string(),
  memberId: z.string().optional(),
});

type PricingOption =
  | { type: "member" | "nonmember" | "dropin"; price: number }
  | { type: "membership"; membershipId: string };

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "MEMBER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 20 booking attempts per minute per member. Stops accidental
  // double-tap, runaway loops, and Stripe-checkout-spam.
  const rl = rateLimit({ key: `book:class:${session.user.id}`, limit: 20, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many booking attempts. Try again in a moment.");

  try {
    const { classSessionId, memberId } = schema.parse(await req.json().catch(() => ({})));

    // Resolve the booking member (self or linked child)
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { email: true },
    });
    if (!user) return NextResponse.json({ error: "Account not found" }, { status: 404 });

    const self = await findOrAutoLinkMember(session.user.id, session.user.clubId, user.email);
    const guardianships = await prisma.memberGuardianUser.findMany({
      where: { userId: session.user.id, member: { clubId: session.user.clubId } },
      include: { member: true },
    });
    const accessible = [
      ...(self ? [self] : []),
      ...guardianships.map((g) => g.member),
    ];
    const member = memberId
      ? accessible.find((m) => m.id === memberId)
      : self ?? accessible[0];
    if (!member) {
      return NextResponse.json(
        { error: "Your account isn't linked to a member profile yet. Contact your club to get added." },
        { status: 400 },
      );
    }

    // Load class session + class
    const classSession = await prisma.classSession.findFirst({
      where: { id: classSessionId, clubId: session.user.clubId, canceled: false },
      include: {
        recurringClass: true,
      },
    });
    if (!classSession || !classSession.recurringClass || classSession.recurringClass.deletedAt) {
      return NextResponse.json({ error: "Class not available" }, { status: 404 });
    }
    const cls = classSession.recurringClass;
    if (cls.visibility === "PRIVATE") {
      return NextResponse.json({ error: "Class not available" }, { status: 403 });
    }
    if (classSession.startsAt < new Date()) {
      return NextResponse.json({ error: "Class has already started" }, { status: 400 });
    }

    // Already booked?
    const existing = await prisma.attendanceRecord.findFirst({
      where: { classSessionId, memberId: member.id },
    });
    if (existing) {
      return NextResponse.json({ error: "You're already booked for this class." }, { status: 409 });
    }

    const options = ((cls.pricingOptions as unknown as PricingOption[] | null) || []);
    const acceptedMembershipIds = options
      .filter((o): o is Extract<PricingOption, { type: "membership" }> => o?.type === "membership" && !!o.membershipId)
      .map((o) => o.membershipId);

    // Membership-covered path
    if (acceptedMembershipIds.length > 0) {
      const activeSub = await prisma.memberSubscription.findFirst({
        where: { memberId: member.id, membershipId: { in: acceptedMembershipIds }, status: "active" },
      });
      if (activeSub) {
        const record = await prisma.attendanceRecord.create({
          data: {
            clubId: session.user.clubId,
            classSessionId,
            memberId: member.id,
            status: "PRESENT",
            checkedInAt: new Date(),
            addedById: session.user.id,
          },
        });
        const club = await prisma.club.findUnique({
          where: { id: session.user.clubId },
          select: { name: true },
        });
        const to = member.isMinor
          ? (member.guardianEmail || member.email)
          : (member.email || member.guardianEmail);
        if (to) {
          const baseUrl = getAppBaseUrl();
          sendBookingConfirmationEmail({
            to,
            firstName: member.firstName,
            clubName: club?.name ?? "your club",
            eventName: cls.name,
            startsAt: classSession.startsAt,
            endsAt: classSession.endsAt,
            coveredByMembership: true,
            portalUrl: `${baseUrl}/member/bookings`,
          }).catch((e) => console.error("Class booking email failed:", e));
        }
        return NextResponse.json({ coveredByMembership: true, attendanceRecordId: record.id });
      }
    }

    // Auto-detect priced tier.
    //
    // Eligibility rule (P4 correction): when a class declares accepted
    // memberships (acceptedMembershipIds.length > 0), the member tier is
    // ONLY available to members who actually hold one of those plans.
    // Without a matching sub the booker is treated as a NON-MEMBER for
    // this class — even if they have OTHER active subs at the club. This
    // closes the "child with membership A books a class that only
    // accepts membership B" hole the smoke test caught.
    const memberSubs = await prisma.memberSubscription.findMany({
      where: { memberId: member.id, status: "active" },
      select: { id: true },
    });
    const hasAnySub = memberSubs.length > 0;

    // Staff-granted free-trial window (Member.trialEndsAt): while active and
    // the member has no plan, classes the club's Free Trial offer covers book
    // free as TRIAL — like a membership scoped to the offer's attached plans
    // (all classes when the offer isn't scoped). They can still subscribe to
    // any plan later.
    const trialWindowRunning = !hasAnySub && member.trialEndsAt && member.trialEndsAt > new Date();
    const trialClubConfig = trialWindowRunning
      ? (
          await prisma.club.findUnique({
            where: { id: session.user.clubId },
            select: { freeTrialConfig: true },
          })
        )?.freeTrialConfig
      : null;
    if (trialWindowRunning && trialCoversClass(trialClubConfig, acceptedMembershipIds)) {
      const record = await prisma.attendanceRecord.create({
        data: {
          clubId: session.user.clubId,
          classSessionId,
          memberId: member.id,
          status: "TRIAL",
          addedById: session.user.id,
        },
      });
      const club = await prisma.club.findUnique({
        where: { id: session.user.clubId },
        select: { name: true },
      });
      const to = member.isMinor
        ? (member.guardianEmail || member.email)
        : (member.email || member.guardianEmail);
      if (to) {
        const baseUrl = getAppBaseUrl();
        sendBookingConfirmationEmail({
          to,
          firstName: member.firstName,
          clubName: club?.name ?? "your club",
          eventName: cls.name,
          startsAt: classSession.startsAt,
          endsAt: classSession.endsAt,
          coveredByMembership: true,
          portalUrl: `${baseUrl}/member/bookings`,
        }).catch((e) => console.error("Trial class booking email failed:", e));
      }
      return NextResponse.json({ coveredByTrial: true, attendanceRecordId: record.id });
    }
    const classRestrictsToAcceptedMemberships = acceptedMembershipIds.length > 0;
    // We already proved (in the free-coverage block above) that the
    // member has no matching sub at this point. So if the class is
    // restricted to accepted memberships, they cannot use the MEMBER
    // tier here regardless of their other subscriptions.
    const eligibleForMemberPrice = hasAnySub && !classRestrictsToAcceptedMemberships;

    type PricedOption = { type: "member" | "nonmember" | "dropin"; price: number };
    const memberPrice    = options.find((o): o is PricedOption => o?.type === "member");
    const nonMemberPrice = options.find((o): o is PricedOption => o?.type === "nonmember");
    const dropInPrice    = options.find((o): o is PricedOption => o?.type === "dropin");
    let priced: { price: number; label: string; pricingType: "MEMBER" | "NON_MEMBER" | "DROP_IN" } | null = null;
    if (eligibleForMemberPrice && memberPrice) {
      priced = { price: memberPrice.price, label: "Member", pricingType: "MEMBER" };
    } else if (nonMemberPrice) {
      priced = { price: nonMemberPrice.price, label: "Non-member", pricingType: "NON_MEMBER" };
    } else if (dropInPrice) {
      priced = { price: dropInPrice.price, label: "Drop-in", pricingType: "DROP_IN" };
    } else if (!classRestrictsToAcceptedMemberships && memberPrice) {
      // Unrestricted class with only a member price (legacy default for
      // single-tier clubs) — still allow at member rate.
      priced = { price: memberPrice.price, label: "Member", pricingType: "MEMBER" };
    }

    if (!priced || !priced.price) {
      // Restricted class + non-matching sub + no non-member/drop-in
      // fallback price → the member's tier doesn't cover this class.
      // Surface that clearly instead of the generic "not available".
      if (classRestrictsToAcceptedMemberships) {
        return NextResponse.json(
          {
            error:
              "Your current membership doesn't include this class. Contact your club to upgrade.",
            code: "MEMBERSHIP_NOT_INCLUDED",
          },
          { status: 403 },
        );
      }
      return NextResponse.json(
        { error: "This class isn't available for self-booking. Contact your club." },
        { status: 400 },
      );
    }

    // P4 parental gate. Runs after price resolution + before Stripe.
    // Allows by default; queues a guardian-approval row for controlled
    // minors. Replay payload is the same { classSessionId, memberId }
    // POST body that started this flow.
    const gate = await applyParentalControls({
      member: {
        id: member.id,
        clubId: session.user.clubId,
        userId: member.userId,
        isMinor: member.isMinor,
        parentControls: member.parentControls,
      },
      bookerUserId: session.user.id,
      // A guardian booking for a child (member isn't the booker's own login).
      bookerIsGuardian: member.userId !== session.user.id,
      kind: "CLASS_BOOK",
      amount: priced.price,
      payload: { classSessionId, memberId: member.id, pricingType: priced.pricingType },
    });
    if (gate.kind === "block") {
      return NextResponse.json(gate.body, { status: gate.status });
    }
    if (gate.kind === "queue") {
      return NextResponse.json(gate.response, { status: 202 });
    }

    const club = await prisma.club.findUnique({ where: { id: session.user.clubId } });
    if (!club || !club.stripeAccountId || !club.stripeChargesEnabled) {
      return NextResponse.json({ error: "Your club hasn't finished setting up online payments yet." }, { status: 400 });
    }

    const priceCents = Math.round(priced.price * 100);
    const platformFee = calculatePlatformFee(priceCents, club.tier);
    const baseUrl = getAppBaseUrl();
    const feeItem = processingFeeLineItem(priceCents, club.passProcessingFees);

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
                name: cls.name,
                description: `${priced.label} price · ${new Date(classSession.startsAt).toLocaleString()}`,
              },
            },
          },
          ...(feeItem ? [feeItem] : []),
        ],
        success_url: `${baseUrl}/member/bookings?paid=true`,
        cancel_url: `${baseUrl}/member/schedule?canceled=true`,
        payment_intent_data: {
          application_fee_amount: platformFee,
          metadata: {
            memberId: member.id,
            classId: cls.id,
            classSessionId,
            className: cls.name,
            clubId: club.id,
            pricingType: priced.pricingType,
          },
        },
        metadata: {
          memberId: member.id,
          classId: cls.id,
          classSessionId,
          className: cls.name,
          clubId: club.id,
          pricingType: priced.pricingType,
        },
      },
      { stripeAccount: club.stripeAccountId },
    );

    return NextResponse.json({ url: checkoutSession.url });
  } catch (err) {
    console.error("Member class book error:", err);
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors }, { status: 400 });
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
