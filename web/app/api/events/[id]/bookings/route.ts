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
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
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

    // ── Remove them from the BILLING list too ────────────────────────────────
    // Bookings and EventRegistrations are separate tables: the attendee list
    // reads bookings, the invoice list reads event_registrations. Removing a
    // booking used to leave the registration row untouched and fully
    // invoiceable, so kids pulled off the roster still received payment links
    // (Frog Empire Road Trip, 2026-08-03 — 13 registrations, 2 bookings).
    //
    // CANCELED is the removal: bill-registrants, the capacity count, and the
    // roster all already exclude it, and it preserves the history that a hard
    // delete would destroy.
    let registrationCanceled = false;
    let registrationKept: string | null = null;
    const reg = await prisma.eventRegistration.findFirst({
      where: { eventId: params.id, memberId, status: { not: "CANCELED" } },
      orderBy: { createdAt: "desc" },
    });
    if (reg) {
      // Money already committed against this registration is not ours to
      // erase — a paid registrant needs a refund decision, and an open
      // cash/check record needs voiding. Say so instead of silently dropping
      // it or silently keeping it.
      const committed =
        reg.status === "PAID" ||
        reg.status === "SCHEDULED" ||
        reg.status === "AWAITING_CASH" ||
        reg.status === "AWAITING_CHECK" ||
        !!reg.transactionId ||
        Number(reg.amountPaid ?? 0) > 0;
      if (committed) {
        registrationKept =
          "This registrant still has money committed (paid, scheduled, or an open cash/check record). The booking was removed but they remain on the billing list — settle or refund them on the Registrations screen.";
      } else {
        await prisma.eventRegistration.updateMany({
          where: { id: reg.id, clubId: session.user.clubId, status: { not: "CANCELED" } },
          data: { status: "CANCELED" },
        });
        registrationCanceled = true;
      }
    }

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

    return NextResponse.json({ ok: true, registrationCanceled, registrationKept });
  } catch (err) {
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
