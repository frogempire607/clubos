import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { formatZodError } from "@/lib/zodErrors";
import { requirePermissionLive } from "@/lib/apiGuard";
import { selfRule, SELF_DENY_MESSAGE } from "@/lib/staffSelf";
import { recordStaffActivity, actorFrom } from "@/lib/staffActivity";
import { prisma } from "@/lib/prisma";
import { PAYOUT_METHODS } from "@/lib/payouts";
import { formatUsd } from "@/lib/payReminders";
import {
  dateFromYmd,
  formatShortDate,
  isValidYmd,
  paydaysInRange,
  periodFor,
  ymdFromDate,
} from "@/lib/paySchedule";
import { PayLedgerError, createLedgerPayout, getLedgerStart, periodLines, syncPayLines } from "@/lib/payLedgerServer";
import { writeBillingAudit } from "@/lib/billingAudit";

// POST /api/payroll/reminders/mark-paid  (finances:full)
// { userId, payday, amount, method } → records the payment in the Payouts
// ledger: a PAID PAYROLL payout with payPeriodEnd = payday. If a PENDING
// payroll payout for that payday already exists it is completed instead of
// duplicated. Staff can never mark their own pay (B21 self rule).
const schema = z.object({
  userId: z.string().min(1),
  payday: z.string().refine(isValidYmd, "Invalid payday."),
  amount: z.number().positive("Enter the amount you paid.").max(1_000_000),
  method: z.enum(PAYOUT_METHODS),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  if (selfRule(session.user.role, session.user.id, data.userId, "edit_pay") === "deny") {
    return NextResponse.json({ error: SELF_DENY_MESSAGE.edit_pay }, { status: 403 });
  }
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  const clubId = session.user.clubId;

  const [user, schedule] = await Promise.all([
    prisma.user.findFirst({
      where: { id: data.userId, clubId, role: { in: ["OWNER", "STAFF"] }, deletedAt: null },
      select: { id: true, firstName: true, lastName: true },
    }),
    prisma.staffPaySchedule.findUnique({ where: { userId: data.userId } }),
  ]);
  if (!user) return NextResponse.json({ error: "Staff member not found." }, { status: 404 });
  if (!schedule || schedule.clubId !== clubId) {
    return NextResponse.json({ error: "This staff member has no pay schedule." }, { status: 400 });
  }
  const sch = { frequency: schedule.frequency, anchorDate: ymdFromDate(schedule.anchorDate) };
  if (paydaysInRange(sch, data.payday, data.payday).length !== 1) {
    return NextResponse.json({ error: "That date isn't a payday on their schedule." }, { status: 400 });
  }

  const payPeriodEnd = dateFromYmd(data.payday);
  const amount = Math.round(data.amount * 100) / 100;
  const existing = await prisma.payout.findMany({
    where: { clubId, payeeUserId: user.id, kind: "PAYROLL", payPeriodEnd, status: { not: "VOID" } },
    orderBy: { createdAt: "asc" },
  });
  if (existing.some((p) => p.status === "PAID")) {
    return NextResponse.json({ error: "This payday is already marked paid." }, { status: 409 });
  }

  // A pay period on/after the pay-ledger start date is paid from its saved pay
  // lines: the payout is exactly their total and the lines are locked to it.
  const ledgerStart = await getLedgerStart(clubId);
  if (ledgerStart && periodFor(sch, data.payday).start >= ledgerStart) {
    if (existing.length > 0) {
      return NextResponse.json({ error: "A payout for this payday is already pending. Mark it paid on the Payouts page." }, { status: 409 });
    }
    await syncPayLines(clubId, { userIds: [user.id] });
    const lines = await periodLines(clubId, user.id, data.payday);
    if (lines.ids.length === 0) {
      return NextResponse.json({
        error: lines.reviewCount > 0
          ? `${lines.reviewCount} pay line${lines.reviewCount === 1 ? "" : "s"} for this period need a decision first. Open Payroll to review them.`
          : "There are no unpaid pay lines for this period.",
        code: "NOTHING_TO_PAY",
      }, { status: 409 });
    }
    if (Math.abs(Math.round(amount * 100) - lines.amountCents) > 0) {
      return NextResponse.json({
        error: `The pay lines for this period total ${formatUsd(lines.amountCents / 100)}. To pay a different amount, add a bonus or adjustment on the Payroll page first.`,
        code: "AMOUNT_MISMATCH",
        expected: lines.amountCents / 100,
      }, { status: 409 });
    }
    try {
      const res = await createLedgerPayout({ clubId, userId: user.id, lineIds: lines.ids, paid: true, method: data.method, byUserId: session.user.id ?? null });
      await writeBillingAudit({
        clubId, actorUserId: session.user.id ?? null, action: "PAYROLL_PAYOUT_CREATED",
        after: { payoutId: res.payoutId, staffUserId: user.id, amount: res.amountCents / 100, lineIds: lines.ids, payday: data.payday, paid: true },
        note: `Paid ${lines.ids.length} pay line${lines.ids.length === 1 ? "" : "s"} for the period ending ${data.payday}.`,
      });
      await recordStaffActivity({
        clubId, staffUserId: user.id, ...actorFrom(session), kind: "PAY",
        summary: `Paid ${formatUsd(res.amountCents / 100)} for the period ending ${formatShortDate(data.payday)} (${lines.ids.length} pay line${lines.ids.length === 1 ? "" : "s"})`,
      });
      return NextResponse.json({ ok: true, payoutId: res.payoutId, updatedPending: false, needsReview: lines.reviewCount });
    } catch (err) {
      if (err instanceof PayLedgerError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
      throw err;
    }
  }

  const now = new Date();
  const pending = existing.find((p) => p.status === "PENDING");
  const payout = pending
    ? await prisma.payout.update({
        where: { id: pending.id },
        data: { status: "PAID", amount, method: data.method, paidAt: now },
      })
    : await prisma.payout.create({
        data: {
          clubId,
          payeeType: "STAFF",
          payeeUserId: user.id,
          payeeName: `${user.firstName} ${user.lastName}`.trim(),
          kind: "PAYROLL",
          amount,
          status: "PAID",
          method: data.method,
          paidAt: now,
          payPeriodEnd,
          createdById: session.user.id ?? null,
        },
      });

  await recordStaffActivity({
    clubId,
    staffUserId: user.id,
    ...actorFrom(session),
    kind: "PAY",
    summary: `Paid ${formatUsd(amount)} for the period ending ${formatShortDate(data.payday)}`,
  });

  return NextResponse.json({ ok: true, payoutId: payout.id, updatedPending: !!pending });
}
