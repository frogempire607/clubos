// Payroll CALCULATOR — what each staff member's compensation plan works out to
// over a period. Shared by GET /api/staff/payroll (the "before the pay ledger"
// view on the Payroll page), the payday reminders for periods before the
// ledger, the report totals (lib/payroll.ts) and — for bonuses counted over a
// pay period — the pay ledger itself (lib/payLedgerServer.ts), so a number is
// worked out one way everywhere.
//
// Calculates only. What was actually paid lives in the Payouts ledger; what is
// owed on/after the club's ledger start date lives in pay lines.
import { prisma } from "@/lib/prisma";
import {
  computeStaffPayout,
  type CompPlan,
  type CompContext,
  type TaughtSession,
  type BaseType,
  type BonusType,
  type ScopeType,
  type PayoutBreakdown,
} from "@/lib/compensation";
import { loadSessionStaffResolver } from "@/lib/classStaffServer";

/**
 * The period bounds the Payroll page has always used: `from` at 00:00:00.000
 * and `to` at 23:59:59.999 (server clock) of the given YYYY-MM-DD days.
 */
export function payrollRange(fromStr: string, toStr: string): { from: Date; to: Date } {
  const from = new Date(fromStr);
  from.setHours(0, 0, 0, 0);
  const to = new Date(toStr);
  to.setHours(23, 59, 59, 999);
  return { from, to };
}

// ── The raw facts for a period ──────────────────────────────────────────────

function dropInPrice(pricingOptions: unknown): number {
  if (!Array.isArray(pricingOptions)) return 0;
  const opt = (pricingOptions as Array<{ type?: string; price?: number }>).find((o) => o?.type === "dropin");
  return opt?.price ? Number(opt.price) : 0;
}

export type PayrollInputs = Awaited<ReturnType<typeof loadPayrollInputs>>;

/**
 * Everything the calculator reads for one period, loaded once. `from` null =
 * no lower bound. `now` decides which class days have ended (only days on/after
 * the club's assignment start date ask).
 */
export async function loadPayrollInputs(clubId: string, from: Date | null, to: Date, now: Date = new Date()) {
  const rangeWhere = from ? { gte: from, lte: to } : { lte: to };
  const [fetchedClassSessions, attendance, subscriptions, eventRegs, eventAssignments, privateBookings] = await Promise.all([
    prisma.classSession.findMany({
      // Canceled days are fetched ONLY when marked "cancelled — paid"; whether a
      // day counts is decided per day below (staffOn.countsForPay).
      where: { clubId, OR: [{ canceled: false }, { cancelPaid: true }], startsAt: rangeWhere },
      select: {
        id: true,
        date: true,
        canceled: true,
        cancelPaid: true,
        startsAt: true,
        endsAt: true,
        // Per-day substitute: the person who actually coached is paid for it.
        staffOverride: true,
        recurringClass: { select: { id: true, name: true, assignedStaffIds: true, pricingOptions: true } },
      },
    }),
    prisma.attendanceRecord.findMany({
      where: { clubId, createdAt: rangeWhere },
      select: { status: true, eventId: true, classSessionId: true, classSession: { select: { classId: true } } },
    }),
    prisma.memberSubscription.findMany({
      where: { member: { clubId }, createdAt: rangeWhere },
      select: { membershipId: true, price: true },
    }),
    prisma.eventRegistration.findMany({
      where: { clubId, createdAt: rangeWhere },
      select: { eventId: true, amountPaid: true, status: true },
    }),
    prisma.eventStaffAssignment.findMany({ where: { clubId }, select: { userId: true, eventId: true } }),
    prisma.privateBooking.findMany({
      where: { clubId, status: "COMPLETED", confirmedStartAt: rangeWhere },
      select: { coachId: true, lessonTypeId: true, pricePaid: true },
    }),
  ]);

  // Who coached each class day, and whether the day counts for pay — the one
  // switch-aware seam (lib/classStaff.ts):
  //   days BEFORE the club's assignment start date (or a club not switched on)
  //     → exactly as before: not canceled, coaches = the day's override list or
  //       the series list. Numbers for those days do not change.
  //   days ON/AFTER it → the day's coach rows (status SCHEDULED — a substitute
  //       is paid as themself from their own plan; a replaced / called-out /
  //       no-show / removed coach is not), only once the class has ENDED, and
  //       a canceled day only when it was marked "cancelled — paid".
  const staffOn = await loadSessionStaffResolver(clubId, fetchedClassSessions);
  const classSessions = fetchedClassSessions
    .filter((cs) => staffOn.countsForPay(cs, now))
    .map((cs) => ({ ...cs, coachIds: staffOn.forSession(cs, cs.recurringClass.assignedStaffIds).staffIds }));

  // Every non-canceled day prices its class (as before), plus any day that counts.
  const classDropIn = new Map<string, number>();
  for (const cs of fetchedClassSessions) {
    if (cs.canceled && !staffOn.countsForPay(cs, now)) continue;
    if (!classDropIn.has(cs.recurringClass.id)) {
      classDropIn.set(cs.recurringClass.id, dropInPrice(cs.recurringClass.pricingOptions));
    }
  }
  return { classSessions, attendance, subscriptions, eventRegs, eventAssignments, privateBookings, classDropIn };
}

