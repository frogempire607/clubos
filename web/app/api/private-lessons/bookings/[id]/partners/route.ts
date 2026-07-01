import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateInviteToken } from "@/lib/privatePartners";
import { hasPermission } from "@/lib/permissions";

const schema = z.object({
  kind: z.enum(["MEMBER", "OUTSIDE", "NEEDS_HELP"]),
  memberId: z.string().optional().nullable(),
  outsideName: z.string().max(120).optional().nullable(),
  outsideEmail: z.string().email().optional().nullable(),
  outsidePhone: z.string().max(40).optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
});

// POST /api/private-lessons/bookings/[id]/partners — owner/coach manually adds
// a partner row (e.g. after sourcing one for a NEEDS_HELP request, or pre-
// confirming a member partner). OUTSIDE rows added after the booking is
// already CONFIRMED get an invite token immediately so the booker can share.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const booking = await prisma.privateBooking.findFirst({
    where: { id: params.id, clubId: session.user.clubId },
    include: { lessonType: { select: { maxAthletes: true } } },
  });
  if (!booking) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const isOwner = session.user.role === "OWNER";
  const isCoach = booking.coachId === session.user.id;
  const perms = (session.user as { permissions?: Record<string, unknown> | null }).permissions ?? null;
  if (!isOwner && !isCoach && !hasPermission(perms, "events", "edit")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const existing = await prisma.privateBookingPartner.count({ where: { bookingId: booking.id } });
  const maxPartners = (booking.lessonType.maxAthletes ?? 1) - 1;
  if (existing >= maxPartners) {
    return NextResponse.json(
      { error: `This lesson type allows at most ${maxPartners} partner(s).` },
      { status: 400 },
    );
  }

  if (data.kind === "MEMBER") {
    if (!data.memberId) return NextResponse.json({ error: "memberId required" }, { status: 400 });
    if (data.memberId === booking.memberId) {
      return NextResponse.json({ error: "Primary member can't also be a partner." }, { status: 400 });
    }
    const m = await prisma.member.findFirst({
      where: { id: data.memberId, clubId: session.user.clubId, deletedAt: null },
      select: { id: true },
    });
    if (!m) return NextResponse.json({ error: "Member not found" }, { status: 400 });
  }

  // If the parent booking is already past the coach-approval stage, an
  // outside partner needs an invite token right away so the booker can share.
  const alreadyApproved = ["CONFIRMED", "COMPLETED"].includes(booking.status);
  const inviteToken =
    data.kind === "OUTSIDE" && alreadyApproved ? generateInviteToken() : null;

  const partner = await prisma.privateBookingPartner.create({
    data: {
      clubId: session.user.clubId,
      bookingId: booking.id,
      kind: data.kind,
      memberId: data.kind === "MEMBER" ? data.memberId || null : null,
      outsideName: data.kind === "OUTSIDE" ? data.outsideName || null : null,
      outsideEmail: data.kind === "OUTSIDE" ? data.outsideEmail || null : null,
      outsidePhone: data.kind === "OUTSIDE" ? data.outsidePhone || null : null,
      notes: data.notes || null,
      status: alreadyApproved ? "INVITED" : "PENDING_COACH",
      inviteToken,
      inviteTokenExpiresAt: inviteToken ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : null,
    },
  });

  return NextResponse.json(partner, { status: 201 });
}
