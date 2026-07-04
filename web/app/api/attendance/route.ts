import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermission } from "@/lib/apiGuard";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { trialWindowDays, freeTrialSummary } from "@/lib/freeTrial";
import { sendEmail } from "@/lib/email";

// GET /api/attendance?date=YYYY-MM-DD
// Returns all class sessions + events for that date
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const dateStr = searchParams.get("date");

  const date = dateStr ? new Date(dateStr) : new Date();
  date.setUTCHours(0, 0, 0, 0);
  const nextDay = new Date(date);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);

  const [classSessions, events] = await Promise.all([
    prisma.classSession.findMany({
      where: {
        clubId: session.user.clubId,
        date: { gte: date, lt: nextDay },
        canceled: false,
      },
      include: {
        recurringClass: { select: { name: true, capacity: true } },
        _count: { select: { attendance: true } },
      },
      orderBy: { startsAt: "asc" },
    }),
    prisma.event.findMany({
      where: {
        clubId: session.user.clubId,
        startsAt: { gte: date, lt: nextDay },
        deletedAt: null,
      },
      include: {
        location: { select: { name: true } },
        _count: { select: { bookings: true } },
      },
      orderBy: { startsAt: "asc" },
    }),
  ]);

  return NextResponse.json({ classSessions, events });
}

const recordSchema = z.object({
  classSessionId: z.string().optional().nullable(),
  eventId: z.string().optional().nullable(),
  memberId: z.string().min(1),
  status: z.enum(["PRESENT", "ABSENT", "LATE", "TRIAL", "DROP_IN"]),
  notes: z.string().optional().nullable(),
  // TRIAL only: email the client a "your free trial started" receipt.
  emailReceipt: z.boolean().optional().default(false),
});

