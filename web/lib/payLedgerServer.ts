// The pay ledger — the database side (Branch 2). The rules are in
// lib/payLedger.ts (pure); this file loads the facts, applies the plan and
// owns every write to pay_lines, pay plans and ledger payouts.
//
// ── CONTRACT ────────────────────────────────────────────────────────────────
//   syncPayLines(clubId, opts?)        bring generated lines in line with what
//                                      happened. Idempotent; a no-op for a club
//                                      with no ledger start date. Never writes
//                                      a line dated before that date, never
//                                      touches a line that is paid, on a payout
//                                      or hand-made, and only reconsiders the
//                                      last SYNC_WINDOW_DAYS days.
//   syncPayLinesThrottled(clubId)      the same, at most once a minute per
//                                      server instance (for report totals).
//   loadLedger(clubId, range)          lines + totals per coach, for the screen.
//   ledgerTotal(clubId, from, to)      dollars of non-void lines in a range.
//   listPlans / createPlan / updatePlan / archivePlan / copyPlan
//   setLineOverride / setAssignmentOverride
//   addManualLine / editManualLine / voidManualLine
//   createLedgerPayout / settleLedgerPayout / releasePayoutLines
//
// Authorization is NOT done here — every caller is a route that has already
// checked finances:full (live) and the "never your own pay" rule.
import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { computeStaffPayout } from "@/lib/compensation";
import { contextFor, loadPayrollInputs, toCompPlan, type StoredComp } from "@/lib/payrollCalc";
import { classHasEnded, clubTodayYmd, roleLabel, toYmd, ymdToDate } from "@/lib/classStaff";
import { addDays, paydaysInRange, previousPayday, isPayFrequency, ymdFromDate } from "@/lib/paySchedule";
import {
  SYNC_WINDOW_DAYS,
  addDaysYmd,
  fmtCents,
  isAttendedStatus,
  isYmd,
  lineLocked,
  matchClassPlan,
  normalizePlanInput,
  planClassAmount,
  planPayLines,
  reconcileLines,
  summarizeLines,
  type DesiredLine,
  type ExistingLine,
  type LedgerBonus,
  type LedgerClassRow,
  type LedgerEventRow,
  type LedgerExportRow,
  type LedgerLineView,
  type LedgerPrivateRow,
  type LedgerPeriod,
  type LedgerPlan,
  type LedgerTotals,
  type PlanInput,
} from "@/lib/payLedger";

export class PayLedgerError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "PayLedgerError";
    this.code = code;
    this.status = status;
  }
}

const dateOrNull = (ymd: string | null) => (ymd ? ymdToDate(ymd) : null);
const ymdOrNull = (d: Date | null | undefined) => (d ? toYmd(d) : null);

// ── Settings ────────────────────────────────────────────────────────────────

export async function getLedgerStart(clubId: string): Promise<string | null> {
  const s = await prisma.clubScheduleSettings.findUnique({ where: { clubId }, select: { payLedgerStartsOn: true } });
  return ymdOrNull(s?.payLedgerStartsOn);
}

async function clubToday(clubId: string, now: Date): Promise<{ today: string; tz: string | null }> {
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { timezone: true } });
  const tz = club?.timezone ?? null;
  return { today: clubTodayYmd(tz, now), tz };
}

// ── Plans ───────────────────────────────────────────────────────────────────

const PLAN_INCLUDE = { bonuses: true, assignments: true } satisfies Prisma.StaffCompensationInclude;
type DbPlan = Prisma.StaffCompensationGetPayload<{ include: typeof PLAN_INCLUDE }>;

export function toLedgerPlan(p: DbPlan): LedgerPlan {
  return {
    id: p.id,
    userId: p.userId,
    name: p.name,
    baseType: p.baseType,
    baseAmount: Number(p.baseAmount),
    effectiveFrom: toYmd(p.effectiveFrom),
    effectiveTo: ymdOrNull(p.effectiveTo),
    archived: !!p.archivedAt,
    copiedFromId: p.copiedFromId ?? null,
    baseScopes: p.assignments.filter((a) => a.bonusId === null).map((a) => ({ scopeType: a.scopeType, scopeId: a.scopeId })),
    bonuses: [...p.bonuses]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .map((b): LedgerBonus => ({
        id: b.id,
        bonusType: b.bonusType,
        amount: Number(b.amount),
        minThreshold: b.minThreshold,
        maxThreshold: b.maxThreshold,
        countPer: b.countPer,
        scopes: p.assignments.filter((a) => a.bonusId === b.id).map((a) => ({ scopeType: a.scopeType, scopeId: a.scopeId })),
      })),
  };
}

async function loadDbPlans(clubId: string, userIds?: readonly string[]): Promise<DbPlan[]> {
  return prisma.staffCompensation.findMany({
    where: { clubId, ...(userIds ? { userId: { in: [...userIds] } } : {}) },
    include: PLAN_INCLUDE,
    orderBy: [{ createdAt: "asc" }],
  });
}

/** Every plan of the club (or of some coaches), any state, oldest first. */
export async function listPlans(clubId: string, userIds?: readonly string[]): Promise<LedgerPlan[]> {
  return (await loadDbPlans(clubId, userIds)).map(toLedgerPlan);
}

async function requireStaffUser(clubId: string, userId: string) {
  const u = await prisma.user.findFirst({
    where: { id: userId, clubId, role: { in: ["OWNER", "STAFF"] }, deletedAt: null },
    select: { id: true, firstName: true, lastName: true },
  });
  if (!u) throw new PayLedgerError("NOT_FOUND", "Staff member not found.", 404);
  return { id: u.id, name: `${u.firstName} ${u.lastName}`.trim() };
}

function checked(input: PlanInput): PlanInput {
  const { plan, error } = normalizePlanInput(input);
  if (error) throw new PayLedgerError("BAD_INPUT", error);
  return plan;
}

async function writeScopesAndBonuses(db: Prisma.TransactionClient, planId: string, plan: PlanInput, existingBonusIds: readonly string[]) {
  // Base scopes: replace (they carry no identity).
  await db.compensationAssignment.deleteMany({ where: { compensationId: planId, bonusId: null } });
  if (plan.baseScopes.length > 0) {
    await db.compensationAssignment.createMany({
      data: plan.baseScopes.map((s) => ({ compensationId: planId, bonusId: null, scopeType: s.scopeType, scopeId: s.scopeId })),
    });
  }
  // Bonuses: kept by id — a pay line remembers the bonus that produced it, so
  // an edited bonus must stay the same bonus (a new id would be paid again).
  const keep = new Set(plan.bonuses.map((b) => b.id).filter((id): id is string => !!id && existingBonusIds.includes(id)));
  const drop = existingBonusIds.filter((id) => !keep.has(id));
  if (drop.length > 0) await db.compensationBonus.deleteMany({ where: { id: { in: drop }, compensationId: planId } });
  for (const b of plan.bonuses) {
    const data = { bonusType: b.bonusType, amount: b.amount, minThreshold: b.minThreshold, maxThreshold: b.maxThreshold, countPer: b.countPer };
    let bonusId: string;
    if (b.id && keep.has(b.id)) {
      await db.compensationBonus.updateMany({ where: { id: b.id, compensationId: planId }, data });
      await db.compensationAssignment.deleteMany({ where: { compensationId: planId, bonusId: b.id } });
      bonusId = b.id;
    } else {
      const made = await db.compensationBonus.create({ data: { compensationId: planId, ...data }, select: { id: true } });
      bonusId = made.id;
    }
    if (b.scopes.length > 0) {
      await db.compensationAssignment.createMany({
        data: b.scopes.map((s) => ({ compensationId: planId, bonusId, scopeType: s.scopeType, scopeId: s.scopeId })),
      });
    }
  }
}

