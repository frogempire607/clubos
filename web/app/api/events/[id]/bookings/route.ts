import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";

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
  const denied = requirePermission(session, "events", "edit");
  if (denied) return denied;

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
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "events", "edit");
  if (denied) return denied;

  try {
    const { searchParams } = new URL(req.url);
    const memberId = searchParams.get("memberId");
    if (!memberId) return NextResponse.json({ error: "memberId required" }, { status: 400 });

    // Verify event belongs to this club
    const event = await prisma.event.findFirst({
      where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
    });
    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });

    // ── Roster and billing leave TOGETHER, or not at all ─────────────────────
    // A booking is the roster; the registration is the bill. This route used
    // to delete the booking and hand back a `registrationKept` warning when the
    // person was still on the billing list — the "removed but still invoiced"
    // state the Attendees redesign (B11 slice 3) exists to make impossible.
    //
    // It must not cascade either: an earlier cascade cancelled the billing rows
    // of two athletes who had actually paid (Frog Empire Road Trip,
    // 2026-08-03). So when a live registration exists, this route refuses and
    // points at the ONE remove that does both —
    // DELETE /api/events/[id]/registrations/[regId], which cancels the bill,
    // drops the booking, and refuses paid / scheduled / open-cash rows. Only a
    // spot with no bill attached (free or membership-covered) is removed here.
    const reg = await prisma.eventRegistration.findFirst({
      where: { eventId: params.id, memberId, status: { not: "CANCELED" } },
      select: { id: true, name: true },
    });
    if (reg) {
      return NextResponse.json(
        {
          error: `${reg.name} is on this event's billing list. Remove them from Attendees — that takes them off the roster and the bill together.`,
          code: "REGISTRATION_EXISTS",
          registrationId: reg.id,
        },
        { status: 409 },
      );
    }

    const deleted = await prisma.booking.deleteMany({
      where: { eventId: params.id, memberId },
    });
    if (deleted.count === 0) return NextResponse.json({ error: "Not on this event" }, { status: 404 });

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
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
