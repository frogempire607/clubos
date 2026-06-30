import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveFamilyContext } from "@/lib/memberContext";

const schema = z.object({
  action: z.enum(["CANCEL", "REQUEST_CHANGE"]),
  reason: z.string().trim().max(1000).optional().nullable(),
});

// PATCH /api/member/privates/[id]
// The athlete (or their guardian) cancels or requests a change to their own
// private-lesson booking. Cancellation flips the booking to CANCELED with the
// reason; a change request leaves the booking in place and messages staff so a
// coach can propose a new time. Staff-side cancel/confirm lives in
// /api/private-lessons/bookings/[id].
export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const booking = await prisma.privateBooking.findFirst({
    where: { id: params.id, clubId: session.user.clubId },
    include: {
      lessonType: { select: { title: true } },
      member: { select: { id: true, firstName: true, lastName: true } },
    },
  });
  if (!booking) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Ownership: the caller must be the athlete or a guardian of that athlete.
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { email: true },
  });
  const resolved = user
    ? await resolveFamilyContext(session.user.id, session.user.clubId, user.email, booking.memberId)
    : null;
  if (!resolved || resolved === "FORBIDDEN" || resolved.context?.id !== booking.memberId) {
    return NextResponse.json({ error: "You can't manage this booking." }, { status: 403 });
  }

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  if (["CANCELED", "DECLINED", "COMPLETED"].includes(booking.status)) {
    return NextResponse.json({ error: "This booking can no longer be changed." }, { status: 400 });
  }

  const who = `${booking.member.firstName} ${booking.member.lastName}`.trim() || "A member";
  const lesson = booking.lessonType?.title ?? "lesson";

  // Notify the assigned coach, or the owner if the lesson isn't assigned yet.
  const coachId = booking.coachId;
  async function notifyStaff(body: string) {
    let staffUserId = coachId ?? null;
    if (!staffUserId) {
      const owner = await prisma.user.findFirst({
        where: { clubId: session!.user.clubId, role: "OWNER", deletedAt: null },
        select: { id: true },
      });
      staffUserId = owner?.id ?? null;
    }
    if (staffUserId) {
      await prisma.message
        .create({
          data: {
            clubId: session!.user.clubId,
            senderId: session!.user.id,
            recipientId: staffUserId,
            body,
          },
        })
        .catch(() => {});
    }
  }

  if (data.action === "CANCEL") {
    await prisma.privateBooking.update({
      where: { id: booking.id },
      data: {
        status: "CANCELED",
        canceledAt: new Date(),
        canceledById: session.user.id,
        cancelReason: data.reason || null,
      },
    });
    await notifyStaff(
      `${who} canceled their private lesson "${lesson}".${data.reason ? ` Reason: ${data.reason}` : ""}`,
    );
    return NextResponse.json({ ok: true, status: "CANCELED" });
  }

  // REQUEST_CHANGE — keep the booking; the coach follows up to re-propose a time.
  await notifyStaff(
    `${who} requested a change to their private lesson "${lesson}".${data.reason ? ` Details: ${data.reason}` : ""}`,
  );
  return NextResponse.json({ ok: true, status: booking.status, requested: true });
}
