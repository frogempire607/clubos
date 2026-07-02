import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermission } from "@/lib/apiGuard";
import { prisma } from "@/lib/prisma";
import {
  computeStaffPayout,
  type CompPlan,
  type CompContext,
  type TaughtSession,
  type BaseType,
  type BonusType,
  type ScopeType,
} from "@/lib/compensation";

// GET /api/staff/payroll?from=YYYY-MM-DD&to=YYYY-MM-DD
// Payroll preview driven by the modular compensation builder. Each staff
// member's pay = their StaffCompensation plan (base + stackable bonuses, scoped
// by assignment rules) evaluated against the period's classes/attendance/
// signups/revenue. Staff with no plan show zeros.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "view");
  if (denied) return denied;

  const url = new URL(req.url);
  const fromStr = url.searchParams.get("from");
  const toStr = url.searchParams.get("to");
  if (!fromStr || !toStr) {
    return NextResponse.json({ error: "from and to required" }, { status: 400 });
  }
  const from = new Date(fromStr);
  from.setHours(0, 0, 0, 0);
  const to = new Date(toStr);
  to.setHours(23, 59, 59, 999);
  const clubId = session.user.clubId;

  const [staff, classSessions, attendance, subscriptions, eventRegs, eventAssignments, privateBookings] =
    await Promise.all([
      prisma.user.findMany({
        where: { clubId, role: { in: ["OWNER", "STAFF"] }, deletedAt: null },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          role: true,
          staffProfile: { select: { title: true } },
          compensation: { include: { bonuses: true, assignments: true } },
        },
        orderBy: { firstName: "asc" },
      }),
      prisma.classSession.findMany({
        where: { clubId, canceled: false, startsAt: { gte: from, lte: to } },
        select: {
          id: true,
          startsAt: true,
          endsAt: true,
          recurringClass: { select: { id: true, name: true, assignedStaffIds: true, pricingOptions: true } },
        },
      }),
      prisma.attendanceRecord.findMany({
        where: { clubId, createdAt: { gte: from, lte: to } },
        select: {
          status: true,
          eventId: true,
          classSessionId: true,
          classSession: { select: { classId: true } },
        },
      }),
      prisma.memberSubscription.findMany({
        where: { member: { clubId }, createdAt: { gte: from, lte: to } },
        select: { membershipId: true, price: true },
      }),
      prisma.eventRegistration.findMany({
        where: { clubId, createdAt: { gte: from, lte: to } },
        select: { eventId: true, amountPaid: true, status: true },
      }),
      prisma.eventStaffAssignment.findMany({
        where: { clubId },
        select: { userId: true, eventId: true },
      }),
      prisma.privateBooking.findMany({
        where: { clubId, status: "COMPLETED", confirmedStartAt: { gte: from, lte: to } },
        select: { coachId: true, lessonTypeId: true, pricePaid: true },
      }),
    ]);

  function dropInPrice(pricingOptions: unknown): number {
    if (!Array.isArray(pricingOptions)) return 0;
    const opt = (pricingOptions as Array<{ type?: string; price?: number }>).find(
      (o) => o?.type === "dropin"
    );
    return opt?.price ? Number(opt.price) : 0;
  }

  // Pre-index a drop-in price per classId.
  const classDropIn = new Map<string, number>();
  for (const cs of classSessions) {
    if (!classDropIn.has(cs.recurringClass.id)) {
      classDropIn.set(cs.recurringClass.id, dropInPrice(cs.recurringClass.pricingOptions));
    }
  }

  const result = staff.map((s) => {
    const comp = s.compensation;

    const taughtSessions: TaughtSession[] = classSessions
      .filter((cs) => {
        const ids = Array.isArray(cs.recurringClass.assignedStaffIds)
          ? (cs.recurringClass.assignedStaffIds as string[])
          : [];
        return ids.includes(s.id);
      })
      .map((cs) => ({
        sessionId: cs.id,
        classId: cs.recurringClass.id,
        className: cs.recurringClass.name,
        date: cs.startsAt.toISOString(),
        minutes: Math.max(0, (cs.endsAt.getTime() - cs.startsAt.getTime()) / 60000),
        dropInPrice: classDropIn.get(cs.recurringClass.id) ?? 0,
      }));

    const ctx: CompContext = {
      taughtSessions,
      attendance: attendance.map((a) => ({
        classId: a.classSession?.classId ?? null,
        eventId: a.eventId,
        status: a.status,
      })),
      paidDropIns: attendance
        .filter((a) => a.status === "DROP_IN" && a.classSession?.classId)
        .map((a) => ({
          classId: a.classSession!.classId,
          price: classDropIn.get(a.classSession!.classId) ?? 0,
        })),
      subscriptions: subscriptions.map((x) => ({
        membershipId: x.membershipId,
        price: Number(x.price),
      })),
      eventRegistrations: eventRegs.map((r) => ({
        eventId: r.eventId,
        amountPaid: r.amountPaid ? Number(r.amountPaid) : 0,
        status: r.status,
      })),
      assignedEventIds: eventAssignments.filter((e) => e.userId === s.id).map((e) => e.eventId),
      privateBookings: privateBookings
        .filter((p) => p.coachId === s.id)
        .map((p) => ({ lessonTypeId: p.lessonTypeId, pricePaid: p.pricePaid ? Number(p.pricePaid) : 0 })),
    };

    let plan: CompPlan | null = null;
    if (comp) {
      plan = {
        baseType: comp.baseType as BaseType,
        baseAmount: Number(comp.baseAmount),
        baseScopeClassIds: comp.assignments
          .filter((a) => a.bonusId === null && a.scopeType === "CLASS")
          .map((a) => a.scopeId),
        bonuses: comp.bonuses.map((bo) => ({
          id: bo.id,
          bonusType: bo.bonusType as BonusType,
          amount: Number(bo.amount),
          minThreshold: bo.minThreshold,
          maxThreshold: bo.maxThreshold,
          scopes: comp.assignments
            .filter((a) => a.bonusId === bo.id)
            .map((a) => ({ scopeType: a.scopeType as ScopeType, scopeId: a.scopeId })),
        })),
      };
    }

    const payout = plan ? computeStaffPayout(plan, ctx) : null;

    return {
      id: s.id,
      firstName: s.firstName,
      lastName: s.lastName,
      email: s.email,
      role: s.role,
      title: s.staffProfile?.title ?? null,
      hasPlan: !!plan,
      payout,
    };
  });

  const totals = result.reduce(
    (acc, r) => {
      if (r.payout) {
        acc.base += r.payout.base.pay;
        acc.bonus += r.payout.bonuses.reduce((a, b) => a + b.pay, 0);
        acc.total += r.payout.total;
      }
      return acc;
    },
    { base: 0, bonus: 0, total: 0 }
  );

  return NextResponse.json({
    from: from.toISOString(),
    to: to.toISOString(),
    staff: result,
    totals: {
      base: +totals.base.toFixed(2),
      bonus: +totals.bonus.toFixed(2),
      total: +totals.total.toFixed(2),
    },
  });
}
