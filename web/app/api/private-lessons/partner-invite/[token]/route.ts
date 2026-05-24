import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

// Public — no session required. The token is the only credential.

export async function GET(_req: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  if (!token) return NextResponse.json({ error: "Invalid link" }, { status: 404 });

  const partner = await prisma.privateBookingPartner.findUnique({
    where: { inviteToken: token },
    include: {
      booking: {
        select: {
          status: true,
          requestedSlots: true,
          confirmedStartAt: true,
          confirmedEndAt: true,
          member: { select: { firstName: true, lastName: true } },
          lessonType: { select: { title: true, durationMin: true } },
          coach: { select: { firstName: true, lastName: true } },
        },
      },
      club: { select: { name: true } },
    },
  });
  if (!partner || partner.kind !== "OUTSIDE") {
    return NextResponse.json({ error: "Invalid link" }, { status: 404 });
  }
  if (partner.inviteTokenExpiresAt && partner.inviteTokenExpiresAt < new Date()) {
    return NextResponse.json({ error: "This link has expired" }, { status: 410 });
  }

  return NextResponse.json({
    partnerId: partner.id,
    status: partner.status,
    clubName: partner.club.name,
    booking: {
      status: partner.booking.status,
      requestedSlots: partner.booking.requestedSlots,
      confirmedStartAt: partner.booking.confirmedStartAt,
      confirmedEndAt: partner.booking.confirmedEndAt,
      bookerName: `${partner.booking.member.firstName} ${partner.booking.member.lastName}`,
      lessonTitle: partner.booking.lessonType.title,
      durationMin: partner.booking.lessonType.durationMin,
      coach: partner.booking.coach
        ? `${partner.booking.coach.firstName} ${partner.booking.coach.lastName}`
        : null,
    },
    prefill: {
      name: partner.outsideName,
      email: partner.outsideEmail,
      phone: partner.outsidePhone,
    },
  });
}

const postSchema = z.object({
  action: z.enum(["confirm", "decline"]),
  name: z.string().min(1).max(120).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(40).optional(),
  // Free-form extras (e.g. dob, club, notes) — stored as JSON.
  extras: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(req: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  if (!token) return NextResponse.json({ error: "Invalid link" }, { status: 404 });

  const partner = await prisma.privateBookingPartner.findUnique({
    where: { inviteToken: token },
  });
  if (!partner || partner.kind !== "OUTSIDE") {
    return NextResponse.json({ error: "Invalid link" }, { status: 404 });
  }
  if (partner.inviteTokenExpiresAt && partner.inviteTokenExpiresAt < new Date()) {
    return NextResponse.json({ error: "This link has expired" }, { status: 410 });
  }
  if (partner.status === "CONFIRMED" || partner.status === "DECLINED") {
    return NextResponse.json({ error: "This invite has already been responded to." }, { status: 409 });
  }

  let data: z.infer<typeof postSchema>;
  try {
    data = postSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  if (data.action === "decline") {
    await prisma.privateBookingPartner.update({
      where: { id: partner.id },
      data: { status: "DECLINED", respondedAt: new Date() },
    });
    return NextResponse.json({ ok: true, status: "DECLINED" });
  }

  if (!data.name) {
    return NextResponse.json({ error: "Name is required to confirm." }, { status: 400 });
  }

  await prisma.privateBookingPartner.update({
    where: { id: partner.id },
    data: {
      status: "CONFIRMED",
      respondedAt: new Date(),
      confirmedAt: new Date(),
      outsideName: data.name,
      outsideEmail: data.email || partner.outsideEmail,
      outsidePhone: data.phone || partner.outsidePhone,
      ...(data.extras ? { outsideInfo: data.extras as object } : {}),
    },
  });

  return NextResponse.json({ ok: true, status: "CONFIRMED" });
}