// POST /api/attendance — upsert an attendance record
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "attendance", "edit");
  if (denied) return denied;

  const body = await req.json();
  const parsed = recordSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { classSessionId, eventId, memberId, status, notes, emailReceipt } = parsed.data;
  if (!classSessionId && !eventId) {
    return NextResponse.json({ error: "classSessionId or eventId required" }, { status: 400 });
  }

  // Verify member belongs to club
  const member = await prisma.member.findFirst({
    where: { id: memberId, clubId: session.user.clubId, deletedAt: null },
  });
  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

  // A staff "Trial" check-in starts the club's free trial — one offer,
  // membership-like: the window (Member.trialEndsAt) covers class booking for
  // the configured days and then expires on its own. When the offer's renewal
  // is OFF, a client whose trial already ended can never get another one —
  // the check-in is REJECTED with the reason instead of silently marked, so
  // the trial can't be reused through attendance.
  let trialGranted = false;
  let trialEndsAt: Date | null = null;
  if (status === "TRIAL") {
    const activeSub = await prisma.memberSubscription.findFirst({
      where: { memberId, status: "active" },
      select: { id: true },
    });
    if (activeSub) {
      return NextResponse.json(
        { error: `${member.firstName} already has an active membership — mark them Present instead.` },
        { status: 400 },
      );
    }
    const windowActive = member.trialEndsAt && member.trialEndsAt > new Date();
    if (windowActive) {
      trialEndsAt = member.trialEndsAt;
    } else {
      const club = await prisma.club.findUnique({
        where: { id: session.user.clubId },
        select: { freeTrialConfig: true },
      });
      const summary = freeTrialSummary(club?.freeTrialConfig);
      const days = trialWindowDays(club?.freeTrialConfig, member);
      if (!days) {
        return NextResponse.json(
          {
            error: summary.active
              ? `${member.firstName} already used their free trial and the offer doesn't allow renewals.`
              : "Your club isn't offering a free trial right now — set one up from the Memberships page.",
          },
          { status: 400 },
        );
      }
      trialEndsAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
      await prisma.member.update({
        where: { id: memberId },
        data: { trialEndsAt },
      });
      trialGranted = true;
    }
  }

  // Upsert: find existing then update or create
  const existing = await prisma.attendanceRecord.findFirst({
    where: {
      ...(classSessionId ? { classSessionId } : {}),
      ...(eventId ? { eventId } : {}),
      memberId,
    },
  });

  let record;
  if (existing) {
    record = await prisma.attendanceRecord.update({
      where: { id: existing.id },
      data: {
        status,
        notes: notes ?? undefined,
        checkedInAt: status === "PRESENT" ? (existing.checkedInAt ?? new Date()) : existing.checkedInAt,
        addedById: session.user.id,
      },
      include: { member: { select: { id: true, firstName: true, lastName: true } } },
    });
  } else {
    record = await prisma.attendanceRecord.create({
      data: {
        clubId: session.user.clubId,
        classSessionId: classSessionId ?? null,
        eventId: eventId ?? null,
        memberId,
        status,
        notes: notes ?? null,
        checkedInAt: status === "PRESENT" ? new Date() : null,
        addedById: session.user.id,
      },
      include: { member: { select: { id: true, firstName: true, lastName: true } } },
    });
  }

  // Optional "your free trial started" receipt when a fresh window was
  // granted (guardian for minors). Best-effort — never blocks the check-in.
  let receiptSent = false;
  if (status === "TRIAL" && trialGranted && emailReceipt && trialEndsAt) {
    const to = (member.isMinor ? member.guardianEmail || member.email : member.email || member.guardianEmail) || "";
    if (to.trim()) {
      const club = await prisma.club.findUnique({
        where: { id: session.user.clubId },
        select: { name: true, emailFromName: true, emailReplyTo: true, freeTrialConfig: true },
      });
      const summary = freeTrialSummary(club?.freeTrialConfig);
      const endsStr = trialEndsAt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
      await sendEmail({
        to: to.trim(),
        subject: `${summary.name} started — ${club?.name ?? "your club"}`,
        fromName: club?.emailFromName || club?.name || null,
        replyTo: club?.emailReplyTo || null,
        html: `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;color:#111">
            <h2 style="margin:0 0 12px">${summary.name} started</h2>
            <p style="margin:0 0 16px;color:#444">Hi ${member.firstName}, your ${summary.days}-day ${summary.name.toLowerCase()} at ${club?.name ?? "your club"} is active.</p>
            <table style="width:100%;border-collapse:collapse;font-size:14px">
              <tr><td style="padding:6px 0;color:#666">Trial length</td><td style="padding:6px 0;text-align:right">${summary.days} day${summary.days === 1 ? "" : "s"}</td></tr>
              <tr><td style="padding:6px 0;color:#666">Ends</td><td style="padding:6px 0;text-align:right;font-weight:600">${endsStr}</td></tr>
              <tr><td style="padding:6px 0;color:#666">Cost</td><td style="padding:6px 0;text-align:right">Free</td></tr>
            </table>
            <p style="margin:16px 0 0;color:#666;font-size:13px">Book classes from your member portal while your trial is active — and pick a membership any time to keep going.</p>
          </div>`,
      })
        .then(() => {
          receiptSent = true;
        })
        .catch(() => {});
    }
  }

  return NextResponse.json({
    ...record,
    trialGranted,
    trialEndsAt: trialEndsAt?.toISOString() ?? null,
    receiptSent,
  });
}

// DELETE /api/attendance?recordId=... — hard-remove someone from a roster.
// This is for "added by accident": it deletes the AttendanceRecord entirely so
// the member is neither present nor late/absent and no attendance history is
// kept. Any money collected stays intact — the authoritative payment record is
// the linked Transaction, not this row (see AttendanceRecord in schema.prisma).
export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "attendance", "full");
  if (denied) return denied;

  const { searchParams } = new URL(req.url);
  const recordId = searchParams.get("recordId");
  if (!recordId) return NextResponse.json({ error: "recordId required" }, { status: 400 });

  const record = await prisma.attendanceRecord.findFirst({
    where: { id: recordId, clubId: session.user.clubId },
    select: { id: true },
  });
  if (!record) return NextResponse.json({ error: "Record not found" }, { status: 404 });

  await prisma.attendanceRecord.delete({ where: { id: record.id } });
  return NextResponse.json({ ok: true });
}
