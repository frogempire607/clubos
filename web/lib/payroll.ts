import { prisma } from "@/lib/prisma";
import {
  computeStaffPayout,
  type BaseType,
  type BonusType,
  type CompContext,
  type CompPlan,
  type ScopeType,
  type TaughtSession,
} from "@/lib/compensation";

export async function computePayrollTotalForRange(
  clubId: string,
  from: Date | null,
  to: Date,
): Promise<number> {
  const rangeWhere = from ? { gte: from, lte: to } : { lte: to };
  const [staff, classSessions, attendance, subscriptions, eventRegs, eventAssignments, privateBookings] =
    await Promise.all([
      prisma.user.findMany({
        where: { clubId, role: { in: ["OWNER", "STAFF"] }, deletedAt: null },
        select: {
          id: true,
          compensation: { include: { bonuses: true, assignments: true } },
        },
      }),
      prisma.classSession.findMany({
        where: { clubId, canceled: false, startsAt: rangeWhere },
        select: {
          id: true,
          startsAt: true,
          endsAt: true,
          recurringClass: { select: { id: true, name: true, assignedStaffIds: true, pricingOptions: true } },
        },
      }),
      prisma.attendanceRecord.findMany({
        where: { clubId, createdAt: rangeWhere },
        select: {
          status: true,
          eventId: true,
          classSession: { select: { classId: true } },
        },
      }),
      prisma.memberSubscription.findMany({
        where: { member: { clubId }, createdAt: rangeWhere },
        select: { membershipId: true, price: true },
      }),
      prisma.eventRegistration.findMany({
        where: { clubId, createdAt: rangeWhere },
        select: { eventId: true, amountPaid: true, status: true },
      }),
      prisma.eventStaffAssignment.findMany({
        where: { clubId },
        select: { userId: true, eventId: true },
      }),
      prisma.privateBooking.findMany({
        where: { clubId, status: "COMPLETED", confirmedStartAt: rangeWhere },
        select: { coachId: true, lessonTypeId: true, pricePaid: true },
      }),
    ]);

  function dropInPrice(pricingOptions: unknown): number {
    if (!Array.isArray(pricingOptions)) return 0;
    const opt = (pricingOptions as Array<{ type?: string; price?: number }>).find(
      (o) => o?.type === "dropin",
    );
    return opt?.price ? Number(opt.price) : 0;
  }

  const classDropIn = new Map<string, number>();
  for (const cs of classSessions) {
    if (!classDropIn.has(cs.recurringClass.id)) {
      classDropIn.set(cs.recurringClass.id, dropInPrice(cs.recurringClass.pricingOptions));
    }
  }

  const total = staff.reduce((sum, s) => {
    const comp = s.compensation;
    if (!comp) return sum;

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

    const plan: CompPlan = {
      baseType: comp.baseType as BaseType,
      baseAmount: Number(comp.baseAmount),
      baseScopeClassIds: comp.assignments
        .filter((a) => a.bonusId === null && a.scopeType === "CLASS")
        .map((a) => a.scopeId),
      bonuses: comp.bonuses.map((bo) => ({
        id: bo.id,
        bonusType: bo.bonusType as BonusType,
        amount: Number(bo.amount),
        scopes: comp.assignments
          .filter((a) => a.bonusId === bo.id)
          .map((a) => ({ scopeType: a.scopeType as ScopeType, scopeId: a.scopeId })),
      })),
    };

    return sum + computeStaffPayout(plan, ctx).total;
  }, 0);

  return +total.toFixed(2);
}
