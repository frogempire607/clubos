import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { PRIVATE_PACKAGE_PURCHASE_KIND } from "@/lib/approvals";
import { shortDate } from "@/lib/billingDataRules";

// POST /api/approvals/private-package-purchase
//
// Owner/staff respond to a member's cash/check private-package request.
// Approving grants the credits (same shape the Stripe webhook writes) and
// records an unpaid manual invoice so the money owed stays visible in
// Financials. Declining just closes the request — no credits ever existed.
const schema = z.object({
  approvalId: z.string().min(1),
  decision: z.enum(["APPROVE", "DECLINE"]),
  /** The owner saw the "already bought this package by card" warning and wants a second one anyway. */
  allowDuplicate: z.boolean().optional(),
});

type Payload = {
  packageId?: string;
  paymentMethod?: string;
  totalAmount?: number;
  requestingUserId?: string;
  lessonTypeId?: string | null;
  priceOptionId?: string | null;
  coachId?: string | null;
  requestedSlots?: Array<{ date: string; startTime: string; endTime: string }>;
  notes?: string | null;
};

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "edit");
  if (denied) return denied;

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    throw err;
  }

  const clubId = session.user.clubId;
  const approval = await prisma.pendingApproval.findFirst({
    where: { id: body.approvalId, clubId, kind: PRIVATE_PACKAGE_PURCHASE_KIND, status: "PENDING" },
    include: { member: { select: { id: true, firstName: true, lastName: true } } },
  });
  if (!approval) return NextResponse.json({ error: "Request not found or already handled." }, { status: 404 });

  const payload = (approval.payload ?? {}) as Payload;
  const paymentMethod = payload.paymentMethod === "CHECK" ? "CHECK" : "CASH";
  const who = `${approval.member.firstName} ${approval.member.lastName}`.trim();

  async function close(status: "APPROVED" | "DECLINED") {
    await prisma.pendingApproval.update({
      where: { id: approval!.id },
      data: { status, respondedAt: new Date(), respondedById: session!.user.id },
    });
  }

  async function notifyRequester(text: string) {
    if (!payload.requestingUserId) return;
    await prisma.message
      .create({
        data: { clubId, senderId: session!.user.id, recipientId: payload.requestingUserId, body: text },
      })
      .catch(() => {});
  }

  if (body.decision === "DECLINE") {
    await close("DECLINED");
    await notifyRequester(
      `Your ${paymentMethod.toLowerCase()} lesson-package request for ${who} wasn't approved. Reach out to the club if you have questions.`,
    );
    return NextResponse.json({ ok: true, declined: true });
  }

  const pkg = payload.packageId
    ? await prisma.privatePackage.findFirst({
        where: { id: payload.packageId, clubId, deletedAt: null },
        select: { id: true, title: true, credits: true, bonusCredits: true, lessonTypeId: true, expiresAfterDays: true },
      })
    : null;
  if (!pkg) {
    return NextResponse.json(
      { error: "The requested package no longer exists. Decline this request and have them re-purchase." },
      { status: 400 },
    );
  }

  // Same hole as membership-purchase: the family asked to pay cash, then
  // bought the same package by card before anyone approved. Two packages can
  // be legitimate, so this is a confirm, not a wall — but it is never silent.
  if (!body.allowDuplicate) {
    const paidSince = await prisma.privateCreditLedger.findFirst({
      where: {
        clubId,
        memberId: approval.memberId,
        packageId: pkg.id,
        createdAt: { gte: approval.requestedAt },
        OR: [{ stripeCheckoutSessionId: { not: null } }, { stripePaymentIntentId: { not: null } }],
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (paidSince) {
      const club = await prisma.club.findUnique({ where: { id: clubId }, select: { timezone: true } });
      return NextResponse.json(
        {
          error:
            `${who} already bought ${pkg.title} by card on ${shortDate(paidSince.createdAt, club?.timezone)}, after this ` +
            `cash request was made. Approving adds a second package and a cash invoice. Decline this request — or approve ` +
            `anyway only if they really want two packages.`,
          code: "ALREADY_BOUGHT_PACKAGE",
        },
        { status: 409 },
      );
    }
  }

  // The approved amount is what was quoted at request time (tier-priced for
  // PERCENT/FIXED packs) — captured on the approval row.
  const amount = Number(approval.amount ?? payload.totalAmount ?? 0);
  const grants = pkg.credits + (pkg.bonusCredits ?? 0);
  const expiresAt = pkg.expiresAfterDays
    ? new Date(Date.now() + pkg.expiresAfterDays * 24 * 60 * 60 * 1000)
    : null;

  const ledger = await prisma.privateCreditLedger.create({
    data: {
      clubId,
      memberId: approval.memberId,
      packageId: pkg.id,
      lessonTypeId: pkg.lessonTypeId,
      creditsGranted: grants,
      creditsUsed: 0,
      purchaseType: "PACKAGE",
      status: "active",
      expiresAt,
      pricePaid: amount,
      notes: `In-portal ${paymentMethod.toLowerCase()} purchase approved by staff.`,
    },
  });

  // The request carried the member's scheduling info (lesson type, coach,
  // requested times) — turn it into real credit-paid booking requests so the
  // lessons show up on the owner's privates queue and the member's bookings
  // immediately, instead of credits floating with nothing scheduled.
  const requestedSlots = Array.isArray(payload.requestedSlots) ? payload.requestedSlots : [];
  const bookingLessonTypeId = payload.lessonTypeId ?? pkg.lessonTypeId ?? null;
  let bookingsCreated = 0;
  if (bookingLessonTypeId && requestedSlots.length > 0) {
    const lessonType = await prisma.privateLessonType.findFirst({
      where: { id: bookingLessonTypeId, clubId, deletedAt: null },
      select: { id: true },
    });
    if (lessonType) {
      const slots = requestedSlots.slice(0, grants);
      await Promise.all(
        slots.map((slot) =>
          prisma.privateBooking.create({
            data: {
              clubId,
              memberId: approval.memberId,
              lessonTypeId: lessonType.id,
              coachId: payload.coachId || null,
              requestedSlots: [slot],
              creditLedgerId: ledger.id,
              paymentType: "CREDIT",
              pricePaid: 0,
              allowUnpaid: true,
              notes: payload.notes || null,
              status: payload.coachId ? "PENDING_COACH" : "REQUESTED",
            },
          }),
        ),
      );
      bookingsCreated = slots.length;
    }
  }

  if (amount > 0) {
    await prisma.transaction.create({
      data: {
        clubId,
        memberId: approval.memberId,
        amount,
        status: "PENDING",
        type: "INVOICE",
        category: "private_lessons",
        paymentMethod,
        description: `Private package (${paymentMethod.toLowerCase()}): ${pkg.title}`,
        manual: true,
        txDate: new Date(),
      },
    });
  }

  await close("APPROVED");
  await notifyRequester(
    `Your lesson package for ${who} (${pkg.title}) is active — ${grants} lesson${grants === 1 ? "" : "s"} added.${
      bookingsCreated > 0
        ? ` Your ${bookingsCreated} requested lesson time${bookingsCreated === 1 ? "" : "s"} went to the coach to confirm.`
        : ""
    } The club will collect your ${paymentMethod.toLowerCase()} payment.`,
  );
  return NextResponse.json({ ok: true, granted: grants, bookingsCreated });
}
