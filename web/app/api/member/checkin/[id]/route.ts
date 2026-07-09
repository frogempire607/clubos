import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveFamilyContext } from "@/lib/memberContext";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import { wallClockUTCToInstant } from "@/lib/datetime";

// /api/member/checkin/[id] — completes the attendance-QR intent AFTER the
// scanner is signed in. `id` is a ClassSession id or an Event id (same ids the
// public /c/[id] poster page uses). GET describes the target + which of the
// viewer's profiles can check in (self / linked children) and whether each is
// already on the roster; POST creates the attendance record idempotently.
//
// Status rules mirror the door conventions: covered by an accepted membership
// (or any active plan when the class doesn't restrict) → PRESENT; everyone
// else (brand-new prospects, active trial windows) → TRIAL, so staff can flip
// to Drop-In and charge from the roster if the club wants payment.

// startsAt/endsAt are the STORED stamps (classes: wall-clock pinned to UTC;
// events: true instants) — the check-in page renders them with the matching
// convention, so they must not be converted. windowStartsAt/windowEndsAt are
// the real instants used for open/closed math against Date.now(): for classes
// they're resolved through Club.timezone (when set); for events they equal
// the stored stamps.
type Target =
  | {
      kind: "class";
      classSessionId: string;
      title: string;
      startsAt: Date;
      endsAt: Date;
      windowStartsAt: Date;
      windowEndsAt: Date;
      acceptedMembershipIds: string[];
    }
  | { kind: "event"; eventId: string; title: string; startsAt: Date; endsAt: Date; windowStartsAt: Date; windowEndsAt: Date };

async function resolveTarget(id: string, clubId: string): Promise<Target | null> {
  const ses = await prisma.classSession.findFirst({
    where: { id, clubId, canceled: false },
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      recurringClass: { select: { name: true, deletedAt: true, pricingOptions: true } },
    },
  });
  if (ses && ses.recurringClass && !ses.recurringClass.deletedAt) {
    const opts = Array.isArray(ses.recurringClass.pricingOptions)
      ? (ses.recurringClass.pricingOptions as Array<{ type?: string; membershipId?: string }>)
      : [];
    const club = await prisma.club.findUnique({ where: { id: clubId }, select: { timezone: true } });
    return {
      kind: "class",
      classSessionId: ses.id,
      title: ses.recurringClass.name,
      startsAt: ses.startsAt,
      endsAt: ses.endsAt,
      windowStartsAt: wallClockUTCToInstant(ses.startsAt, club?.timezone),
      windowEndsAt: wallClockUTCToInstant(ses.endsAt, club?.timezone),
      acceptedMembershipIds: opts
        .filter((o) => o?.type === "membership" && !!o.membershipId)
        .map((o) => o.membershipId as string),
    };
  }
  const ev = await prisma.event.findFirst({
    where: { id, clubId, deletedAt: null },
    select: { id: true, name: true, startsAt: true, endsAt: true },
  });
  if (ev) {
    return {
      kind: "event",
      eventId: ev.id,
      title: ev.name,
      startsAt: ev.startsAt,
      endsAt: ev.endsAt,
      windowStartsAt: ev.startsAt,
      windowEndsAt: ev.endsAt,
    };
  }
  return null;
}

function sessionEnded(target: Target): boolean {
  // Allow generous late check-in (the coach may run the roster after class),
  // but a stale poster for a long-past session shouldn't create records.
  const graceMs = 12 * 60 * 60 * 1000;
  return target.windowEndsAt.getTime() + graceMs < Date.now();
}

// Check-in opens 60 minutes before start. The QR poster is scanned at the
// door so this never bit the QR flow, but the My Bookings / My Schedule
// check-in buttons would otherwise let someone "arrive" days early.
const CHECKIN_OPENS_BEFORE_MS = 60 * 60 * 1000;

