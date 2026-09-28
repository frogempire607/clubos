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
  ymdFromDate,
} from "@/lib/paySchedule";

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