/** One staff member's slice of the period's facts. */
export function contextFor(inputs: PayrollInputs, userId: string): CompContext {
  const taughtSessions: TaughtSession[] = inputs.classSessions
    .filter((cs) => cs.coachIds.includes(userId))
    .map((cs) => ({
      sessionId: cs.id,
      classId: cs.recurringClass.id,
      className: cs.recurringClass.name,
      date: cs.startsAt.toISOString(),
      minutes: Math.max(0, (cs.endsAt.getTime() - cs.startsAt.getTime()) / 60000),
      dropInPrice: inputs.classDropIn.get(cs.recurringClass.id) ?? 0,
    }));
  return {
    taughtSessions,
    attendance: inputs.attendance.map((a) => ({
      classId: a.classSession?.classId ?? null,
      eventId: a.eventId,
      status: a.status,
    })),
    paidDropIns: inputs.attendance
      .filter((a) => a.status === "DROP_IN" && a.classSession?.classId)
      .map((a) => ({
        classId: a.classSession!.classId,
        price: inputs.classDropIn.get(a.classSession!.classId) ?? 0,
      })),
    subscriptions: inputs.subscriptions.map((x) => ({ membershipId: x.membershipId, price: Number(x.price) })),
    eventRegistrations: inputs.eventRegs.map((r) => ({
      eventId: r.eventId,
      amountPaid: r.amountPaid ? Number(r.amountPaid) : 0,
      status: r.status,
    })),
    assignedEventIds: inputs.eventAssignments.filter((e) => e.userId === userId).map((e) => e.eventId),
    privateBookings: inputs.privateBookings
      .filter((p) => p.coachId === userId)
      .map((p) => ({ lessonTypeId: p.lessonTypeId, pricePaid: p.pricePaid ? Number(p.pricePaid) : 0 })),
  };
}

// ── Stored plan → the engine's plan ─────────────────────────────────────────

export type StoredComp = {
  id: string;
  baseType: string;
  baseAmount: unknown;
  effectiveFrom?: Date | string | null;
  archivedAt?: Date | string | null;
  createdAt?: Date | string | null;
  bonuses: { id: string; bonusType: string; amount: unknown; minThreshold: number | null; maxThreshold: number | null; countPer?: string | null }[];
  assignments: { bonusId: string | null; scopeType: string; scopeId: string }[];
};