function checkinNotOpenYet(target: Target): boolean {
  return target.windowStartsAt.getTime() - CHECKIN_OPENS_BEFORE_MS > Date.now();
}

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "MEMBER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const clubId = session.user.clubId;

  const target = await resolveTarget(params.id, clubId);
  if (!target) return NextResponse.json({ error: "This check-in link is no longer available." }, { status: 404 });

  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { email: true } });
  if (!user) return NextResponse.json({ error: "Account not found" }, { status: 404 });
  const resolved = await resolveFamilyContext(session.user.id, clubId, user.email, null);
  if (resolved === "FORBIDDEN" || !resolved) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  const memberIds = resolved.accessible.map((m) => m.id);
  const existing = memberIds.length
    ? await prisma.attendanceRecord.findMany({
        where: {
          memberId: { in: memberIds },
          ...(target.kind === "class" ? { classSessionId: target.classSessionId } : { eventId: target.eventId }),
        },
        select: { memberId: true, checkedInAt: true },
      })
    : [];
  // Only a stamped arrival counts as checked in — a pre-booked roster row
  // (checkedInAt null) should still offer check-in.
  const checkedIn = new Set(existing.filter((r) => r.checkedInAt).map((r) => r.memberId));

  return NextResponse.json({
    target: {
      kind: target.kind,
      title: target.title,
      startsAt: target.startsAt.toISOString(),
      endsAt: target.endsAt.toISOString(),
      ended: sessionEnded(target),
    },
    profiles: resolved.accessible.map((m) => ({
      id: m.id,
      firstName: m.firstName,
      lastName: m.lastName,
      kind: m.kind,
      alreadyCheckedIn: checkedIn.has(m.id),
    })),
    defaultMemberId: resolved.context?.id ?? null,
  });
}

const postSchema = z.object({
  memberId: z.string().optional().nullable(),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "MEMBER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const clubId = session.user.clubId;

  const rl = rateLimit({ key: `checkin:${session.user.id}`, limit: 20, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many check-in attempts. Try again in a moment.");

  let body: z.infer<typeof postSchema>;
  try {
    body = postSchema.parse(await req.json().catch(() => ({})));
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const target = await resolveTarget(params.id, clubId);
  if (!target) return NextResponse.json({ error: "This check-in link is no longer available." }, { status: 404 });
  if (sessionEnded(target)) {
    return NextResponse.json(
      { error: `${target.title} has already ended — ask your club to check you in if you attended.` },
      { status: 400 },
    );
  }
  if (checkinNotOpenYet(target)) {
    return NextResponse.json(
      { error: `Check-in for ${target.title} opens 1 hour before it starts.` },
      { status: 400 },
    );
  }

  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { email: true } });
  if (!user) return NextResponse.json({ error: "Account not found" }, { status: 404 });
  const resolved = await resolveFamilyContext(session.user.id, clubId, user.email, body.memberId ?? null);
  if (resolved === "FORBIDDEN") {
    return NextResponse.json({ error: "You can't check in that profile." }, { status: 403 });
  }
  const member = resolved?.context ?? null;
  if (!member) {
    return NextResponse.json(
      { error: "Your account isn't linked to a member profile yet. Contact your club." },
      { status: 400 },
    );
  }

  // Idempotent: a retried scan / double tap never duplicates the record.
  // A record WITHOUT checkedInAt is a booking (class self-booking creates the
  // roster row ahead of time) — checking in stamps the arrival on that row.
  const where =
    target.kind === "class"
      ? { classSessionId: target.classSessionId, memberId: member.id }
      : { eventId: target.eventId, memberId: member.id };
  const existing = await prisma.attendanceRecord.findFirst({
    where,
    select: { id: true, status: true, checkedInAt: true },
  });
  if (existing) {
    if (existing.checkedInAt) {
      return NextResponse.json({
        ok: true,
        already: true,
        status: existing.status,
        message: `${member.firstName} is already checked in to ${target.title}.`,
      });
    }
    await prisma.attendanceRecord.update({
      where: { id: existing.id },
      data: { checkedInAt: new Date() },
    });
    return NextResponse.json({
      ok: true,
      already: false,
      status: existing.status,
      message: `${member.firstName} is checked in to ${target.title}.`,
    });
  }

  const activeSubs = await prisma.memberSubscription.findMany({
    where: { memberId: member.id, status: "active" },
    select: { membershipId: true },
  });
  const hasAnySub = activeSubs.length > 0;
  let covered = hasAnySub;
  if (target.kind === "class" && target.acceptedMembershipIds.length > 0) {
    covered = activeSubs.some((s) => target.acceptedMembershipIds.includes(s.membershipId));
  }
  const status = covered ? "PRESENT" : "TRIAL";

  const record = await prisma.attendanceRecord.create({
    data: {
      clubId,
      classSessionId: target.kind === "class" ? target.classSessionId : null,
      eventId: target.kind === "event" ? target.eventId : null,
      memberId: member.id,
      status,
      checkedInAt: new Date(),
      addedById: session.user.id,
      notes: "Self check-in via attendance QR",
    },
  });

  return NextResponse.json({
    ok: true,
    already: false,
    status: record.status,
    message: `${member.firstName} is checked in to ${target.title}.`,
  });
}
