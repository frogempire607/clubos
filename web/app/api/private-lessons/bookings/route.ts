import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const statusFilter = searchParams.get("status");

  const isOwner = session.user.role === "OWNER";
  const isStaff = session.user.role === "STAFF";

  const where: Record<string, unknown> = { clubId: session.user.clubId };
  if (statusFilter) where.status = statusFilter;
  // Staff only see their own assigned bookings
  if (isStaff && !isOwner) where.coachId = session.user.id;

  const bookings = await prisma.privateBooking.findMany({
    where,
    include: {
      member:     { select: { id: true, firstName: true, lastName: true, email: true } },
      lessonType: { select: { id: true, title: true, durationMin: true, basePrice: true } },
      coach:      { select: { id: true, firstName: true, lastName: true } },
      creditLedger: { select: { creditsGranted: true, creditsUsed: true, expiresAt: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(bookings);
}

const slotSchema = z.object({
  date:      z.string(),  // ISO date "2025-07-15"
  startTime: z.string(),  // "14:00"
  endTime:   z.string(),  // "15:00"
});

const schema = z.object({
  memberId:        z.string(),
  lessonTypeId:    z.string(),
  priceOptionId:   z.string().optional().nullable(),
  coachId:         z.string().optional().nullable(),
  requestedSlots:  z.array(slotSchema).min(1).max(3),
  creditLedgerId:  z.string().optional().nullable(),
  paymentType:     z.enum(["CREDIT", "STRIPE", "MANUAL", "UNPAID"]).default("CREDIT"),
  notes:           z.string().optional().nullable(),
  allowUnpaid:     z.boolean().default(false),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const data = schema.parse(await req.json());

    // Verify member and lesson type belong to this club
    const [member, lessonType] = await Promise.all([
      prisma.member.findFirst({ where: { id: data.memberId, clubId: session.user.clubId, deletedAt: null } }),
      prisma.privateLessonType.findFirst({ where: { id: data.lessonTypeId, clubId: session.user.clubId, deletedAt: null, active: true } }),
    ]);

    if (!member)     return NextResponse.json({ error: "Member not found" }, { status: 404 });
    if (!lessonType) return NextResponse.json({ error: "Lesson type not found or inactive" }, { status: 404 });

    let creditLedgerId = data.creditLedgerId || null;

    // Validate lesson package balance if using a package.
    if (data.paymentType === "CREDIT" && data.creditLedgerId) {
      const ledger = await prisma.privateCreditLedger.findFirst({
        where: { id: data.creditLedgerId, memberId: data.memberId, clubId: session.user.clubId, status: "active" },
      });
      if (!ledger) return NextResponse.json({ error: "No valid credits found" }, { status: 400 });
      if (ledger.creditsGranted - ledger.creditsUsed < 1) {
        return NextResponse.json({ error: "No remaining lessons on this package" }, { status: 400 });
      }
    }

    if (data.paymentType === "CREDIT" && !creditLedgerId) {
      const ledgers = await prisma.privateCreditLedger.findMany({
        where: {
          memberId: data.memberId,
          clubId: session.user.clubId,
          status: "active",
          OR: [{ lessonTypeId: null }, { lessonTypeId: data.lessonTypeId }],
        },
        orderBy: { createdAt: "asc" },
      });
      const ledger = ledgers.find((l) => l.creditsGranted - l.creditsUsed > 0);
      if (!ledger) {
        return NextResponse.json({ error: "No remaining private lesson package balance was found for this member." }, { status: 400 });
      }
      creditLedgerId = ledger.id;
    }

    // Resolve the chosen purchase option (if any). Each lesson type can
    // have several priced options, each limited to a set of coaches.
    type Opt = { id: string; label: string; price: number; coachIds: string[] };
    const options = Array.isArray(lessonType.priceOptions)
      ? (lessonType.priceOptions as unknown as Opt[])
      : [];
    const chosenOption = data.priceOptionId
      ? options.find((o) => o.id === data.priceOptionId) || null
      : null;
    if (data.priceOptionId && !chosenOption) {
      return NextResponse.json({ error: "That pricing option is no longer available." }, { status: 400 });
    }
    if (
      chosenOption &&
      chosenOption.coachIds.length > 0 &&
      data.coachId &&
      !chosenOption.coachIds.includes(data.coachId)
    ) {
      return NextResponse.json(
        { error: "That coach isn't available for the selected pricing option." },
        { status: 400 },
      );
    }
    const optionPrice = chosenOption ? Number(chosenOption.price) : Number(lessonType.basePrice);

    const booking = await prisma.privateBooking.create({
      data: {
        clubId:         session.user.clubId,
        memberId:       data.memberId,
        lessonTypeId:   data.lessonTypeId,
        coachId:        data.coachId || null,
        requestedSlots: data.requestedSlots,
        creditLedgerId,
        paymentType:    data.paymentType,
        pricePaid:      data.paymentType === "CREDIT" ? 0 : optionPrice,
        allowUnpaid:    data.allowUnpaid,
        notes:          data.notes || null,
        status:         data.coachId ? "PENDING_COACH" : "REQUESTED",
      },
      include: {
        member:     { select: { firstName: true, lastName: true } },
        lessonType: { select: { title: true } },
        coach:      { select: { id: true, firstName: true, lastName: true } },
      },
    });

    // Notify the coach via DM if assigned
    if (booking.coachId) {
      const slotDesc = data.requestedSlots
        .map((s) => `${s.date} ${s.startTime}–${s.endTime}`)
        .join(", ");
      await prisma.message.create({
        data: {
          clubId:      session.user.clubId,
          senderId:    session.user.id,
          recipientId: booking.coachId,
          body: `New private lesson request from ${booking.member.firstName} ${booking.member.lastName} for "${booking.lessonType.title}". Preferred times: ${slotDesc}. Please accept or propose a new time in the Privates section of your dashboard.`,
        },
      });
    }

    return NextResponse.json(booking, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
