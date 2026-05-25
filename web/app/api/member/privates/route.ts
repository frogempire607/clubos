import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { findOrAutoLinkMember } from "@/lib/memberLink";
import { packageAllowsLessonType } from "@/lib/privateLessonRules";

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

  const [types, staff, bookings, credits] = await Promise.all([
    prisma.privateLessonType.findMany({
      where: { clubId, deletedAt: null, active: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        title: true,
        description: true,
        durationMin: true,
        maxAthletes: true,
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
            partners: {
              select: {
                id: true,
                kind: true,
                status: true,
                inviteToken: true,
                outsideName: true,
                member: { select: { firstName: true, lastName: true } },
              },
            },
          },
        })
      : Promise.resolve([]),
    member
      ? prisma.privateCreditLedger.findMany({
          where: { clubId, memberId: member.id, status: "active" },
          include: { package: { select: { title: true, lessonTypeId: true, lessonTypeIds: true } } },
          orderBy: { createdAt: "asc" },
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
    credits: credits
      .filter((c) => c.creditsGranted - c.creditsUsed > 0)
      .map((c) => ({
        id: c.id,
        packageTitle: c.package?.title ?? null,
        lessonTypeId: c.lessonTypeId,
        packageLessonTypeIds: c.package ? c.package.lessonTypeIds : [],
        remaining: c.creditsGranted - c.creditsUsed,
        expiresAt: c.expiresAt,
      })),
  });
}

const slotSchema = z.object({
  date: z.string().min(1),
  startTime: z.string().min(1),
  endTime: z.string().optional(),
});

const partnerSchema = z.object({
  kind: z.enum(["MEMBER", "OUTSIDE", "NEEDS_HELP"]),
  memberId: z.string().optional().nullable(),
});

const schema = z.object({
  lessonTypeId: z.string(),
  priceOptionId: z.string().optional().nullable(),
  coachId: z.string().optional().nullable(),
  requestedSlots: z.array(slotSchema).min(1).max(16),
  notes: z.string().max(500).optional().nullable(),
  partners: z.array(partnerSchema).max(10).optional().default([]),
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

  const usableCredit = await prisma.privateCreditLedger.findMany({
    where: { clubId, memberId: member.id, status: "active" },
    include: { package: { select: { lessonTypeId: true, lessonTypeIds: true } } },
    orderBy: { createdAt: "asc" },
  });
  const creditLedger = usableCredit.find((c) => {
    if (c.creditsGranted - c.creditsUsed <= 0) return false;
    if (c.package) return packageAllowsLessonType(c.package.lessonTypeIds, c.package.lessonTypeId, lessonType.id);
    return !c.lessonTypeId || c.lessonTypeId === lessonType.id;
  }) ?? null;
  const remainingCredits = creditLedger
    ? creditLedger.creditsGranted - creditLedger.creditsUsed
    : 0;
  if (!creditLedger && data.requestedSlots.length > 3) {
    return NextResponse.json({ error: "Request up to 3 preferred times without a package." }, { status: 400 });
  }
  if (creditLedger && data.requestedSlots.length > remainingCredits) {
    return NextResponse.json(
      { error: `This package has ${remainingCredits} lesson${remainingCredits === 1 ? "" : "s"} remaining.` },
      { status: 400 },
    );
  }

  function addMinutes(date: string, time: string, minutes: number): string {
    const [hour, minute] = time.split(":").map(Number);
    const d = new Date(`${date}T00:00:00`);
    d.setHours(hour || 0, minute || 0, 0, 0);
    d.setMinutes(d.getMinutes() + minutes);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  const normalizedSlots = data.requestedSlots.map((slot) => ({
    date: slot.date,
    startTime: slot.startTime,
    endTime: addMinutes(slot.date, slot.startTime, lessonType.durationMin),
  }));

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

  // Partner validation — only for multi-athlete lesson types.
  const partners = data.partners ?? [];
  const maxAthletes = lessonType.maxAthletes ?? 1;
  if (partners.length > 0 && maxAthletes <= 1) {
    return NextResponse.json(
      { error: "This lesson type is 1-on-1 and doesn't support partners." },
      { status: 400 },
    );
  }
  if (partners.length > maxAthletes - 1) {
    return NextResponse.json(
      { error: `This lesson type allows at most ${maxAthletes - 1} partner(s).` },
      { status: 400 },
    );
  }
  for (const p of partners) {
    if (p.kind === "MEMBER") {
      if (!p.memberId) {
        return NextResponse.json({ error: "Pick a member for each member-partner slot." }, { status: 400 });
      }
      if (p.memberId === member.id) {
        return NextResponse.json({ error: "You can't add yourself as a partner." }, { status: 400 });
      }
      const partnerMember = await prisma.member.findFirst({
        where: { id: p.memberId, clubId, deletedAt: null },
        select: { id: true },
      });
      if (!partnerMember) {
        return NextResponse.json({ error: "Partner member not found." }, { status: 400 });
      }
    }
  }

  const slotsForBookings = creditLedger ? normalizedSlots : [normalizedSlots[0]];
  const bookings = await Promise.all(slotsForBookings.map((slot) =>
    prisma.privateBooking.create({
      data: {
        clubId,
        memberId: member.id,
        lessonTypeId: lessonType.id,
        coachId: data.coachId || null,
        requestedSlots: creditLedger ? [slot] : normalizedSlots,
        creditLedgerId: creditLedger?.id ?? null,
        paymentType: creditLedger ? "CREDIT" : "UNPAID",
        pricePaid: creditLedger ? 0 : price,
        allowUnpaid: true,
        notes: data.notes || null,
        status: data.coachId ? "PENDING_COACH" : "REQUESTED",
        partners: partners.length
          ? {
              create: partners.map((p) => ({
                clubId,
                kind: p.kind,
                memberId: p.kind === "MEMBER" ? p.memberId || null : null,
              })),
            }
          : undefined,
      },
    }),
  ));

  // Notify the assigned coach (if any) so they can approve/decline.
  if (data.coachId) {
    try {
      await prisma.message.create({
        data: {
          clubId,
          senderId: session.user.id,
          recipientId: data.coachId,
          body: `New private lesson request: ${lessonType.title} from ${member.firstName} ${member.lastName}.`,
        },
      });
    } catch {
      /* messaging is best-effort */
    }
  }

  return NextResponse.json({ ok: true, bookingIds: bookings.map((b) => b.id) }, { status: 201 });
}
