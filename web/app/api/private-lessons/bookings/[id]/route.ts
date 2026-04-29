import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendMemberMessage } from "@/lib/memberMessaging";

const schema = z.object({
  action: z.enum(["ACCEPT", "DECLINE", "PROPOSE", "COMPLETE", "CANCEL", "ASSIGN_COACH", "APPROVE"]),
  // For ACCEPT / PROPOSE
  confirmedStartAt: z.string().optional().nullable(),
  confirmedEndAt:   z.string().optional().nullable(),
  proposedSlots:    z.array(z.object({ date: z.string(), startTime: z.string(), endTime: z.string() })).optional(),
  // For ASSIGN_COACH
  coachId:     z.string().optional().nullable(),
  // For CANCEL
  cancelReason: z.string().optional().nullable(),
  // For notes
  notes: z.string().optional().nullable(),
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const booking = await prisma.privateBooking.findFirst({
    where: { id: params.id, clubId: session.user.clubId },
    include: { member: { select: { firstName: true, lastName: true } }, lessonType: { select: { title: true } } },
  });
  if (!booking) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const isOwner = session.user.role === "OWNER";
  const isCoach = booking.coachId === session.user.id;

  try {
    const { action, confirmedStartAt, confirmedEndAt, proposedSlots, coachId, cancelReason, notes } = schema.parse(await req.json());

    let updateData: Record<string, unknown> = {};

    switch (action) {
      case "ACCEPT": {
        if (!isCoach && !isOwner) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
        if (!confirmedStartAt || !confirmedEndAt) {
          return NextResponse.json({ error: "confirmedStartAt and confirmedEndAt required" }, { status: 400 });
        }
        updateData = {
          status: "CONFIRMED",
          confirmedStartAt: new Date(confirmedStartAt),
          confirmedEndAt:   new Date(confirmedEndAt),
        };

        // Deduct one lesson from the package balance when a requested lesson is scheduled.
        if (booking.creditLedgerId && booking.status !== "CONFIRMED" && booking.status !== "COMPLETED") {
          await prisma.privateCreditLedger.update({
            where: { id: booking.creditLedgerId },
            data: { creditsUsed: { increment: 1 } },
          });
          // Mark exhausted if fully used
          const ledger = await prisma.privateCreditLedger.findUnique({ where: { id: booking.creditLedgerId } });
          if (ledger && ledger.creditsUsed >= ledger.creditsGranted) {
            await prisma.privateCreditLedger.update({
              where: { id: booking.creditLedgerId },
              data: { status: "exhausted" },
            });
          }
        }

        await sendMemberMessage({
          clubId: session.user.clubId,
          senderId: session.user.id,
          memberId: booking.memberId,
          body: `Your private lesson "${booking.lessonType.title}" has been confirmed. Time: ${new Date(confirmedStartAt).toLocaleString()}.`,
        });
        break;
      }

      case "DECLINE": {
        if (!isCoach && !isOwner) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
        updateData = { status: "DECLINED", canceledAt: new Date(), canceledById: session.user.id, cancelReason: cancelReason || null };
        break;
      }

      case "PROPOSE": {
        if (!isCoach && !isOwner) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
        updateData = {
          status: "PENDING_COACH",
          requestedSlots: proposedSlots || booking.requestedSlots,
          notes: notes || booking.notes,
        };
        break;
      }

      case "COMPLETE": {
        if (!isOwner && !isCoach) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
        updateData = { status: "COMPLETED" };
        break;
      }

      case "CANCEL": {
        updateData = {
          status: "CANCELED",
          canceledAt:   new Date(),
          canceledById: session.user.id,
          cancelReason: cancelReason || null,
        };
        break;
      }

      case "ASSIGN_COACH": {
        if (!isOwner) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
        updateData = { coachId: coachId || null, status: coachId ? "PENDING_COACH" : "REQUESTED" };

        // Notify coach
        if (coachId) {
          const slotDesc = (booking.requestedSlots as { date: string; startTime: string; endTime: string }[])
            .map((s) => `${s.date} ${s.startTime}–${s.endTime}`)
            .join(", ");
          await prisma.message.create({
            data: {
              clubId:      session.user.clubId,
              senderId:    session.user.id,
              recipientId: coachId,
              body: `You've been assigned a private lesson request from ${booking.member.firstName} ${booking.member.lastName} for "${booking.lessonType.title}". Requested times: ${slotDesc}.`,
            },
          });
        }
        break;
      }

      case "APPROVE": {
        if (!isOwner) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
        updateData = { ownerApproved: true };
        break;
      }
    }

    if (notes !== undefined) updateData.notes = notes;

    const updated = await prisma.privateBooking.update({ where: { id: params.id }, data: updateData });
    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
