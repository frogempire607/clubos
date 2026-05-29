import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe, calculatePlatformFee } from "@/lib/stripe";
import { processingFeeLineItem } from "@/lib/fees";
import { sendBookingConfirmationEmail } from "@/lib/email";
import { getAppBaseUrl } from "@/lib/baseUrl";

const schema = z.object({
  memberId: z.string(),
  classSessionId: z.string(),
  pricingType: z.enum(["MEMBER", "NON_MEMBER", "DROP_IN", "MEMBERSHIP"]).default("MEMBER"),
});

type PricingOption =
  | { type: "member" | "nonmember" | "dropin"; price: number }
  | { type: "membership"; membershipId: string };

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["OWNER", "STAFF"].includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const { memberId, classSessionId, pricingType } = schema.parse(body);

    const cls = await prisma.recurringClass.findFirst({
      where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
    });
    if (!cls) return NextResponse.json({ error: "Class not found" }, { status: 404 });

    const classSession = await prisma.classSession.findFirst({
      where: { id: classSessionId, clubId: session.user.clubId, classId: cls.id },
    });
    if (!classSession) return NextResponse.json({ error: "Session not found" }, { status: 404 });

    const member = await prisma.member.findFirst({
      where: { id: memberId, clubId: session.user.clubId, deletedAt: null },
    });
    if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

    const options = ((cls.pricingOptions as unknown as PricingOption[] | null) || []);
    const acceptedMembershipIds = options
      .filter((o): o is Extract<PricingOption, { type: "membership" }> => o?.type === "membership")
      .map((o) => o.membershipId);

    // Membership-covered: register at no cost when the member has an active sub on an accepted plan
    if (acceptedMembershipIds.length > 0) {
      const activeSub = await prisma.memberSubscription.findFirst({
        where: {
          memberId,
          membershipId: { in: acceptedMembershipIds },
          status: "active",
        },
      });
      if (activeSub) {
        const existing = await prisma.attendanceRecord.findFirst({
          where: { classSessionId, memberId },
        });
        const record = existing
          ? await prisma.attendanceRecord.update({
              where: { id: existing.id },
              data: {
                status: "PRESENT",
                checkedInAt: existing.checkedInAt ?? new Date(),
                addedById: session.user.id,
              },
            })
          : await prisma.attendanceRecord.create({
              data: {
                clubId: session.user.clubId,
                classSessionId,
                memberId,
                status: "PRESENT",
                checkedInAt: new Date(),
                addedById: session.user.id,
              },
            });
        // Email: membership-covered registration confirmation
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
      if (pricingType === "MEMBERSHIP") {
        return NextResponse.json(
          { error: "Member does not have an active accepted membership" },
          { status: 400 }
        );
      }
    } else if (pricingType === "MEMBERSHIP") {
      return NextResponse.json(
        { error: "This class does not accept membership registration" },
        { status: 400 }
      );
    }

    // Paid path — Stripe checkout based on configured price
    const priceMap: Record<"MEMBER" | "NON_MEMBER" | "DROP_IN", { type: PricingOption["type"]; label: string }> = {
      MEMBER:     { type: "member",    label: "Member" },
      NON_MEMBER: { type: "nonmember", label: "Non-member" },
      DROP_IN:    { type: "dropin",    label: "Drop-in" },
    };
    const choice = priceMap[pricingType as keyof typeof priceMap];
    const priced = options.find(
      (o): o is Extract<PricingOption, { type: "member" | "nonmember" | "dropin" }> =>
        o?.type === choice.type
    );
    if (!priced || !priced.price) {
      return NextResponse.json({ error: `No ${choice.label.toLowerCase()} price configured` }, { status: 400 });
    }

    const club = await prisma.club.findUnique({ where: { id: session.user.clubId } });
    if (!club || !club.stripeAccountId || !club.stripeChargesEnabled) {
      return NextResponse.json({ error: "Connect Stripe first" }, { status: 400 });
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
                description: `${choice.label} price · ${new Date(classSession.startsAt).toLocaleString()}`,
              },
            },
          },
          ...(feeItem ? [feeItem] : []),
        ],
        success_url: `${baseUrl}/dashboard/attendance?session=${classSessionId}&paid=true`,
        cancel_url: `${baseUrl}/dashboard/attendance?session=${classSessionId}&canceled=true`,
        payment_intent_data: {
          application_fee_amount: platformFee,
          metadata: {
            memberId,
            classId: cls.id,
            classSessionId,
            className: cls.name,
            clubId: club.id,
            pricingType,
          },
        },
        metadata: {
          memberId,
          classId: cls.id,
          classSessionId,
          className: cls.name,
          clubId: club.id,
          pricingType,
        },
      },
      { stripeAccount: club.stripeAccountId }
    );

    return NextResponse.json({ url: checkoutSession.url });
  } catch (err) {
    console.error("Class charge error:", err);
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
