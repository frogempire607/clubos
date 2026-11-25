import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveFamilyContext } from "@/lib/memberContext";
import { classHasStarted } from "@/lib/datetime";
import { loadSelfCancel, runSelfCancel } from "@/lib/eventSelfCancelServer";

// POST /api/member/bookings/cancel
//
// A member (or their guardian) cancels their own CLASS booking (an
// AttendanceRecord created ahead of the session) or EVENT booking.
//
// Classes, and events with no refund policy: the cancel always goes through
// and money is never refunded automatically; staff get a DM to review. Private
// lessons keep their own richer route (/api/member/privates/[id]).
//
// An event WITH a refund policy (2026-11-25) applies it, and says so first:
// GET answers what canceling means for their money, and POST must send back
// what they agreed to (`agreed`). Before the deadline the event price goes
// back automatically; after it, no refund. Rules: lib/eventRefundPolicy
// selfCancelPlan; money: lib/eventSelfCancelServer.
const schema = z.object({
  kind: z.enum(["class", "event"]),
  id: z.string().min(1),
  reason: z.string().trim().max(1000).optional().nullable(),
  // The plan they were shown (GET's token). Only events with a policy use it.
  agreed: z.string().max(60).optional().nullable(),
});

export const maxDuration = 60;

// GET /api/member/bookings/cancel?kind=event&id=<bookingId>
// What canceling would mean for their money. Reads only.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "MEMBER") {
    return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  }
  const clubId = session.user.clubId;
  const q = new URL(req.url).searchParams;
  if (q.get("kind") !== "event" || !q.get("id")) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  const found = await loadSelfCancel(clubId, q.get("id") as string, new Date());
  if (!found) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { email: true } });
  const resolved = user ? await resolveFamilyContext(session.user.id, clubId, user.email, found.memberId) : "FORBIDDEN";
  if (resolved === "FORBIDDEN" || resolved?.context?.id !== found.memberId) {
    return NextResponse.json({ error: "You can't manage this booking." }, { status: 403 });
  }
  return NextResponse.json({ text: found.plan.text, token: found.plan.token, blocked: found.plan.kind === "BLOCKED" }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "MEMBER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const clubId = session.user.clubId;

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    throw err;
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { email: true },
  });
  if (!user) return NextResponse.json({ error: "Account not found" }, { status: 404 });

  async function assertOwnership(memberId: string) {
    const resolved = await resolveFamilyContext(session!.user.id, clubId, user!.email, memberId);
    return resolved !== "FORBIDDEN" && resolved?.context?.id === memberId;
  }

  async function notifyStaff(body: string) {
    const owner = await prisma.user.findFirst({
      where: { clubId, role: "OWNER", deletedAt: null },
      select: { id: true },
    });
    if (!owner) return;
    await prisma.message
      .create({ data: { clubId, senderId: session!.user.id, recipientId: owner.id, body } })
      .catch(() => {});
  }

  if (data.kind === "class") {
    const record = await prisma.attendanceRecord.findFirst({
      where: { id: data.id, clubId },
      include: {
        classSession: { select: { startsAt: true, recurringClass: { select: { name: true } } } },
        member: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    if (!record || !record.classSession) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }
    if (!(await assertOwnership(record.memberId))) {
      return NextResponse.json({ error: "You can't manage this booking." }, { status: 403 });
    }
    // Wall-clock-UTC stamp vs a true instant — same frame mismatch that made
    // booking fail hours early. Cancelling was refused on the same schedule.
    const cancelClub = await prisma.club.findUnique({ where: { id: clubId }, select: { timezone: true } });
    if (classHasStarted(record.classSession.startsAt, cancelClub?.timezone)) {
      return NextResponse.json({ error: "This class has already started." }, { status: 400 });
    }

    const paid = Number(record.amountCharged ?? 0) > 0;
    const who = `${record.member.firstName} ${record.member.lastName}`.trim();
    const className = record.classSession.recurringClass?.name ?? "a class";

    // Frees the roster spot; any collected payment stays in Financials.
    await prisma.attendanceRecord.delete({ where: { id: record.id } });

    if (paid) {
      await notifyStaff(
        `${who} canceled their booking for "${className}" (paid $${Number(record.amountCharged).toFixed(2)}) and is requesting a refund.${
          data.reason ? ` Reason: ${data.reason}` : ""
        } Refunds are not automatic — please review and follow up.`,
      );
      return NextResponse.json({
        ok: true,
        refundRequested: true,
        message: "Booking canceled. Payments aren't refunded automatically — your club has been asked to review your refund.",
      });
    }
    await notifyStaff(
      `${who} canceled their booking for "${className}".${data.reason ? ` Reason: ${data.reason}` : ""}`,
    );
    return NextResponse.json({ ok: true, message: "Booking canceled." });
  }

  // EVENT
  const booking = await prisma.booking.findFirst({
    where: { id: data.id, event: { clubId } },
    include: {
      event: { select: { name: true, startsAt: true, memberPrice: true, nonMemberPrice: true, dropInFee: true } },
      member: { select: { id: true, firstName: true, lastName: true } },
    },
  });
  if (!booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  if (!(await assertOwnership(booking.memberId))) {
    return NextResponse.json({ error: "You can't manage this booking." }, { status: 403 });
  }
  if (booking.status === "CANCELED") {
    return NextResponse.json({ error: "This booking is already canceled." }, { status: 400 });
  }
  if (booking.event.startsAt < new Date()) {
    return NextResponse.json({ error: "This event has already started." }, { status: 400 });
  }

  const policyCancel = await loadSelfCancel(clubId, booking.id, new Date());
  if (policyCancel && policyCancel.plan.kind !== "LEGACY") {
    const shown = { text: policyCancel.plan.text, token: policyCancel.plan.token, blocked: policyCancel.plan.kind === "BLOCKED" };
    if (policyCancel.plan.kind === "BLOCKED") return NextResponse.json({ error: policyCancel.plan.text, plan: shown }, { status: 409 });
    // Never cancel on terms they weren't shown: a deadline that passed while
    // the sheet was open, or an older screen that shows no terms at all.
    if (data.agreed !== policyCancel.plan.token) {
      return NextResponse.json({ error: "What you get back has changed. Read it again, then confirm.", code: "PLAN_CHANGED", plan: shown }, { status: 409 });
    }
    const done = await runSelfCancel(policyCancel, { clubId, actorUserId: session.user.id ?? null, reason: data.reason ?? null });
    await notifyStaff(done.staffMessage);
    if (!done.ok) return NextResponse.json({ error: done.message }, { status: 409 });
    return NextResponse.json({ ok: true, refunded: done.refunded, message: done.message });
  }

  await prisma.booking.update({ where: { id: booking.id }, data: { status: "CANCELED" } });

  // Bookings don't record what (if anything) was collected, so any priced
  // event routes through staff review — money never moves automatically.
  const mayHavePaid =
    Number(booking.event.memberPrice ?? 0) > 0 ||
    Number(booking.event.nonMemberPrice ?? 0) > 0 ||
    Number(booking.event.dropInFee ?? 0) > 0;
  const who = `${booking.member.firstName} ${booking.member.lastName}`.trim();

  if (mayHavePaid) {
    await notifyStaff(
      `${who} canceled their registration for "${booking.event.name}" and may be owed a refund if they paid.${
        data.reason ? ` Reason: ${data.reason}` : ""
      } Refunds are not automatic — please review and follow up.`,
    );
    return NextResponse.json({
      ok: true,
      refundRequested: true,
      message: "Registration canceled. If you paid, refunds aren't automatic — your club has been asked to review it.",
    });
  }
  await notifyStaff(
    `${who} canceled their registration for "${booking.event.name}".${data.reason ? ` Reason: ${data.reason}` : ""}`,
  );
  return NextResponse.json({ ok: true, message: "Registration canceled." });
}
