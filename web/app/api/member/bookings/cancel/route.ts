import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveFamilyContext } from "@/lib/memberContext";

// POST /api/member/bookings/cancel
//
// A member (or their guardian) cancels their own CLASS booking (an
// AttendanceRecord created ahead of the session) or EVENT booking. Mirrors the
// private-lesson cancel rules: the cancel always goes through, but money is
// NEVER auto-refunded — when the spot was paid for, staff get a DM flagging a
// refund request to review. Private lessons keep their own richer route
// (/api/member/privates/[id]).
const schema = z.object({
  kind: z.enum(["class", "event"]),
  id: z.string().min(1),
  reason: z.string().trim().max(1000).optional().nullable(),
});

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
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
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
    if (record.classSession.startsAt < new Date()) {
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