async function readPlan(clubId: string, planId: string): Promise<DbPlan> {
  const p = await prisma.staffCompensation.findFirst({ where: { id: planId, clubId }, include: PLAN_INCLUDE });
  if (!p) throw new PayLedgerError("NOT_FOUND", "Pay plan not found.", 404);
  return p;
}

export async function getPlan(clubId: string, planId: string): Promise<LedgerPlan> {
  return toLedgerPlan(await readPlan(clubId, planId));
}

export async function createPlan(args: { clubId: string; userId: string; input: PlanInput; byUserId: string | null; copiedFromId?: string | null }): Promise<LedgerPlan> {
  await requireStaffUser(args.clubId, args.userId);
  const plan = checked(args.input);
  const id = await prisma.$transaction(async (tx) => {
    const made = await tx.staffCompensation.create({
      data: {
        clubId: args.clubId, userId: args.userId, name: plan.name, baseType: plan.baseType, baseAmount: plan.baseAmount,
        effectiveFrom: ymdToDate(plan.effectiveFrom), effectiveTo: dateOrNull(plan.effectiveTo),
        copiedFromId: args.copiedFromId ?? null, createdByUserId: args.byUserId,
      },
      select: { id: true },
    });
    await writeScopesAndBonuses(tx, made.id, { ...plan, bonuses: plan.bonuses.map((b) => ({ ...b, id: null })) }, []);
    return made.id;
  });
  return getPlan(args.clubId, id);
}

/** Edit a plan IN PLACE (same id, bonuses kept by id). Unpaid lines it priced are re-priced on the next sync; paid lines never change. */
export async function updatePlan(args: { clubId: string; planId: string; input: PlanInput }): Promise<{ before: LedgerPlan; after: LedgerPlan }> {
  const cur = await readPlan(args.clubId, args.planId);
  if (cur.archivedAt) throw new PayLedgerError("ARCHIVED", "This pay plan was removed and can't be changed.", 409);
  const plan = checked(args.input);
  await prisma.$transaction(async (tx) => {
    await tx.staffCompensation.update({
      where: { id: cur.id },
      data: {
        name: plan.name, baseType: plan.baseType, baseAmount: plan.baseAmount,
        effectiveFrom: ymdToDate(plan.effectiveFrom), effectiveTo: dateOrNull(plan.effectiveTo),
      },
    });
    await writeScopesAndBonuses(tx, cur.id, plan, cur.bonuses.map((b) => b.id));
  });
  return { before: toLedgerPlan(cur), after: await getPlan(args.clubId, cur.id) };
}

/** Remove a plan from use. The row stays (pay lines keep its name and id); it stops pricing anything unpaid. */
export async function archivePlan(args: { clubId: string; planId: string }): Promise<LedgerPlan> {
  const cur = await readPlan(args.clubId, args.planId);
  if (!cur.archivedAt) await prisma.staffCompensation.update({ where: { id: cur.id }, data: { archivedAt: new Date() } });
  return getPlan(args.clubId, cur.id);
}

/**
 * Copy ONE plan to other coaches (or to the same coach, as a new version).
 * Each copy is its own plan — same base, scopes and bonuses, new ids —
 * and editing either one never changes the other.
 */
export async function copyPlan(args: {
  clubId: string; planId: string; toUserIds: readonly string[]; name?: string | null; effectiveFrom: string; byUserId: string | null;
}): Promise<{ source: LedgerPlan; copies: LedgerPlan[] }> {
  const source = toLedgerPlan(await readPlan(args.clubId, args.planId));
  if (!isYmd(args.effectiveFrom)) throw new PayLedgerError("BAD_INPUT", "Choose the date the copy starts.");
  const targets = Array.from(new Set(args.toUserIds));
  if (targets.length === 0) throw new PayLedgerError("BAD_INPUT", "Choose who gets the copy.");
  // Everyone must be current staff of this club BEFORE anything is created.
  for (const userId of targets) await requireStaffUser(args.clubId, userId);
  const copies: LedgerPlan[] = [];
  for (const userId of targets) {
    copies.push(await createPlan({
      clubId: args.clubId, userId, byUserId: args.byUserId, copiedFromId: source.id,
      input: {
        name: (args.name ?? "").trim() || source.name,
        baseType: source.baseType as PlanInput["baseType"],
        baseAmount: source.baseAmount,
        effectiveFrom: args.effectiveFrom,
        effectiveTo: null,
        baseScopes: source.baseScopes,
        bonuses: source.bonuses.map((b) => ({
          id: null, bonusType: b.bonusType as PlanInput["bonuses"][number]["bonusType"], amount: b.amount,
          minThreshold: b.minThreshold, maxThreshold: b.maxThreshold,
          countPer: b.countPer as PlanInput["bonuses"][number]["countPer"], scopes: b.scopes,
        })),
      },
    }));
  }
  return { source, copies };
}

// ── Pay periods ─────────────────────────────────────────────────────────────

type Sched = { frequency: string; anchorDate: string };

async function loadSchedules(clubId: string): Promise<Map<string, Sched>> {
  const rows = await prisma.staffPaySchedule.findMany({ where: { clubId }, select: { userId: true, frequency: true, anchorDate: true, active: true } });
  const out = new Map<string, Sched>();
  for (const r of rows) {
    if (!r.active || !isPayFrequency(r.frequency)) continue;
    out.set(r.userId, { frequency: r.frequency, anchorDate: ymdFromDate(r.anchorDate) });
  }
  return out;
}

/** The pay period a work day belongs to on this schedule (null before the schedule's first period). */
export function periodOfDay(s: Sched, workDate: string): { periodStart: string; periodEnd: string } | null {
  const payday = paydaysInRange(s, workDate, addDays(workDate, 32))[0];
  if (!payday) return null;
  const periodStart = addDays(previousPayday(s, payday), 1);
  return workDate >= periodStart ? { periodStart, periodEnd: payday } : null;
}

/** Pay periods that have started, from `fromYmd`, through the one `today` is in. */
export function startedPeriods(s: Sched, fromYmd: string, today: string): { periodStart: string; periodEnd: string }[] {
  const out: { periodStart: string; periodEnd: string }[] = [];
  for (const payday of paydaysInRange(s, fromYmd, addDays(today, 32))) {
    const periodStart = addDays(previousPayday(s, payday), 1);
    if (periodStart > today) break;
    out.push({ periodStart, periodEnd: payday });
  }
  return out;
}

// ── Sync ────────────────────────────────────────────────────────────────────

const LINE_SELECT = {
  id: true, userId: true, sourceType: true, sourceId: true, component: true, workDate: true, description: true,
  units: true, rateCents: true, amountCents: true, rateSource: true, planId: true, planName: true,
  planAmountCents: true, overrideReason: true, overrideByUserId: true, overrideAt: true, status: true,
  reviewReason: true, voidReason: true, payoutId: true, periodStart: true, periodEnd: true,
} satisfies Prisma.PayLineSelect;
type DbLine = Prisma.PayLineGetPayload<{ select: typeof LINE_SELECT }>;

function toExisting(l: DbLine): ExistingLine {
  return {
    ...l, units: Number(l.units), workDate: toYmd(l.workDate),
    periodStart: ymdOrNull(l.periodStart), periodEnd: ymdOrNull(l.periodEnd),
  };
}

