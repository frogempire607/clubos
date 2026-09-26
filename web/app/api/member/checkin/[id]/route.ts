import { NextResponse } from "next/server";
import { acceptedPlansFrom, type AcceptedPlan } from "@/lib/acceptedPlans";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveFamilyContext } from "@/lib/memberContext";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import { wallClockUTCToInstant } from "@/lib/datetime";
import { checkinPaymentBlock } from "@/lib/eventPayments";
import { missingSignedEventDocs } from "@/lib/eventDocuments";
import { coverageForMembers, loadSessionCoverageContext } from "@/lib/coverageQuery";
import { decideDoor, verdictCovers } from "@/lib/doorAccess";
import { trialCoversClass, trialWindowDays } from "@/lib/freeTrial";
import { classDropInPrice } from "@/lib/attendanceBilling";

// /api/member/checkin/[id] — completes the attendance-QR intent AFTER the
// scanner is signed in. `id` is a ClassSession id or an Event id (same ids the
// public /c/[id] poster page uses). GET describes the target + which of the
// viewer's profiles can check in (self / linked children) and whether each is
// already on the roster; POST creates the attendance record idempotently.
//
// Status rules for CLASSES follow lib/doorAccess (2026-09-25): covered by a
// membership → PRESENT; no plan → the club's free trial if still available
// (started here, TRIAL); otherwise 402 DROP_IN_REQUIRED — the page offers
// "Pay $X now" (Stripe, back to this page) or "Pay cash at the desk". Events
// keep their own payment-before-check-in rule.

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
      acceptedPlans: AcceptedPlan[];
    }
  | {
      kind: "event";
      eventId: string;
      title: string;
      startsAt: Date;
      endsAt: Date;
      windowStartsAt: Date;
      windowEndsAt: Date;
      requirePaymentBeforeCheckin: boolean;
    };

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
      // B7 — with each plan's option restriction.
      acceptedPlans: acceptedPlansFrom(opts),
    };
  }
  const ev = await prisma.event.findFirst({
    where: { id, clubId, deletedAt: null },
    select: {
      id: true,
      name: true,
      startsAt: true,
      endsAt: true,
      requirePaymentBeforeCheckin: true,
    },
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
      requirePaymentBeforeCheckin: ev.requirePaymentBeforeCheckin,
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
  /** No covering membership, no trial left: "I'll pay cash at the desk". */
  payAtDesk: z.boolean().optional(),
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
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
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

  // Payment gate — only when the owner requires payment before participation.
  // Checked before the record is written so a blocked attendee isn't marked
  // present. Someone already checked in is never retro-blocked (below).
  if (target.kind === "event" && target.requirePaymentBeforeCheckin) {
    const regs = await prisma.eventRegistration.findMany({
      where: { eventId: target.eventId, memberId: member.id, status: { not: "CANCELED" } },
      orderBy: { createdAt: "desc" },
      select: { status: true, amountDue: true, paymentMethod: true },
    });
    // One person can end up with several rows (e.g. registered publicly, then
    // opened the page again later). If ANY of them is settled, they've paid —
    // judging them by the newest row alone would turn an abandoned second
    // checkout into a locked door for someone who already paid.
    const reg = regs.find((r) => r.status === "PAID") ?? regs.find((r) => r.status === "SCHEDULED") ?? regs[0] ?? null;
    const block = checkinPaymentBlock(target, reg);
    if (block) {
      return NextResponse.json(
        {
          error: "PAYMENT_REQUIRED",
          message: `${block} Please see the front desk.`,
          amountDue: Number(reg?.amountDue ?? 0),
        },
        { status: 402 },
      );
    }
  }

  // Event documents: SIGN_REQUIRED docs block check-in until validly signed
  // (same signing flow + guardian/expiry rules as everywhere else). Errors
  // fall through open — a broken lookup must not lock the door.
  if (target.kind === "event") {
    try {
      const missing = await missingSignedEventDocs(clubId, target.eventId, member.id);
      if (missing.length > 0) {
        return NextResponse.json(
          {
            error: "DOCUMENTS_REQUIRED",
            message: `Before checking in, ${member.firstName} needs to sign: ${missing.map((d) => d.title).join(", ")}. Open Documents in the portal to sign.`,
            documents: missing,
          },
          { status: 403 },
        );
      }
    } catch (e) {
      console.error("event doc check-in gate failed open", e);
    }
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
    select: { membershipId: true, optionId: true, billingPeriod: true, price: true, membership: { select: { options: true } } },
  });
  const hasAnySub = activeSubs.length > 0;

  // ── Events keep their own rules (payment-before-check-in above) ──────────
  let status = hasAnySub ? "PRESENT" : "TRIAL";
  let notes = "Self check-in via attendance QR";
  let trialEndsAt: Date | null = null;

  // ── Classes: the door rule (lib/doorAccess) ──────────────────────────────
  // Covered by a membership → in. No plan → the free trial if they can still
  // have one. Otherwise → pay the drop-in (or choose to pay cash at the desk).
  if (target.kind === "class") {
    const covCtx = await loadSessionCoverageContext(target.classSessionId, clubId);
    const verdict = covCtx ? (await coverageForMembers([member.id], covCtx, clubId)).get(member.id) ?? null : null;
    const club = await prisma.club.findUnique({ where: { id: clubId }, select: { freeTrialConfig: true } });
    const m = await prisma.member.findUnique({ where: { id: member.id }, select: { trialEndsAt: true } });
    const cs = await prisma.classSession.findUnique({
      where: { id: target.classSessionId },
      select: { recurringClass: { select: { pricingOptions: true } } },
    });
    const decision = decideDoor({
      covered: verdictCovers(verdict, hasAnySub),
      hasActiveSubscription: hasAnySub,
      trialWindowActive: !!m?.trialEndsAt && m.trialEndsAt > new Date(),
      trialCoversClass: trialCoversClass(club?.freeTrialConfig, target.acceptedMembershipIds),
      newTrialDays: m ? trialWindowDays(club?.freeTrialConfig, m) : null,
      dropInPrice: classDropInPrice(cs?.recurringClass.pricingOptions),
      payAtDesk: body.payAtDesk,
    });
    if (decision.kind === "PAY") {
      return NextResponse.json(
        {
          error: "DROP_IN_REQUIRED",
          message:
            verdict?.reason === "DAY_NOT_INCLUDED" || verdict?.reason === "OPTION_NOT_ACCEPTED"
              ? `${verdict.message.replace(/ Drop-in \$[\d.]+\.$/, "")} This class is a $${decision.amount.toFixed(2)} drop-in.`
              : `${member.firstName} doesn't have a membership that covers ${target.title}. It's a $${decision.amount.toFixed(2)} drop-in.`,
          amount: decision.amount,
          memberId: member.id,
          classSessionId: target.classSessionId,
        },
        { status: 402 },
      );
    }
    if (decision.kind === "PRESENT") {
      status = "PRESENT";
      if (decision.reason === "NO_PRICE_SET") notes = "Self check-in via attendance QR — no membership, and this class has no drop-in price set";
    } else if (decision.kind === "TRIAL") {
      status = "TRIAL";
      notes = "Self check-in via attendance QR — free trial";
    } else if (decision.kind === "START_TRIAL") {
      status = "TRIAL";
      trialEndsAt = new Date(Date.now() + decision.days * 86_400_000);
      notes = `Self check-in via attendance QR — started ${decision.days}-day free trial`;
    } else if (decision.kind === "PAY_AT_DESK") {
      status = "PRESENT";
      notes = `Self check-in via attendance QR — PAYING $${decision.amount.toFixed(2)} DROP-IN CASH AT THE DESK`;
    }
  }

  if (trialEndsAt) {
    await prisma.member.update({ where: { id: member.id }, data: { trialEndsAt } });
  }

  const record = await prisma.attendanceRecord.create({
    data: {
      clubId,
      classSessionId: target.kind === "class" ? target.classSessionId : null,
      eventId: target.kind === "event" ? target.eventId : null,
      memberId: member.id,
      status,
      checkedInAt: new Date(),
      addedById: session.user.id,
      notes,
    },
  });

  return NextResponse.json({
    ok: true,
    already: false,
    status: record.status,
    message: `${member.firstName} is checked in to ${target.title}.`,
  });
}
