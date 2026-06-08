import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const bookSchema = z.object({
  memberId: z.string(),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Owner-side booking creation. Members must use /api/member/events/[id]/register
  // (which enforces parent controls + tier gates). Without this gate a MEMBER
  // could book any other member into any event in the club.
  if (session.user.role !== "OWNER" && session.user.role !== "STAFF") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const { memberId } = bookSchema.parse(body);

    // Verify event belongs to this club
    const event = await prisma.event.findFirst({
      where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
      include: { _count: { select: { bookings: true } } },
    });
    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });

    // Verify member belongs to this club
    const member = await prisma.member.findFirst({
      where: { id: memberId, clubId: session.user.clubId, deletedAt: null },
    });
    if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

    // Check if already booked
    const existing = await prisma.booking.findUnique({
      where: { eventId_memberId: { eventId: params.id, memberId } },
    });
    if (existing) {
      return NextResponse.json({ error: "Already booked" }, { status: 409 });
    }

    // Determine status based on capacity
    const status =
      event.capacity && event._count.bookings >= event.capacity ? "WAITLISTED" : "CONFIRMED";

    const booking = await prisma.booking.create({
      data: { eventId: params.id, memberId, status },
    });

    return NextResponse.json(booking, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "OWNER" && session.user.role !== "STAFF") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const memberId = searchParams.get("memberId");
    if (!memberId) return NextResponse.json({ error: "memberId required" }, { status: 400 });

    // Verify event belongs to this club
    const event = await prisma.event.findFirst({
      where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
    });
    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });

    await prisma.booking.delete({
      where: { eventId_memberId: { eventId: params.id, memberId } },
    });

    // Promote first waitlisted member to confirmed
    const firstWaitlisted = await prisma.booking.findFirst({
      where: { eventId: params.id, status: "WAITLISTED" },
      orderBy: { createdAt: "asc" },
    });
    if (firstWaitlisted) {
      await prisma.booking.update({
        where: { id: firstWaitlisted.id },
        data: { status: "CONFIRMED" },
      });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