function lineData(d: Partial<DesiredLine>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...d };
  if (d.workDate !== undefined) out.workDate = ymdToDate(d.workDate);
  if (d.periodStart !== undefined) out.periodStart = dateOrNull(d.periodStart);
  if (d.periodEnd !== undefined) out.periodEnd = dateOrNull(d.periodEnd);
  return out;
}

export type SyncResult = { on: boolean; ledgerStart: string | null; from: string | null; created: number; updated: number; voided: number };

/**
 * Bring the club's generated pay lines in line with what happened.
 * `userIds` limits the work to some coaches (used after an override).
 */
export async function syncPayLines(clubId: string, opts: { now?: Date; userIds?: readonly string[] } = {}): Promise<SyncResult> {
  const now = opts.now ?? new Date();
  const ledgerStart = await getLedgerStart(clubId);
  if (!ledgerStart) return { on: false, ledgerStart: null, from: null, created: 0, updated: 0, voided: 0 };
  const { today, tz } = await clubToday(clubId, now);
  if (today < ledgerStart) return { on: true, ledgerStart, from: null, created: 0, updated: 0, voided: 0 };
  const windowStart = addDaysYmd(today, -SYNC_WINDOW_DAYS);
  const from = windowStart > ledgerStart ? windowStart : ledgerStart;
  const userFilter = opts.userIds ? { userId: { in: [...opts.userIds] } } : {};

  const [dbPlans, schedules, staffRows, existingRows] = await Promise.all([
    loadDbPlans(clubId, opts.userIds),
    loadSchedules(clubId),
    prisma.classSessionStaff.findMany({
      where: { clubId, ...userFilter, session: { date: { gte: ymdToDate(from), lte: ymdToDate(today) } } },
      select: {
        id: true, userId: true, roleName: true, kind: true, status: true, sessionId: true,
        payOverrideCents: true, payOverrideReason: true, payOverrideByUserId: true, payOverrideAt: true,
        session: {
          select: {
            id: true, classId: true, date: true, startsAt: true, endsAt: true, canceled: true, cancelPaid: true,
            recurringClass: { select: { name: true } },
          },
        },
      },
    }),
    prisma.payLine.findMany({ where: { clubId, ...userFilter, workDate: { gte: ymdToDate(from) } }, select: LINE_SELECT }),
  ]);
  const plans = dbPlans.map(toLedgerPlan);

  // Attendance per class day — only needed for bonuses counted per class day.
  const attended = new Map<string, number>();
  if (plans.some((p) => !p.archived && p.bonuses.some((b) => b.bonusType === "ATTENDANCE" && b.countPer === "CLASS_DAY"))) {
    const sessionIds = Array.from(new Set(staffRows.map((r) => r.sessionId)));
    if (sessionIds.length > 0) {
      const att = await prisma.attendanceRecord.findMany({ where: { clubId, classSessionId: { in: sessionIds } }, select: { classSessionId: true, status: true } });
      for (const a of att) {
        if (!a.classSessionId || !isAttendedStatus(a.status)) continue;
        attended.set(a.classSessionId, (attended.get(a.classSessionId) ?? 0) + 1);
      }
    }
  }

  // An OWNER with no pay plan at all is not on the ledger: owners are not paid
  // per class unless they give themselves a plan, and a "needs review" line for
  // every class the owner coaches would bury the lines that do need a decision.
  // (Everyone else with no plan IS flagged — rule 2.)
  const planned = new Set(plans.filter((p) => !p.archived).map((p) => p.userId));
  const unplanned = Array.from(new Set(staffRows.map((r) => r.userId))).filter((id) => !planned.has(id));
  const ownersOff = new Set(
    unplanned.length
      ? (await prisma.user.findMany({ where: { clubId, id: { in: unplanned }, role: "OWNER" }, select: { id: true } })).map((u) => u.id)
      : [],
  );

  const classRows: LedgerClassRow[] = staffRows.filter((r) => !ownersOff.has(r.userId) || r.payOverrideCents !== null).map((r) => ({
    rowId: r.id, userId: r.userId, classId: r.session.classId, className: r.session.recurringClass.name,
    dateYmd: toYmd(r.session.date),
    minutes: Math.max(0, (r.session.endsAt.getTime() - r.session.startsAt.getTime()) / 60000),
    roleName: r.roleName, kind: r.kind, status: r.status,
    ended: classHasEnded(r.session.endsAt, tz, now),
    canceled: r.session.canceled, cancelPaid: !!r.session.cancelPaid,
    payOverrideCents: r.payOverrideCents, payOverrideReason: r.payOverrideReason,
    payOverrideByUserId: r.payOverrideByUserId, payOverrideAt: r.payOverrideAt,
    attended: attended.get(r.sessionId) ?? 0,
  }));

  // Events — only for coaches who hold a per-event plan.
  const eventUserIds = Array.from(new Set(plans.filter((p) => !p.archived && p.baseType === "PER_EVENT").map((p) => p.userId)));
  let eventRows: LedgerEventRow[] = [];
  if (eventUserIds.length > 0) {
    const assigns = await prisma.eventStaffAssignment.findMany({
      where: { clubId, userId: { in: eventUserIds }, event: { deletedAt: null, endsAt: { gte: ymdToDate(from), lte: now } } },
      select: { id: true, userId: true, eventId: true, event: { select: { name: true, type: true, endsAt: true } } },
    });
    const comps = assigns.length
      ? await prisma.eventCompAssignment.findMany({
          where: { clubId, eventId: { in: Array.from(new Set(assigns.map((a) => a.eventId))) }, userId: { in: eventUserIds }, compMethod: { not: "NONE" } },
          select: { eventId: true, userId: true },
        })
      : [];
    const hasComp = new Set(comps.map((c) => `${c.eventId}|${c.userId}`));
    eventRows = assigns.map((a) => ({
      assignmentId: a.id, userId: a.userId, eventId: a.eventId, eventName: a.event.name, eventType: String(a.event.type),
      dateYmd: clubTodayYmd(tz, a.event.endsAt), ended: a.event.endsAt.getTime() <= now.getTime(),
      hasEventComp: hasComp.has(`${a.eventId}|${a.userId}`),
    }));
  }

  // Private lessons that have ended, with the coach's rate for that lesson type.
  const lessons = await prisma.privateBooking.findMany({
    where: {
      clubId, coachId: opts.userIds ? { in: [...opts.userIds] } : { not: null },
      status: { in: ["CONFIRMED", "COMPLETED"] }, confirmedEndAt: { gte: ymdToDate(from), lte: now },
    },
    select: {
      id: true, coachId: true, status: true, confirmedEndAt: true, pricePaid: true, lessonTypeId: true,
      lessonType: { select: { title: true } }, member: { select: { firstName: true, lastName: true } },
    },
  });
  let privateRows: LedgerPrivateRow[] = [];
  if (lessons.length > 0) {
    const coachIds = Array.from(new Set(lessons.map((l) => l.coachId).filter((x): x is string => !!x)));
    const [rates, ownerRows] = await Promise.all([
      prisma.privateLessonPayRate.findMany({ where: { clubId, userId: { in: coachIds } }, select: { userId: true, lessonTypeId: true, payType: true, payValue: true } }),
      prisma.user.findMany({ where: { clubId, id: { in: coachIds }, role: "OWNER" }, select: { id: true } }),
    ]);
    const rateOf = new Map(rates.map((r) => [`${r.userId}|${r.lessonTypeId}`, { payType: r.payType, payValue: Number(r.payValue) }]));
    const rated = new Set(rates.map((r) => r.userId));
    const owners = new Set(ownerRows.map((u) => u.id));
    privateRows = lessons
      // Same rule as classes: an owner with no pay setup at all is not on the ledger.
      .filter((l) => l.coachId && l.confirmedEndAt && !(owners.has(l.coachId) && !planned.has(l.coachId) && !rated.has(l.coachId)))
      .map((l) => ({
        bookingId: l.id, userId: l.coachId!, lessonTitle: l.lessonType.title,
        athleteName: `${l.member.firstName} ${l.member.lastName}`.trim(),
        dateYmd: clubTodayYmd(tz, l.confirmedEndAt!), ended: l.confirmedEndAt!.getTime() <= now.getTime(), status: l.status,
        pricePaidCents: l.pricePaid === null ? null : Math.round(Number(l.pricePaid) * 100),
        rate: rateOf.get(`${l.coachId}|${l.lessonTypeId}`) ?? null,
      }));
  }

  // Pay periods that have started, per coach with a pay schedule.
  const planUserIds = new Set(plans.map((p) => p.userId));
  const periods: LedgerPeriod[] = [];
  for (const [userId, s] of schedules) {
    if (opts.userIds && !opts.userIds.includes(userId)) continue;
    if (!planUserIds.has(userId)) continue;
    for (const p of startedPeriods(s, ledgerStart, today)) {
      if (p.periodStart < ledgerStart || p.periodEnd < from) continue;
      periods.push({ userId, ...p });
    }
  }

  // Bonuses counted over a pay period: the shared calculator, once per period.
  const bonusPay = new Map<string, { pay: number; basisLabel: string }>();
  const dbPlanById = new Map(dbPlans.map((p) => [p.id, p]));
  const byPeriod = new Map<string, LedgerPeriod[]>();
  for (const per of periods) {
    const has = plans.some((p) => p.userId === per.userId && !p.archived && p.bonuses.some((b) => !(b.bonusType === "ATTENDANCE" && b.countPer === "CLASS_DAY")));
    if (!has) continue;
    const k = `${per.periodStart}|${per.periodEnd}`;
    const list = byPeriod.get(k);
    if (list) list.push(per);
    else byPeriod.set(k, [per]);
  }
  for (const list of byPeriod.values()) {
    const { periodStart, periodEnd } = list[0];
    const inputs = await loadPayrollInputs(clubId, new Date(`${periodStart}T00:00:00.000Z`), new Date(`${periodEnd}T23:59:59.999Z`), now);
    for (const per of list) {
      const ctx = contextFor(inputs, per.userId);
      for (const p of plans) {
        if (p.userId !== per.userId || p.archived || p.bonuses.length === 0) continue;
        const db = dbPlanById.get(p.id);
        if (!db) continue;
        const res = computeStaffPayout(toCompPlan(db as unknown as StoredComp), ctx);
        for (const b of res.bonuses) bonusPay.set(`${p.id}|${b.id}|${periodEnd}`, { pay: b.pay, basisLabel: b.basisLabel });
      }
    }
  }

  const { desired, unpaidReasons } = planPayLines({
    fromYmd: from, ledgerStart, plans, classRows, eventRows, privateRows, periods,
    periodOf: (userId, workDate) => {
      const s = schedules.get(userId);
      return s ? periodOfDay(s, workDate) : null;
    },
    periodBonusPay: (planId, bonusId, periodEnd) => bonusPay.get(`${planId}|${bonusId}|${periodEnd}`) ?? null,
  });
  const plan = reconcileLines(desired, existingRows.map(toExisting), unpaidReasons);

  if (plan.create.length > 0) {
    await prisma.payLine.createMany({
      data: plan.create.map((d) => ({ clubId, ...(lineData(d) as Omit<Prisma.PayLineCreateManyInput, "clubId">) })),
      skipDuplicates: true,
    });
  }
  // A line that was attached to a payout while this ran is left alone.
  const open = { payoutId: null, status: { not: "PAID" } } as const;
  for (const u of plan.update) {
    const data = lineData(u.data);
    if (u.data.status !== undefined || u.data.voidReason === null) Object.assign(data, { voidReason: null, voidedAt: null, voidedByUserId: null });
    await prisma.payLine.updateMany({ where: { id: u.id, ...open }, data });
  }
  for (const v of plan.voids) {
    await prisma.payLine.updateMany({ where: { id: v.id, ...open }, data: { status: "VOID", voidReason: v.reason, voidedAt: now, voidedByUserId: null } });
  }
  return { on: true, ledgerStart, from, created: plan.create.length, updated: plan.update.length, voided: plan.voids.length };
}