export function toCompPlan(comp: StoredComp): CompPlan {
  return {
    baseType: comp.baseType as BaseType,
    baseAmount: Number(comp.baseAmount),
    baseScopeClassIds: comp.assignments.filter((a) => a.bonusId === null && a.scopeType === "CLASS").map((a) => a.scopeId),
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

const ymdOf = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : null);

/**
 * The plans this period calculator uses. It is the calculation for work BEFORE
 * the pay ledger. Before the ledger a coach had exactly ONE plan, so once a
 * club has a ledger start date this is the coach's OLDEST plan that was
 * already in force before that date — a plan added for the ledger (or a second
 * plan added while setting it up) must not change what an old period worked
 * out to. A club with no ledger yet uses every plan that has not been archived.
 */
export function legacyPlans<T extends StoredComp>(comps: readonly T[] | null | undefined, ledgerStartYmd: string | null): T[] {
  const list = comps ?? [];
  if (!ledgerStartYmd) return list.filter((c) => !c.archivedAt);
  const stamp = (c: T) => (c.createdAt ? new Date(c.createdAt).getTime() : 0);
  const old = list
    .filter((c) => {
      const from = ymdOf(c.effectiveFrom);
      return from === null || from < ledgerStartYmd;
    })
    .sort((a, b) => stamp(a) - stamp(b) || a.id.localeCompare(b.id));
  return old.slice(0, 1);
}

/**
 * A plan as the OLD period calculator saw it: a bonus counted "each class day"
 * did not exist before the pay ledger (it is paid from pay lines), so it is
 * left out — otherwise a bonus set up for the ledger would inflate an old
 * period's number.
 */
export function toLegacyCompPlan(comp: StoredComp): CompPlan {
  return toCompPlan({ ...comp, bonuses: comp.bonuses.filter((b) => b.countPer !== "CLASS_DAY") });
}

/** Several plans' results as one breakdown (a coach with one plan gets exactly that plan's result). */
export function combinePayouts(parts: PayoutBreakdown[]): PayoutBreakdown | null {
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  const round = (n: number) => +n.toFixed(2);
  return {
    base: {
      type: parts[0].base.type,
      amount: parts[0].base.amount,
      detail: parts.map((p) => p.base.detail).join(" + "),
      pay: round(parts.reduce((a, p) => a + p.base.pay, 0)),
    },
    bonuses: parts.flatMap((p) => p.bonuses),
    classesCoached: Math.max(...parts.map((p) => p.classesCoached)),
    hoursCoached: Math.max(...parts.map((p) => p.hoursCoached)),
    attendanceTotal: parts.reduce((a, p) => a + p.attendanceTotal, 0),
    signupTotal: parts.reduce((a, p) => a + p.signupTotal, 0),
    total: round(parts.reduce((a, p) => a + p.total, 0)),
  };
}

async function ledgerStartYmd(clubId: string): Promise<string | null> {
  const s = await prisma.clubScheduleSettings.findUnique({ where: { clubId }, select: { payLedgerStartsOn: true } });
  return ymdOf(s?.payLedgerStartsOn);
}

export async function computePayroll(
  clubId: string,
  from: Date,
  to: Date,
  // `now` decides which class days have ended (only days on/after the club's
  // assignment start date ask). Callers leave it out; tests pin it.
  opts: { userIds?: string[]; now?: Date } = {},
) {
  const [staff, inputs, ledgerStart] = await Promise.all([
    prisma.user.findMany({
      where: {
        clubId,
        role: { in: ["OWNER", "STAFF"] },
        deletedAt: null,
        ...(opts.userIds ? { id: { in: opts.userIds } } : {}),
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        role: true,
        staffProfile: { select: { title: true } },
        compensations: { include: { bonuses: true, assignments: true } },
      },
      orderBy: { firstName: "asc" },
    }),
    loadPayrollInputs(clubId, from, to, opts.now ?? new Date()),
    ledgerStartYmd(clubId),
  ]);

  const result = staff.map((s) => {
    const plans = legacyPlans(s.compensations as unknown as StoredComp[], ledgerStart);
    const ctx = contextFor(inputs, s.id);
    const payout = combinePayouts(plans.map((c) => computeStaffPayout(toLegacyCompPlan(c), ctx)));
    return {
      id: s.id,
      firstName: s.firstName,
      lastName: s.lastName,
      email: s.email,
      role: s.role,
      title: s.staffProfile?.title ?? null,
      hasPlan: plans.length > 0,
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

  return {
    staff: result,
    totals: {
      base: +totals.base.toFixed(2),
      bonus: +totals.bonus.toFixed(2),
      total: +totals.total.toFixed(2),
    },
  };
}

export type PayrollResult = Awaited<ReturnType<typeof computePayroll>>;

/** The period calculator's total for everyone — the "before the ledger" number. */
export async function computeLegacyPayrollTotal(clubId: string, from: Date | null, to: Date, now: Date = new Date(), ledgerStart: string | null = null): Promise<number> {
  const [staff, inputs] = await Promise.all([
    prisma.user.findMany({
      where: { clubId, role: { in: ["OWNER", "STAFF"] }, deletedAt: null },
      select: { id: true, compensations: { include: { bonuses: true, assignments: true } } },
    }),
    loadPayrollInputs(clubId, from, to, now),
  ]);
  const total = staff.reduce((sum, s) => {
    const plans = legacyPlans(s.compensations as unknown as StoredComp[], ledgerStart);
    if (plans.length === 0) return sum;
    const ctx = contextFor(inputs, s.id);
    return sum + plans.reduce((a, c) => a + computeStaffPayout(toLegacyCompPlan(c), ctx).total, 0);
  }, 0);
  return +total.toFixed(2);
}
