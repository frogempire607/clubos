import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { findOrAutoLinkMember } from "@/lib/memberLink";

type Opt = { id: string; label: string; price: number; coachIds: string[] };

// GET /api/member/privates — lesson types (+ price options), the coaches who
// teach them, and this member's existing private bookings.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const clubId = session.user.clubId;
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { email: true },
  });
  const member = user
    ? await findOrAutoLinkMember(session.user.id, clubId, user.email)
    : null;

  const [types, staff, bookings] = await Promise.all([
    prisma.privateLessonType.findMany({
      where: { clubId, deletedAt: null, active: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        title: true,
        description: true,
        durationMin: true,
        basePrice: true,
        priceOptions: true,
        eligibleCoachIds: true,
      },
    }),
    prisma.user.findMany({
      where: { clubId, deletedAt: null, role: { in: ["OWNER", "STAFF"] } },
      select: { id: true, firstName: true, lastName: true },
    }),
    member
      ? prisma.privateBooking.findMany({
          where: { memberId: member.id, clubId },
          orderBy: { createdAt: "desc" },
          take: 20,
          select: {
            id: true,
            status: true,
            createdAt: true,
            confirmedStartAt: true,
            requestedSlots: true,
            lessonType: { select: { title: true } },
            coach: { select: { firstName: true, lastName: true } },
          },
        })
      : Promise.resolve([]),
  ]);

  return NextResponse.json({
    hasMemberProfile: !!member,
    types: types.map((t) => ({
      ...t,
      basePrice: Number(t.basePrice),
      priceOptions: Array.isArray(t.priceOptions) ? (t.priceOptions as unknown as Opt[]) : [],
      eligibleCoachIds: Array.isArray(t.eligibleCoachIds)
        ? (t.eligibleCoachIds as unknown as string[])
        : [],
    })),
    coaches: staff,
    bookings,
  });
}

const slotSchema = z.object({
  date: z.string().min(1),
  startTime: z.string().min(1),
  endTime: z.string().min(1),
});

const schema = z.object({
  lessonTypeId: z.string(),
  priceOptionId: z.string().optional().nullable(),
  coachId: z.string().optional().nullable(),
  requestedSlots: z.array(slotSchema).min(1).max(3),
  notes: z.string().max(500).optional().nullable(),
});

// POST /api/member/privates — member requests a private for THEMSELVES.
// No charge here: the booking is created UNPAID and the coach/owner reviews
// and approves or declines from the dashboard.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    }
    throw err;
  }

  const clubId = session.user.clubId;
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { email: true },
  });
  const member = user
    ? await findOrAutoLinkMember(session.user.id, clubId, user.email)
    : null;
  if (!member) {
    return NextResponse.json(
      { error: "Your account isn't linked to a member profile yet. Contact your club." },
      { status: 400 },
    );
  }

  const lessonType = await prisma.privateLessonType.findFirst({
    where: { id: data.lessonTypeId, clubId, deletedAt: null, active: true },
  });
  if (!lessonType) {
    return NextResponse.json({ error: "Lesson type not available" }, { status: 404 });
  }

  const options = Array.isArray(lessonType.priceOptions)
    ? (lessonType.priceOptions as unknown as Opt[])
    : [];
  const chosen = data.priceOptionId
    ? options.find((o) => o.id === data.priceOptionId) || null
    : null;
  if (data.priceOptionId && !chosen) {
    return NextResponse.json({ error: "That pricing option is no longer available." }, { status: 400 });
  }
  if (
    chosen &&
    chosen.coachIds.length > 0 &&
    data.coachId &&
    !chosen.coachIds.includes(data.coachId)
  ) {
    return NextResponse.json(
      { error: "That coach isn't available for the selected option." },
      { status: 400 },
    );
  }
  const price = chosen ? Number(chosen.price) : Number(lessonType.basePrice);

  const booking = await prisma.privateBooking.create({
    data: {
      clubId,
      memberId: member.id,
      lessonTypeId: lessonType.id,
      coachId: data.coachId || null,
      requestedSlots: data.requestedSlots,
      paymentType: "UNPAID",
      pricePaid: price,
      allowUnpaid: true,
      notes: data.notes || null,
      status: data.coachId ? "PENDING_COACH" : "REQUESTED",
    },
  });

  // Notify the assigned coach (if any) so they can approve/decline.
  if (booking.coachId) {
    try {
      await prisma.message.create({
        data: {
          clubId,
          senderId: session.user.id,
          recipientId: booking.coachId,
          body: `New private lesson request: ${lessonType.title} from ${member.firstName} ${member.lastName}.`,
        },
      });
    } catch {
      /* messaging is best-effort */
    }
  }

  return NextResponse.json({ ok: true, bookingId: booking.id }, { status: 201 });
}