const lastSync = new Map<string, number>();
export const SYNC_THROTTLE_MS = 60_000;

/** syncPayLines, at most once a minute per club on this server instance. Failures are logged, never thrown. */
export async function syncPayLinesThrottled(clubId: string, now: Date = new Date()): Promise<void> {
  const last = lastSync.get(clubId) ?? 0;
  if (now.getTime() - last < SYNC_THROTTLE_MS) return;
  lastSync.set(clubId, now.getTime());
  try {
    await syncPayLines(clubId, { now });
  } catch (err) {
    lastSync.delete(clubId);
    console.error("[payLedger] sync failed", err);
  }
}

/** Dollars of pay lines (unpaid, on a payout, or paid — never void or unresolved) with a work day in [fromYmd, toYmd]. */
export async function ledgerTotal(clubId: string, fromYmd: string, toYmdStr: string): Promise<number> {
  if (toYmdStr < fromYmd) return 0;
  const rows = await prisma.payLine.findMany({
    where: { clubId, status: { in: ["ESTIMATED", "PAID"] }, workDate: { gte: ymdToDate(fromYmd), lte: ymdToDate(toYmdStr) } },
    select: { amountCents: true },
  });
  return rows.reduce((a, r) => a + (r.amountCents ?? 0), 0) / 100;
}

// ── Reading ─────────────────────────────────────────────────────────────────

export type LedgerCoach = {
  userId: string;
  name: string;
  removed: boolean;
  hasSchedule: boolean;
  lines: LedgerLineView[];
  totals: LedgerTotals;
};

