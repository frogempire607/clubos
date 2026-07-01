import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateInviteToken } from "@/lib/privatePartners";
import { hasPermission } from "@/lib/permissions";

const patchSchema = z.object({
  // Owner/coach: convert NEEDS_HELP → MEMBER (or change other fields).
  kind: z.enum(["MEMBER", "OUTSIDE", "NEEDS_HELP"]).optional(),
  memberId: z.string().optional().nullable(),
  outsideName: z.string().max(120).optional().nullable(),
  outsideEmail: z.string().email().optional().nullable(),
  outsidePhone: z.string().max(40).optional().nullable(),
  status: z.enum(["PENDING_COACH", "INVITED", "CONFIRMED", "DECLINED"]).optional(),
  notes: z.string().max(500).optional().nullable(),
  // Owner can force-regenerate a token (e.g. lost link).
  regenerateToken: z.boolean().optional(),
});

type SessionUser = { id: string; clubId: string; role: string; permissions?: Record<string, unknown> | null };

async function loadAuthorized(
  partnerId: string,
  bookingId: string,
  user: SessionUser | null,
) {
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const partner = await prisma.privateBookingPartner.findFirst({
    where: { id: partnerId, bookingId, clubId: user.clubId },
    include: { booking: { select: { coachId: true, status: true } } },
  });
  if (!partner) return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };

  const isOwner = user.role === "OWNER";
  const isCoach = partner.booking.coachId === user.id;
  if (!isOwner && !isCoach && !hasPermission(user.permissions ?? null, "events", "edit")) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { partner };
}

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string; partnerId: string }> },
) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  const sessionUser = session?.user
    ? { id: session.user.id, clubId: session.user.clubId, role: session.user.role, permissions: (session.user as { permissions?: Record<string, unknown> | null }).permissions ?? null }
    : null;
  const { partner, error } = await loadAuthorized(params.partnerId, params.id, sessionUser);
  if (error || !partner) return error!;

  let data: z.infer<typeof patchSchema>;
  try {
    data = patchSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const update: Record<string, unknown> = {};

  if (data.kind) update.kind = data.kind;

  if (data.kind === "MEMBER" || (!data.kind && partner.kind === "MEMBER" && data.memberId !== undefined)) {
    if (!data.memberId) return NextResponse.json({ error: "memberId required for MEMBER kind" }, { status: 400 });
    const m = await prisma.member.findFirst({
      where: { id: data.memberId, clubId: sessionUser!.clubId, deletedAt: null },
      select: { id: true },
    });
    if (!m) return NextResponse.json({ error: "Member not found" }, { status: 400 });
    update.memberId = data.memberId;
    // Reset outside fields when converting to a MEMBER partner.
    update.outsideName = null;
    update.outsideEmail = null;
    update.outsidePhone = null;
    update.outsideInfo = null;
    update.inviteToken = null;
    update.inviteTokenExpiresAt = null;
  }

  if (data.kind === "OUTSIDE") {
    update.memberId = null;
    if (data.outsideName !== undefined) update.outsideName = data.outsideName;
    if (data.outsideEmail !== undefined) update.outsideEmail = data.outsideEmail;
    if (data.outsidePhone !== undefined) update.outsidePhone = data.outsidePhone;
    // Generate a token if the booking is already past coach approval.
    if (partner.booking.status === "CONFIRMED" || partner.booking.status === "COMPLETED") {
      if (!partner.inviteToken || data.regenerateToken) {
        update.inviteToken = generateInviteToken();
        update.inviteTokenExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        if (partner.status === "PENDING_COACH") update.status = "INVITED";
      }
    }
  }

  if (data.kind === "NEEDS_HELP") {
    update.memberId = null;
    update.outsideName = null;
    update.outsideEmail = null;
    update.outsidePhone = null;
    update.inviteToken = null;
    update.inviteTokenExpiresAt = null;
  }

  if (data.status) {
    update.status = data.status;
    if (data.status === "CONFIRMED") update.confirmedAt = new Date();
    if (data.status === "DECLINED") update.respondedAt = new Date();
  }

  if (data.regenerateToken && partner.kind === "OUTSIDE" && !update.inviteToken) {
    update.inviteToken = generateInviteToken();
    update.inviteTokenExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  }

  if (data.notes !== undefined) update.notes = data.notes;

  const updated = await prisma.privateBookingPartner.update({
    where: { id: partner.id },
    data: update,
  });

  return NextResponse.json(updated);
}

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ id: string; partnerId: string }> },
) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  const sessionUser = session?.user
    ? { id: session.user.id, clubId: session.user.clubId, role: session.user.role, permissions: (session.user as { permissions?: Record<string, unknown> | null }).permissions ?? null }
    : null;
  const { partner, error } = await loadAuthorized(params.partnerId, params.id, sessionUser);
  if (error || !partner) return error!;

  await prisma.privateBookingPartner.delete({ where: { id: partner.id } });
  return NextResponse.json({ ok: true });
}