/** Lines with a work day in [fromYmd, toYmd] (voided ones included), grouped per coach. */
export async function loadLedger(clubId: string, args: { fromYmd: string; toYmd: string; userId?: string | null }): Promise<LedgerCoach[]> {
  const lines = await prisma.payLine.findMany({
    where: {
      clubId, ...(args.userId ? { userId: args.userId } : {}),
      workDate: { gte: ymdToDate(args.fromYmd), lte: ymdToDate(args.toYmd) },
    },
    select: LINE_SELECT,
    orderBy: [{ workDate: "asc" }, { createdAt: "asc" }],
  });
  const userIds = Array.from(new Set(lines.map((l) => l.userId)));
  const overriders = Array.from(new Set(lines.map((l) => l.overrideByUserId).filter((x): x is string => !!x)));
  const payoutIds = Array.from(new Set(lines.map((l) => l.payoutId).filter((x): x is string => !!x)));
  const subRowIds = lines.filter((l) => l.sourceType === "CLASS_SESSION" && l.component === "BASE").map((l) => l.sourceId);
  const [users, payouts, schedules, subRows] = await Promise.all([
    prisma.user.findMany({
      where: { clubId, id: { in: Array.from(new Set([...userIds, ...overriders])) } },
      select: { id: true, firstName: true, lastName: true, deletedAt: true },
    }),
    payoutIds.length ? prisma.payout.findMany({ where: { clubId, id: { in: payoutIds } }, select: { id: true, status: true } }) : Promise.resolve([]),
    loadSchedules(clubId),
    subRowIds.length
      ? prisma.classSessionStaff.findMany({
          where: { clubId, id: { in: subRowIds }, kind: "SUBSTITUTE", replacesStaffId: { not: null } },
          select: { id: true, replacesStaffId: true, session: { select: { classId: true, date: true, startsAt: true, endsAt: true } } },
        })
      : Promise.resolve([]),
  ]);
  const nameOf = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));
  const removed = new Set(users.filter((u) => u.deletedAt).map((u) => u.id));
  const payoutStatus = new Map(payouts.map((p) => [p.id, p.status]));

  // "Match the regular coach": what the covered coach's own plan would have paid that day.
  const match = new Map<string, { name: string; cents: number }>();
  if (subRows.length > 0) {
    const covered = await prisma.classSessionStaff.findMany({
      where: { clubId, id: { in: subRows.map((r) => r.replacesStaffId!).filter(Boolean) } },
      select: { id: true, userId: true, roleName: true },
    });
    const coveredById = new Map(covered.map((c) => [c.id, c]));
    const coveredUsers = Array.from(new Set(covered.map((c) => c.userId)));
    const [plans, names] = await Promise.all([
      listPlans(clubId, coveredUsers),
      prisma.user.findMany({ where: { clubId, id: { in: coveredUsers } }, select: { id: true, firstName: true } }),
    ]);
    const first = new Map(names.map((n) => [n.id, n.firstName]));
    for (const r of subRows) {
      const c = coveredById.get(r.replacesStaffId!);
      if (!c) continue;
      const m = matchClassPlan(plans.filter((p) => p.userId === c.userId), { dateYmd: toYmd(r.session.date), classId: r.session.classId, roleName: c.roleName });
      if (m.kind !== "plan") continue;
      const minutes = Math.max(0, (r.session.endsAt.getTime() - r.session.startsAt.getTime()) / 60000);
      match.set(r.id, { name: first.get(c.userId) ?? "the regular coach", cents: planClassAmount(m.plan, minutes).amountCents });
    }
  }

  const byUser = new Map<string, LedgerLineView[]>();
  for (const l of lines) {
    const view: LedgerLineView = {
      id: l.id, userId: l.userId, sourceType: l.sourceType, sourceId: l.sourceId, component: l.component,
      workDate: toYmd(l.workDate), description: l.description, units: Number(l.units), rateCents: l.rateCents,
      amountCents: l.amountCents, rateSource: l.rateSource, planId: l.planId, planName: l.planName,
      planAmountCents: l.planAmountCents, overrideReason: l.overrideReason,
      overrideByName: l.overrideByUserId ? nameOf.get(l.overrideByUserId) ?? null : null,
      status: l.status, reviewReason: l.reviewReason, voidReason: l.voidReason, payoutId: l.payoutId,
      payoutStatus: l.payoutId ? payoutStatus.get(l.payoutId) ?? null : null,
      periodStart: ymdOrNull(l.periodStart), periodEnd: ymdOrNull(l.periodEnd),
      matchRegular: l.sourceType === "CLASS_SESSION" && l.component === "BASE" ? match.get(l.sourceId) ?? null : null,
    };
    const list = byUser.get(l.userId);
    if (list) list.push(view);
    else byUser.set(l.userId, [view]);
  }
  return Array.from(byUser.entries())
    .map(([userId, ls]) => ({
      userId, name: nameOf.get(userId) ?? "Former staff member", removed: removed.has(userId),
      hasSchedule: schedules.has(userId), lines: ls, totals: summarizeLines(ls),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Every pay line with a work day in [fromYmd, toYmd], flattened for the CSV export (voided lines left out). */
export async function loadLedgerExport(clubId: string, args: { fromYmd: string; toYmd: string; userId?: string | null }): Promise<LedgerExportRow[]> {
  const lines = await prisma.payLine.findMany({
    where: {
      clubId, status: { not: "VOID" }, ...(args.userId ? { userId: args.userId } : {}),
      workDate: { gte: ymdToDate(args.fromYmd), lte: ymdToDate(args.toYmd) },
    },
    select: LINE_SELECT,
    orderBy: [{ workDate: "asc" }, { createdAt: "asc" }],
  });
  if (lines.length === 0) return [];
  const rowIds = lines.filter((l) => l.sourceType === "CLASS_SESSION").map((l) => l.sourceId);
  const payoutIds = Array.from(new Set(lines.map((l) => l.payoutId).filter((x): x is string => !!x)));
  const [users, rows, payouts] = await Promise.all([
    prisma.user.findMany({ where: { clubId, id: { in: Array.from(new Set(lines.map((l) => l.userId))) } }, select: { id: true, firstName: true, lastName: true } }),
    rowIds.length ? prisma.classSessionStaff.findMany({ where: { clubId, id: { in: rowIds } }, select: { id: true, roleName: true, kind: true } }) : Promise.resolve([]),
    payoutIds.length ? prisma.payout.findMany({ where: { clubId, id: { in: payoutIds } }, select: { id: true, status: true, paidAt: true, method: true } }) : Promise.resolve([]),
  ]);
  const nameOf = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));
  const roleOf = new Map(rows.map((r) => [r.id, `${roleLabel(r.roleName)}${r.kind === "SUBSTITUTE" && (r.roleName ?? "").toLowerCase() !== "substitute" ? " (substitute)" : ""}`]));
  const payoutOf = new Map(payouts.map((p) => [p.id, p]));
  return lines
    .map((l) => {
      const p = l.payoutId ? payoutOf.get(l.payoutId) : undefined;
      return {
        coach: nameOf.get(l.userId) ?? "Former staff member",
        workDate: toYmd(l.workDate),
        sourceType: l.sourceType,
        description: l.description,
        role: l.sourceType === "CLASS_SESSION" ? roleOf.get(l.sourceId) ?? null : null,
        planName: l.planName,
        rateCents: l.rateCents,
        units: Number(l.units),
        planAmountCents: l.planAmountCents,
        amountCents: l.amountCents,
        rateSource: l.rateSource,
        reason: l.rateSource === "OVERRIDE" ? l.overrideReason : l.status === "NEEDS_REVIEW" ? l.reviewReason : null,
        status: l.status,
        payoutId: l.payoutId,
        payoutStatus: p?.status ?? null,
        payoutDate: p?.paidAt ? p.paidAt.toISOString().slice(0, 10) : null,
        payoutMethod: p?.method ?? null,
        periodStart: ymdOrNull(l.periodStart),
        periodEnd: ymdOrNull(l.periodEnd),
        lineId: l.id,
      };
    })
    .sort((a, b) => a.coach.localeCompare(b.coach) || a.workDate.localeCompare(b.workDate));
}

// ── Overrides ───────────────────────────────────────────────────────────────

const MAX_CENTS = 100_000_000;

async function readLine(clubId: string, lineId: string) {
  const l = await prisma.payLine.findFirst({ where: { id: lineId, clubId }, select: LINE_SELECT });
  if (!l) throw new PayLedgerError("NOT_FOUND", "Pay line not found.", 404);
  return l;
}

function requireOpen(l: Pick<DbLine, "status" | "payoutId">) {
  if (lineLocked(l)) {
    throw new PayLedgerError("LOCKED", l.status === "PAID" ? "This line has been paid and can't be changed." : "This line is on a payout. Void the payout to change it.", 409);
  }
}

/**
 * Set (cents) or clear (null) the pay for ONE class day for ONE coach. Lives on
 * the assignment, so it can be set before the class happens; no plan is
 * changed. A reason is required to set one.
 */
export async function setAssignmentOverride(args: {
  clubId: string; staffRowId: string; cents: number | null; reason?: string | null; byUserId: string | null; now?: Date;
}): Promise<{ userId: string; before: number | null; after: number | null; className: string; dateYmd: string }> {
  const row = await prisma.classSessionStaff.findFirst({
    where: { id: args.staffRowId, clubId: args.clubId },
    select: { id: true, userId: true, payOverrideCents: true, session: { select: { date: true, recurringClass: { select: { name: true } } } } },
  });
  if (!row) throw new PayLedgerError("NOT_FOUND", "That class assignment was not found.", 404);
  // Only class days the ledger pays: before its start date an override would change nothing.
  const start = await getLedgerStart(args.clubId);
  if (!start) throw new PayLedgerError("NO_LEDGER", "The pay ledger has not been started for this club.", 409);
  if (toYmd(row.session.date) < start) {
    throw new PayLedgerError("BEFORE_LEDGER", `The pay ledger starts on ${start}. Class days before that are not on it.`, 409);
  }
  const line = await prisma.payLine.findFirst({
    where: { clubId: args.clubId, userId: row.userId, sourceType: "CLASS_SESSION", sourceId: row.id, component: "BASE" },
    select: { status: true, payoutId: true },
  });
  if (line) requireOpen(line);
  const reason = (args.reason ?? "").trim().slice(0, 500);
  if (args.cents !== null) {
    if (!Number.isInteger(args.cents) || args.cents < 0 || args.cents > MAX_CENTS) throw new PayLedgerError("BAD_INPUT", "Enter the amount to pay for this class day.");
    if (!reason) throw new PayLedgerError("BAD_INPUT", "Say why this class day is paid differently.");
  }
  await prisma.classSessionStaff.update({
    where: { id: row.id },
    data: args.cents === null
      ? { payOverrideCents: null, payOverrideReason: null, payOverrideByUserId: null, payOverrideAt: null }
      : { payOverrideCents: args.cents, payOverrideReason: reason, payOverrideByUserId: args.byUserId, payOverrideAt: args.now ?? new Date() },
  });
  await syncPayLines(args.clubId, { now: args.now, userIds: [row.userId] });
  return { userId: row.userId, before: row.payOverrideCents, after: args.cents, className: row.session.recurringClass.name, dateYmd: toYmd(row.session.date) };
}

// ── "Pay for this day" on the class-day sheet ───────────────────────────────

export type DayPayRow = {
  staffRowId: string;
  userId: string;
  name: string;
  roleLabel: string;
  kind: string;
  status: string;
  /** What their own pay plan works out to for this class day (null = no plan covers it). */
  planCents: number | null;
  planName: string | null;
  /** Why there is no plan amount ("covered by salary", "no plan", "two plans match"). */
  planNote: string | null;
  overrideCents: number | null;
  overrideReason: string | null;
  overrideByName: string | null;
  overrideAt: string | null;
  /** For a substitute: what the coach they cover would have been paid. */
  matchRegular: { name: string; cents: number } | null;
  /** PAID or on a payout — the amount can no longer be changed here. */
  locked: boolean;
  lockedWhy: string | null;
  /** Their row is one that earns pay at all (scheduled; not called out / replaced / no-show). */
  payable: boolean;
  history: { at: string; byName: string; action: "set" | "cleared"; cents: number | null; reason: string | null }[];
};

export type DayPay = { onLedger: boolean; ledgerStart: string | null; date: string; rows: DayPayRow[] };

/** What each coach on one class day is paid for it, and any one-day override with its history. null = no such class day. */
export async function loadDayPay(clubId: string, sessionId: string): Promise<DayPay | null> {
  const session = await prisma.classSession.findFirst({
    where: { id: sessionId, clubId },
    select: {
      id: true, classId: true, date: true, startsAt: true, endsAt: true,
      staff: {
        select: {
          id: true, userId: true, roleName: true, kind: true, status: true, replacesStaffId: true,
          payOverrideCents: true, payOverrideReason: true, payOverrideByUserId: true, payOverrideAt: true,
        },
      },
    },
  });
  if (!session) return null;
  const date = toYmd(session.date);
  const ledgerStart = await getLedgerStart(clubId);
  const onLedger = !!ledgerStart && date >= ledgerStart;
  const rows = session.staff.filter((r) => r.status !== "REMOVED" || r.payOverrideCents !== null);
  if (rows.length === 0) return { onLedger, ledgerStart, date, rows: [] };
  const rowIds = rows.map((r) => r.id);
  const userIds = Array.from(new Set(rows.map((r) => r.userId)));
  const [plans, lines, audits] = await Promise.all([
    listPlans(clubId, userIds),
    prisma.payLine.findMany({
      where: { clubId, sourceType: "CLASS_SESSION", sourceId: { in: rowIds }, component: "BASE" },
      select: { sourceId: true, status: true, payoutId: true },
    }),
    prisma.billingAuditLog.findMany({
      where: { clubId, action: { in: ["PAY_LINE_OVERRIDE_SET", "PAY_LINE_OVERRIDE_CLEARED"] } },
      orderBy: { createdAt: "desc" },
      take: 400,
      select: { action: true, actorUserId: true, after: true, createdAt: true },
    }),
  ]);
  const people = Array.from(new Set([...userIds, ...rows.map((r) => r.payOverrideByUserId), ...audits.map((a) => a.actorUserId)].filter((x): x is string => !!x)));
  const users = await prisma.user.findMany({ where: { clubId, id: { in: people } }, select: { id: true, firstName: true, lastName: true } });
  const nameOf = (id: string | null | undefined) => {
    const u = users.find((x) => x.id === id);
    return u ? `${u.firstName} ${u.lastName}`.trim() : "Someone";
  };
  const minutes = Math.max(0, (session.endsAt.getTime() - session.startsAt.getTime()) / 60000);
  const planFor = (userId: string, roleName: string | null) => {
    const m = matchClassPlan(plans.filter((p) => p.userId === userId), { dateYmd: date, classId: session.classId, roleName });
    if (m.kind === "plan") return { cents: planClassAmount(m.plan, minutes).amountCents, name: m.plan.name, note: null as string | null };
    if (m.kind === "salary") return { cents: 0, name: m.plan.name, note: "Covered by their salary" };
    if (m.kind === "tie") return { cents: null, name: null, note: `Two pay plans match equally: ${m.plans.map((p) => p.name).join(" and ")}` };
    return { cents: null, name: null, note: "No pay plan covers this class and role" };
  };
  const lineOf = new Map(lines.map((l) => [l.sourceId, l]));
  const byId = new Map(session.staff.map((r) => [r.id, r]));
  return {
    onLedger, ledgerStart, date,
    rows: rows.map((r) => {
      const plan = planFor(r.userId, r.roleName);
      const line = lineOf.get(r.id);
      const covered = r.kind === "SUBSTITUTE" && r.replacesStaffId ? byId.get(r.replacesStaffId) : undefined;
      const regular = covered ? planFor(covered.userId, covered.roleName) : null;
      const locked = !!line && lineLocked(line);
      return {
        staffRowId: r.id, userId: r.userId, name: nameOf(r.userId), roleLabel: roleLabel(r.roleName), kind: r.kind, status: r.status,
        planCents: plan.cents, planName: plan.name, planNote: plan.note,
        overrideCents: r.payOverrideCents, overrideReason: r.payOverrideReason,
        overrideByName: r.payOverrideByUserId ? nameOf(r.payOverrideByUserId) : null,
        overrideAt: r.payOverrideAt ? r.payOverrideAt.toISOString() : null,
        matchRegular: covered && regular && regular.cents !== null && regular.cents > 0 ? { name: nameOf(covered.userId).split(" ")[0], cents: regular.cents } : null,
        locked,
        lockedWhy: locked ? (line!.status === "PAID" ? "Already paid" : "On a payout") : null,
        payable: r.status === "SCHEDULED",
        history: audits
          .filter((a) => (a.after as { staffRowId?: string } | null)?.staffRowId === r.id)
          .map((a) => {
            const after = (a.after ?? {}) as { overrideCents?: number | null; reason?: string | null };
            return {
              at: a.createdAt.toISOString(), byName: nameOf(a.actorUserId),
              action: a.action === "PAY_LINE_OVERRIDE_SET" ? ("set" as const) : ("cleared" as const),
              cents: typeof after.overrideCents === "number" ? after.overrideCents : null, reason: after.reason ?? null,
            };
          }),
      };
    }),
  };
}

/** Override (cents) or clear the override (null) on one generated pay line that has not been paid. */
export async function setLineOverride(args: {
  clubId: string; lineId: string; cents: number | null; reason?: string | null; byUserId: string | null; now?: Date;
}): Promise<{ userId: string; description: string; before: number | null; after: number | null; staffRowId?: string | null }> {
  const l = await readLine(args.clubId, args.lineId);
  requireOpen(l);
  if (l.rateSource === "MANUAL") throw new PayLedgerError("BAD_STATE", "This line was added by hand — edit it instead.", 409);
  if (l.status === "VOID") throw new PayLedgerError("BAD_STATE", "This line is no longer payable.", 409);
  if (l.sourceType === "CLASS_SESSION" && l.component === "BASE") {
    const res = await setAssignmentOverride({ clubId: args.clubId, staffRowId: l.sourceId, cents: args.cents, reason: args.reason, byUserId: args.byUserId, now: args.now });
    return { userId: l.userId, description: l.description, before: l.rateSource === "OVERRIDE" ? l.amountCents : null, after: res.after, staffRowId: l.sourceId };
  }
  const reason = (args.reason ?? "").trim().slice(0, 500);
  if (args.cents !== null) {
    if (!Number.isInteger(args.cents) || args.cents < 0 || args.cents > MAX_CENTS) throw new PayLedgerError("BAD_INPUT", "Enter the amount to pay.");
    if (!reason) throw new PayLedgerError("BAD_INPUT", "Say why this is paid differently.");
    await prisma.payLine.updateMany({
      where: { id: l.id, payoutId: null, status: { not: "PAID" } },
      data: {
        amountCents: args.cents, rateSource: "OVERRIDE", status: "ESTIMATED", reviewReason: null,
        overrideReason: reason, overrideByUserId: args.byUserId, overrideAt: args.now ?? new Date(),
      },
    });
  } else {
    if (l.rateSource !== "OVERRIDE") return { userId: l.userId, description: l.description, before: null, after: null };
    await prisma.payLine.updateMany({
      where: { id: l.id, payoutId: null, status: { not: "PAID" } },
      data: { rateSource: "PLAN", amountCents: l.planAmountCents, overrideReason: null, overrideByUserId: null, overrideAt: null },
    });
    await syncPayLines(args.clubId, { now: args.now, userIds: [l.userId] });
  }
  return { userId: l.userId, description: l.description, before: l.rateSource === "OVERRIDE" ? l.amountCents : null, after: args.cents };
}

// ── Bonuses and adjustments added by hand ───────────────────────────────────

export const MANUAL_KINDS = ["BONUS", "ADJUSTMENT"] as const;
export type ManualKind = (typeof MANUAL_KINDS)[number];

async function checkManual(clubId: string, a: { kind: string; cents: number; description: string; workDate: string }, now: Date) {
  const start = await getLedgerStart(clubId);
  if (!start) throw new PayLedgerError("NO_LEDGER", "The pay ledger has not been started for this club.", 409);
  const { today } = await clubToday(clubId, now);
  if (!isYmd(a.workDate)) throw new PayLedgerError("BAD_INPUT", "Choose a date.");
  if (a.workDate < start) throw new PayLedgerError("BEFORE_LEDGER", `The pay ledger starts on ${start}. Nothing can be added before that date.`);
  if (a.workDate > today) throw new PayLedgerError("BAD_INPUT", "The date can't be in the future.");
  if (!a.description.trim()) throw new PayLedgerError("BAD_INPUT", "Say what this is for.");
  if (!Number.isInteger(a.cents) || a.cents === 0 || Math.abs(a.cents) > MAX_CENTS) throw new PayLedgerError("BAD_INPUT", "Enter an amount.");
  if (a.kind === "BONUS" && a.cents < 0) throw new PayLedgerError("BAD_INPUT", "A bonus can't be negative — use an adjustment to take pay off.");
}

export async function addManualLine(args: {
  clubId: string; userId: string; kind: ManualKind; cents: number; description: string; workDate: string; byUserId: string | null; now?: Date;
}): Promise<{ id: string }> {
  const now = args.now ?? new Date();
  await requireStaffUser(args.clubId, args.userId);
  await checkManual(args.clubId, args, now);
  const s = (await loadSchedules(args.clubId)).get(args.userId);
  const period = s ? periodOfDay(s, args.workDate) : null;
  const made = await prisma.payLine.create({
    data: {
      clubId: args.clubId, userId: args.userId, sourceType: args.kind, sourceId: `manual_${randomUUID()}`, component: "BASE",
      workDate: ymdToDate(args.workDate), description: args.description.trim().slice(0, 200), units: 1,
      rateCents: args.cents, amountCents: args.cents, rateSource: "MANUAL", status: "ESTIMATED",
      periodStart: dateOrNull(period?.periodStart ?? null), periodEnd: dateOrNull(period?.periodEnd ?? null),
      createdByUserId: args.byUserId,
    },
    select: { id: true },
  });
  return { id: made.id };
}

async function readManual(clubId: string, lineId: string) {
  const l = await readLine(clubId, lineId);
  if (l.rateSource !== "MANUAL") throw new PayLedgerError("BAD_STATE", "Only a bonus or adjustment added by hand can be edited or removed. For anything else, set the pay for that line.", 409);
  requireOpen(l);
  if (l.status === "VOID") throw new PayLedgerError("BAD_STATE", "This line was already removed.", 409);
  return l;
}

export async function editManualLine(args: {
  clubId: string; lineId: string; cents: number; description: string; workDate: string; now?: Date;
}): Promise<{ userId: string; before: { cents: number | null; description: string; workDate: string }; after: { cents: number; description: string; workDate: string } }> {
  const l = await readManual(args.clubId, args.lineId);
  await checkManual(args.clubId, { kind: l.sourceType, cents: args.cents, description: args.description, workDate: args.workDate }, args.now ?? new Date());
  const s = (await loadSchedules(args.clubId)).get(l.userId);
  const period = s ? periodOfDay(s, args.workDate) : null;
  const description = args.description.trim().slice(0, 200);
  await prisma.payLine.updateMany({
    where: { id: l.id, payoutId: null, status: { not: "PAID" } },
    data: {
      amountCents: args.cents, rateCents: args.cents, description, workDate: ymdToDate(args.workDate),
      periodStart: dateOrNull(period?.periodStart ?? null), periodEnd: dateOrNull(period?.periodEnd ?? null),
    },
  });
  return {
    userId: l.userId,
    before: { cents: l.amountCents, description: l.description, workDate: toYmd(l.workDate) },
    after: { cents: args.cents, description, workDate: args.workDate },
  };
}

export async function voidManualLine(args: { clubId: string; lineId: string; reason: string; byUserId: string | null; now?: Date }): Promise<{ userId: string; description: string; cents: number | null }> {
  const l = await readManual(args.clubId, args.lineId);
  const reason = args.reason.trim().slice(0, 500);
  if (!reason) throw new PayLedgerError("BAD_INPUT", "Say why this is being removed.");
  await prisma.payLine.updateMany({
    where: { id: l.id, payoutId: null, status: { not: "PAID" } },
    data: { status: "VOID", voidReason: reason, voidedAt: args.now ?? new Date(), voidedByUserId: args.byUserId },
  });
  return { userId: l.userId, description: l.description, cents: l.amountCents };
}

// ── Payouts ─────────────────────────────────────────────────────────────────

export type LedgerPayoutResult = { payoutId: string; amountCents: number; lineCount: number; paid: boolean; periodStart: string; periodEnd: string | null };

/**
 * Pay (or queue as PENDING) a set of one coach's pay lines with ONE payout.
 * Every line must be this coach's, unpaid, resolved and not on another payout —
 * if any is not (someone else just paid it, it needs review), nothing is
 * written. The payout's amount is exactly the lines' total.
 */
export async function createLedgerPayout(args: {
  clubId: string; userId: string; lineIds: readonly string[]; paid: boolean; method?: string | null;
  paidAt?: Date | null; notes?: string | null; byUserId: string | null; now?: Date;
}): Promise<LedgerPayoutResult> {
  const now = args.now ?? new Date();
  const ids = Array.from(new Set(args.lineIds));
  if (ids.length === 0) throw new PayLedgerError("BAD_INPUT", "Choose at least one pay line.");
  const user = await prisma.user.findFirst({
    where: { id: args.userId, clubId: args.clubId, role: { in: ["OWNER", "STAFF"] } },
    select: { id: true, firstName: true, lastName: true },
  });
  if (!user) throw new PayLedgerError("NOT_FOUND", "Staff member not found.", 404);
  const lines = await prisma.payLine.findMany({
    where: { id: { in: ids }, clubId: args.clubId, userId: args.userId, payoutId: null, status: "ESTIMATED", amountCents: { not: null } },
    select: { id: true, amountCents: true, workDate: true, periodEnd: true },
  });
  if (lines.length !== ids.length) {
    throw new PayLedgerError("STALE", "Some of those pay lines changed (already paid, removed, or needing review). Refresh and try again.", 409);
  }
  const amountCents = lines.reduce((a, l) => a + (l.amountCents ?? 0), 0);
  if (amountCents <= 0) throw new PayLedgerError("NOTHING_TO_PAY", `Those lines add up to ${fmtCents(amountCents)} — there is nothing to pay.`, 409);
  const days = lines.map((l) => toYmd(l.workDate)).sort();
  const ends = new Set(lines.map((l) => ymdOrNull(l.periodEnd)));
  const periodEnd = ends.size === 1 ? Array.from(ends)[0] : null;
  const payeeName = `${user.firstName} ${user.lastName}`.trim();

  const payoutId = await prisma.$transaction(async (tx) => {
    const payout = await tx.payout.create({
      data: {
        clubId: args.clubId, payeeType: "STAFF", payeeUserId: user.id, payeeName, kind: "PAYROLL",
        amount: amountCents / 100, status: args.paid ? "PAID" : "PENDING", method: args.method ?? null,
        paidAt: args.paid ? args.paidAt ?? now : null, notes: (args.notes ?? "").trim().slice(0, 1000) || null,
        createdById: args.byUserId, periodStart: ymdToDate(days[0]), payPeriodEnd: dateOrNull(periodEnd),
        lockedAt: args.paid ? now : null,
      },
      select: { id: true },
    });
    const hit = await tx.payLine.updateMany({
      where: { id: { in: ids }, clubId: args.clubId, userId: args.userId, payoutId: null, status: "ESTIMATED" },
      data: { payoutId: payout.id, ...(args.paid ? { status: "PAID" } : {}) },
    });
    // Someone else attached one of these lines between the read and the write: undo everything.
    if (hit.count !== ids.length) throw new PayLedgerError("STALE", "Some of those pay lines were just paid by someone else. Refresh and try again.", 409);
    return payout.id;
  });
  return { payoutId, amountCents, lineCount: ids.length, paid: args.paid, periodStart: days[0], periodEnd };
}

/** How many pay lines a payout settles (0 = not a ledger payout). */
export async function payoutLineCount(clubId: string, payoutId: string): Promise<number> {
  return prisma.payLine.count({ where: { clubId, payoutId } });
}

/** A PENDING ledger payout was marked paid: its lines are paid and it is locked. */
export async function settleLedgerPayout(clubId: string, payoutId: string, now: Date = new Date()): Promise<number> {
  const hit = await prisma.payLine.updateMany({ where: { clubId, payoutId }, data: { status: "PAID" } });
  if (hit.count > 0) await prisma.payout.updateMany({ where: { id: payoutId, clubId }, data: { lockedAt: now } });
  return hit.count;
}

/**
 * A ledger payout was voided (or a pending one deleted): its lines go back to
 * unpaid so they can be corrected and paid again. Returns what was released,
 * for the audit entry.
 */
export async function releasePayoutLines(clubId: string, payoutId: string): Promise<{ id: string; description: string; amountCents: number | null; workDate: string }[]> {
  const lines = await prisma.payLine.findMany({ where: { clubId, payoutId }, select: { id: true, description: true, amountCents: true, workDate: true } });
  if (lines.length > 0) {
    await prisma.payLine.updateMany({ where: { clubId, payoutId }, data: { payoutId: null, status: "ESTIMATED" } });
    await prisma.payout.updateMany({ where: { id: payoutId, clubId }, data: { lockedAt: null } });
  }
  return lines.map((l) => ({ id: l.id, description: l.description, amountCents: l.amountCents, workDate: toYmd(l.workDate) }));
}

/** One coach's unpaid, resolved lines for the pay period ending on `payday` (what "Mark paid" on a reminder settles). */
export async function periodLines(clubId: string, userId: string, payday: string): Promise<{ ids: string[]; amountCents: number; reviewCount: number }> {
  const lines = await prisma.payLine.findMany({
    where: { clubId, userId, periodEnd: ymdToDate(payday), payoutId: null, status: { in: ["ESTIMATED", "NEEDS_REVIEW"] } },
    select: { id: true, amountCents: true, status: true },
  });
  const payable = lines.filter((l) => l.status === "ESTIMATED" && l.amountCents !== null);
  return {
    ids: payable.map((l) => l.id),
    amountCents: payable.reduce((a, l) => a + (l.amountCents ?? 0), 0),
    reviewCount: lines.length - payable.length,
  };
}
