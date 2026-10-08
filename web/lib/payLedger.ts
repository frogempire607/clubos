// The pay ledger — the PURE rules (Branch 2, 2026-10-13).
//
// Julian's rules this file implements (docs/improvement/
// STAFF-SCHEDULING-PAYROLL-SCHEMA-PROPOSAL.md):
//   - a coach can hold several named, dated pay plans; which one pays a class
//     day is the MOST SPECIFIC match (class + role → class → role → any)
//   - no matching plan, or two equally specific ones = "needs review". Never a
//     guessed amount.
//   - a substitute is paid from THEIR OWN plan, unless an authorized person set
//     the pay for that one class day (the override), which never changes a plan
//   - a class day pays only once it has ENDED; cancelled = unpaid unless marked
//     "cancelled — paid"; called-out / replaced / no-show / removed never pay
//   - salary = the plan's amount once per pay period, never prorated
//   - nothing before the club's ledger start date ever gets a pay line
//   - a line attached to a payout is never touched again
//
// No Prisma, no Next, no server-only imports: the Payroll screens import the
// types and words from here, and scripts/pay-ledger-tests.ts covers the rules.
// The database side is lib/payLedgerServer.ts.

// ── Vocabulary ──────────────────────────────────────────────────────────────

export const PLAN_BASE_TYPES = ["SALARY", "PER_CLASS", "HOURLY", "PER_EVENT"] as const;
export type PlanBaseType = (typeof PLAN_BASE_TYPES)[number];

export const PLAN_BASE_LABELS: Record<PlanBaseType, { label: string; desc: string; amountLabel: string; unit: string }> = {
  SALARY: { label: "Salary", desc: "The same amount every pay period.", amountLabel: "Amount per pay period", unit: " per pay period" },
  PER_CLASS: { label: "Per class", desc: "Paid for each class day worked.", amountLabel: "Amount per class", unit: " per class" },
  HOURLY: { label: "Hourly", desc: "Paid for the hours of each class day worked.", amountLabel: "Hourly rate", unit: "/hr" },
  PER_EVENT: { label: "Per event", desc: "Paid for each event worked.", amountLabel: "Amount per event", unit: " per event" },
};

export const BONUS_TYPES = ["ATTENDANCE", "SIGNUP", "REVENUE_SHARE"] as const;
export type PlanBonusType = (typeof BONUS_TYPES)[number];
export const COUNT_PER = ["PERIOD", "CLASS_DAY"] as const;
export type CountPer = (typeof COUNT_PER)[number];

/** Scope types a plan's BASE rate can carry. */
export const BASE_SCOPE_TYPES = ["CLASS", "ROLE", "EVENT", "EVENT_TYPE"] as const;
export const BONUS_SCOPE_TYPES = ["CLASS", "EVENT", "MEMBERSHIP", "PRIVATE_LESSON_TYPE"] as const;
export const ALL_SCOPE_TYPES = ["CLASS", "ROLE", "EVENT", "EVENT_TYPE", "MEMBERSHIP", "PRIVATE_LESSON_TYPE"] as const;
export type PlanScopeType = (typeof ALL_SCOPE_TYPES)[number];
export type PlanScope = { scopeType: PlanScopeType | string; scopeId: string };

export const EVENT_TYPES = ["CLASS", "PRIVATE", "CLINIC", "CAMP", "TOURNAMENT", "OTHER"] as const;
export const EVENT_TYPE_LABELS: Record<string, string> = {
  CLASS: "Class event", PRIVATE: "Private", CLINIC: "Clinic", CAMP: "Camp", TOURNAMENT: "Tournament", OTHER: "Other event",
};

export const LINE_SOURCE_TYPES = ["CLASS_SESSION", "EVENT", "PRIVATE_LESSON", "SALARY", "BONUS", "ADJUSTMENT"] as const;
export type LineSourceType = (typeof LINE_SOURCE_TYPES)[number];
export const LINE_STATUSES = ["ESTIMATED", "NEEDS_REVIEW", "PAID", "VOID"] as const;
export type LineStatus = (typeof LINE_STATUSES)[number];
export type RateSource = "PLAN" | "OVERRIDE" | "MANUAL";

/** Generated lines older than this are left exactly as they are (still payable; no longer re-priced). */
export const SYNC_WINDOW_DAYS = 62;

export type LedgerBonus = {
  id: string;
  bonusType: PlanBonusType | string;
  /** dollars (ATTENDANCE / SIGNUP) or a percentage (REVENUE_SHARE) */
  amount: number;
  minThreshold: number | null;
  maxThreshold: number | null;
  countPer: CountPer | string;
  scopes: PlanScope[];
};

export type LedgerPlan = {
  id: string;
  userId: string;
  name: string;
  baseType: PlanBaseType | string;
  /** dollars */
  baseAmount: number;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string | null; // inclusive
  archived: boolean;
  copiedFromId?: string | null;
  baseScopes: PlanScope[];
  bonuses: LedgerBonus[];
};

// ── Small helpers ───────────────────────────────────────────────────────────

export const toCents = (dollars: number): number => Math.round(dollars * 100);
export const fromCents = (cents: number): number => Math.round(cents) / 100;

export function fmtCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  const neg = cents < 0;
  const s = (Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${neg ? "−" : ""}$${s}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Oct 13" */
export function fmtYmd(ymd: string): string {
  const [, m, d] = ymd.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}
/** "Oct 13, 2026" */
export function fmtYmdYear(ymd: string): string {
  return `${fmtYmd(ymd)}, ${ymd.slice(0, 4)}`;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
export const isYmd = (v: unknown): v is string => typeof v === "string" && YMD.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
export function addDaysYmd(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** How a role is compared: trimmed, lower-case; blank = "coach" (what a row with no role shows as). */
export function roleKey(roleName: string | null | undefined): string {
  return (roleName ?? "").trim().toLowerCase() || "coach";
}

/** Items at or below `min` are not paid; items above `max` are not paid (same as lib/compensation). */
export function payableCount(count: number, min?: number | null, max?: number | null): number {
  const lo = min != null && min > 0 ? min : 0;
  const hi = max != null && max > 0 ? Math.min(count, max) : count;
  return Math.max(0, hi - lo);
}

const ATTENDED = new Set(["PRESENT", "LATE", "DROP_IN", "TRIAL"]);
export const isAttendedStatus = (s: string) => ATTENDED.has(s);

// ── Plans: in force, and matching ───────────────────────────────────────────

/** Is the plan in force on this calendar day? An archived plan never is. */
export function planActiveOn(plan: Pick<LedgerPlan, "effectiveFrom" | "effectiveTo" | "archived">, ymd: string): boolean {
  if (plan.archived) return false;
  if (plan.effectiveFrom > ymd) return false;
  return plan.effectiveTo === null || plan.effectiveTo >= ymd;
}

export function planState(plan: Pick<LedgerPlan, "effectiveFrom" | "effectiveTo" | "archived">, todayYmd: string): "ARCHIVED" | "ENDED" | "UPCOMING" | "ACTIVE" {
  if (plan.archived) return "ARCHIVED";
  if (plan.effectiveTo !== null && plan.effectiveTo < todayYmd) return "ENDED";
  if (plan.effectiveFrom > todayYmd) return "UPCOMING";
  return "ACTIVE";
}

const ids = (scopes: readonly PlanScope[], t: string) => scopes.filter((s) => s.scopeType === t).map((s) => s.scopeId);

/**
 * How specifically a per-class / hourly plan covers one class day.
 * null = it does not cover it. 3 = this class AND this role, 2 = this class,
 * 1 = this role, 0 = "any class, any role".
 */
export function classSpecificity(plan: Pick<LedgerPlan, "baseScopes">, occ: { classId: string; roleName: string | null }): number | null {
  const classes = ids(plan.baseScopes, "CLASS");
  const roles = ids(plan.baseScopes, "ROLE").map((r) => roleKey(r));
  if (classes.length > 0 && !classes.includes(occ.classId)) return null;
  if (roles.length > 0 && !roles.includes(roleKey(occ.roleName))) return null;
  return (classes.length > 0 ? 2 : 0) + (roles.length > 0 ? 1 : 0);
}

export type PlanMatch =
  | { kind: "plan"; plan: LedgerPlan; specificity: number }
  | { kind: "salary"; plan: LedgerPlan } // no per-class plan covers it, but a salary is in force
  | { kind: "tie"; plans: LedgerPlan[] }
  | { kind: "none" };

/** The plan that pays one class day for one coach. `plans` = that coach's plans (any state). */
export function matchClassPlan(plans: readonly LedgerPlan[], occ: { dateYmd: string; classId: string; roleName: string | null }): PlanMatch {
  const active = plans.filter((p) => planActiveOn(p, occ.dateYmd));
  let best = -1;
  let top: LedgerPlan[] = [];
  for (const p of active) {
    if (p.baseType !== "PER_CLASS" && p.baseType !== "HOURLY") continue;
    const s = classSpecificity(p, occ);
    if (s === null) continue;
    if (s > best) { best = s; top = [p]; }
    else if (s === best) top.push(p);
  }
  if (top.length === 1) return { kind: "plan", plan: top[0], specificity: best };
  if (top.length > 1) return { kind: "tie", plans: top };
  const salary = active.find((p) => p.baseType === "SALARY");
  if (salary) return { kind: "salary", plan: salary };
  return { kind: "none" };
}

/** 2 = this event, 1 = this event type, 0 = any event; null = not covered. */
export function eventSpecificity(plan: Pick<LedgerPlan, "baseScopes">, ev: { eventId: string; eventType: string }): number | null {
  const events = ids(plan.baseScopes, "EVENT");
  const types = ids(plan.baseScopes, "EVENT_TYPE");
  if (events.length === 0 && types.length === 0) return 0;
  if (events.includes(ev.eventId)) return 2;
  if (types.includes(ev.eventType)) return 1;
  return null;
}

export function matchEventPlan(plans: readonly LedgerPlan[], ev: { dateYmd: string; eventId: string; eventType: string }): PlanMatch {
  const active = plans.filter((p) => planActiveOn(p, ev.dateYmd) && p.baseType === "PER_EVENT");
  let best = -1;
  let top: LedgerPlan[] = [];
  for (const p of active) {
    const s = eventSpecificity(p, ev);
    if (s === null) continue;
    if (s > best) { best = s; top = [p]; }
    else if (s === best) top.push(p);
  }
  if (top.length === 1) return { kind: "plan", plan: top[0], specificity: best };
  if (top.length > 1) return { kind: "tie", plans: top };
  return { kind: "none" };
}

// ── Lines ───────────────────────────────────────────────────────────────────

export type LineKey = { userId: string; sourceType: string; sourceId: string; component: string };
export const lineKey = (k: LineKey) => `${k.userId}|${k.sourceType}|${k.sourceId}|${k.component}`;

/** What a generated line should say right now. */
export type DesiredLine = LineKey & {
  workDate: string;
  description: string;
  units: number;
  rateCents: number | null;
  amountCents: number | null;
  rateSource: RateSource;
  planId: string | null;
  planName: string | null;
  planAmountCents: number | null;
  overrideReason: string | null;
  overrideByUserId: string | null;
  overrideAt: Date | null;
  status: "ESTIMATED" | "NEEDS_REVIEW";
  reviewReason: string | null;
  periodStart: string | null;
  periodEnd: string | null;
};

/** One coach on one class day, as the ledger sees it. */
export type LedgerClassRow = {
  rowId: string;
  userId: string;
  classId: string;
  className: string;
  dateYmd: string;
  minutes: number;
  roleName: string | null;
  kind: string; // REGULAR | SUBSTITUTE
  status: string; // SCHEDULED | NEEDS_COVERAGE | REPLACED | NO_SHOW | REMOVED
  ended: boolean;
  canceled: boolean;
  cancelPaid: boolean;
  payOverrideCents: number | null;
  payOverrideReason: string | null;
  payOverrideByUserId: string | null;
  payOverrideAt: Date | null;
  /** Members marked present on that class day (PRESENT / LATE / DROP_IN / TRIAL). */
  attended: number;
};

export type LedgerEventRow = {
  assignmentId: string;
  userId: string;
  eventId: string;
  eventName: string;
  eventType: string;
  dateYmd: string; // the day it ended
  ended: boolean;
  /** The event has its own pay set up for this person (Events → Pay) — that is what pays them. */
  hasEventComp: boolean;
};

/** One private lesson for its coach, as the ledger sees it. */
export type LedgerPrivateRow = {
  bookingId: string;
  userId: string; // the coach
  lessonTitle: string;
  athleteName: string;
  dateYmd: string; // the club's calendar day it ended
  ended: boolean;
  status: string; // CONFIRMED | COMPLETED | CANCELED | …
  /** What the client paid for it, in cents (null = nothing recorded). */
  pricePaidCents: number | null;
  /** The coach's pay rate for this lesson type (profile → Pay), or null when none is set. */
  rate: { payType: string; payValue: number } | null;
};

/** A private lesson earns pay once it has ended and was not cancelled or declined. */
export function privateRowPayable(r: Pick<LedgerPrivateRow, "status" | "ended">): boolean {
  return r.ended && (r.status === "CONFIRMED" || r.status === "COMPLETED");
}

export type LedgerPeriod = { userId: string; periodStart: string; periodEnd: string };

/** Does this class-day row earn pay? (worked = scheduled on a day that has ended and was not cancelled-unpaid) */
export function classRowPayable(r: Pick<LedgerClassRow, "status" | "ended" | "canceled" | "cancelPaid">): boolean {
  if (r.status !== "SCHEDULED") return false;
  if (!r.ended) return false;
  return !r.canceled || r.cancelPaid;
}

/** Why a class-day row does not earn pay — the note on a line that is withdrawn. */
export function classRowUnpaidReason(r: Pick<LedgerClassRow, "status" | "ended" | "canceled" | "cancelPaid">): string {
  if (r.status === "REPLACED") return "A substitute covered this class day";
  if (r.status === "NO_SHOW") return "Marked as a no-show";
  if (r.status === "NEEDS_COVERAGE") return "Called out — the class day needed coverage";
  if (r.status === "REMOVED") return "Taken off this class day";
  if (r.canceled && !r.cancelPaid) return "The class day was cancelled (not marked paid)";
  if (!r.ended) return "The class has not happened yet";
  return "No longer payable";
}

const roleWords = (r: Pick<LedgerClassRow, "roleName" | "kind">) => {
  const role = (r.roleName ?? "").trim() || (r.kind === "SUBSTITUTE" ? "Substitute" : "Coach");
  return r.kind === "SUBSTITUTE" && roleKey(role) !== "substitute" ? `${role} (substitute)` : role;
};

/** Hours, to 4 places — what an hourly line multiplies by. */
export const hoursOf = (minutes: number) => Math.round((Math.max(0, minutes) / 60) * 10_000) / 10_000;

/** What the plan alone would pay this class day. */
export function planClassAmount(plan: Pick<LedgerPlan, "baseType" | "baseAmount">, minutes: number): { units: number; rateCents: number; amountCents: number } {
  const rateCents = toCents(plan.baseAmount);
  const units = plan.baseType === "HOURLY" ? hoursOf(minutes) : 1;
  return { units, rateCents, amountCents: Math.round(units * rateCents) };
}

export type PlanLinesInput = {
  /** First day that can have a pay line (the club's ledger start, or the sync window's start if later). */
  fromYmd: string;
  /** The club's ledger start date. Nothing before it is ever written. */
  ledgerStart: string;
  plans: readonly LedgerPlan[];
  classRows: readonly LedgerClassRow[];
  eventRows?: readonly LedgerEventRow[];
  privateRows?: readonly LedgerPrivateRow[];
  /** Pay periods (from each coach's pay schedule) that have started. */
  periods?: readonly LedgerPeriod[];
  /** The period a work day falls in, for a coach with a pay schedule. */
  periodOf?: (userId: string, workDate: string) => { periodStart: string; periodEnd: string } | null;
  /** A plan bonus counted over a pay period: dollars + the words, worked out by the shared calculator. */
  periodBonusPay?: (planId: string, bonusId: string, periodEnd: string) => { pay: number; basisLabel: string } | null;
};

export type PlanLinesResult = {
  desired: DesiredLine[];
  /** For a class-day line that is no longer wanted: why (keyed by ClassSessionStaff id). */
  unpaidReasons: Map<string, string>;
};

/**
 * Every generated line that should exist, from the plans and what happened.
 * Pure: the caller loads the facts and applies the result (reconcileLines).
 */
export function planPayLines(input: PlanLinesInput): PlanLinesResult {
  const start = input.fromYmd > input.ledgerStart ? input.fromYmd : input.ledgerStart;
  const plansByUser = new Map<string, LedgerPlan[]>();
  for (const p of input.plans) {
    const list = plansByUser.get(p.userId);
    if (list) list.push(p);
    else plansByUser.set(p.userId, [p]);
  }
  const periodOf = input.periodOf ?? (() => null);
  const desired: DesiredLine[] = [];
  const unpaidReasons = new Map<string, string>();
  const blank = { overrideReason: null, overrideByUserId: null, overrideAt: null, reviewReason: null } as const;

  for (const r of input.classRows) {
    if (r.dateYmd < start) continue;
    if (!classRowPayable(r)) {
      unpaidReasons.set(r.rowId, classRowUnpaidReason(r));
      continue;
    }
    const plans = plansByUser.get(r.userId) ?? [];
    const period = periodOf(r.userId, r.dateYmd);
    const base = {
      userId: r.userId, sourceType: "CLASS_SESSION", sourceId: r.rowId, workDate: r.dateYmd,
      periodStart: period?.periodStart ?? null, periodEnd: period?.periodEnd ?? null,
    };
    const what = `${r.className} · ${roleWords(r)}${r.canceled ? " — cancelled, paid" : ""}`;
    const m = matchClassPlan(plans, { dateYmd: r.dateYmd, classId: r.classId, roleName: r.roleName });
    const hasOverride = r.payOverrideCents !== null && r.payOverrideCents !== undefined;
    const override = hasOverride
      ? {
          amountCents: r.payOverrideCents, rateSource: "OVERRIDE" as const, status: "ESTIMATED" as const, reviewReason: null,
          overrideReason: r.payOverrideReason, overrideByUserId: r.payOverrideByUserId, overrideAt: r.payOverrideAt,
        }
      : null;

    if (m.kind === "plan") {
      const a = planClassAmount(m.plan, r.minutes);
      desired.push({
        ...base, ...blank, component: "BASE", description: what, units: a.units, rateCents: a.rateCents,
        amountCents: a.amountCents, rateSource: "PLAN", planId: m.plan.id, planName: m.plan.name,
        planAmountCents: a.amountCents, status: "ESTIMATED", ...(override ?? {}),
      });
    } else if (m.kind === "salary") {
      desired.push({
        ...base, ...blank, component: "BASE", description: `${what} — covered by salary`, units: 1, rateCents: 0,
        amountCents: 0, rateSource: "PLAN", planId: m.plan.id, planName: m.plan.name, planAmountCents: 0,
        status: "ESTIMATED", ...(override ?? {}),
      });
    } else {
      const reason = m.kind === "tie"
        ? `Two pay plans match this class equally: ${m.plans.map((p) => p.name).join(" and ")}. Narrow one of them, or set the pay for this day.`
        : plans.some((p) => planActiveOn(p, r.dateYmd))
          ? "None of this coach's pay plans covers this class and role. Add a plan, or set the pay for this day."
          : "This coach has no pay plan in force on this day. Add a plan, or set the pay for this day.";
      desired.push({
        ...base, ...blank, component: "BASE", description: what, units: 1, rateCents: null, amountCents: null,
        rateSource: "PLAN", planId: null, planName: null, planAmountCents: null, status: "NEEDS_REVIEW",
        reviewReason: reason, ...(override ?? {}),
      });
    }

    // Attendance bonuses counted per class day.
    for (const p of plans) {
      if (!planActiveOn(p, r.dateYmd)) continue;
      for (const b of p.bonuses) {
        if (b.bonusType !== "ATTENDANCE" || b.countPer !== "CLASS_DAY") continue;
        const classes = ids(b.scopes, "CLASS");
        if (classes.length > 0 && !classes.includes(r.classId)) continue;
        const count = payableCount(r.attended, b.minThreshold, b.maxThreshold);
        if (count <= 0) continue;
        const rateCents = toCents(b.amount);
        const amt = count * rateCents;
        desired.push({
          ...base, ...blank, component: `BONUS:${b.id}`,
          description: `${r.className} · attendance bonus (${count} of ${r.attended} attending)`,
          units: count, rateCents, amountCents: amt, rateSource: "PLAN", planId: p.id, planName: p.name,
          planAmountCents: amt, status: "ESTIMATED",
        });
      }
    }
  }

  for (const e of input.eventRows ?? []) {
    if (e.dateYmd < start || !e.ended || e.hasEventComp) continue;
    const plans = plansByUser.get(e.userId) ?? [];
    // Events are only on the ledger for a coach who has a per-event plan in force.
    if (!plans.some((p) => p.baseType === "PER_EVENT" && planActiveOn(p, e.dateYmd))) continue;
    const m = matchEventPlan(plans, e);
    if (m.kind === "none") continue;
    const period = periodOf(e.userId, e.dateYmd);
    const base = {
      userId: e.userId, sourceType: "EVENT", sourceId: e.assignmentId, component: "BASE", workDate: e.dateYmd,
      description: `${e.eventName} · event`, periodStart: period?.periodStart ?? null, periodEnd: period?.periodEnd ?? null, ...blank,
    };
    if (m.kind === "plan") {
      const rateCents = toCents(m.plan.baseAmount);
      desired.push({
        ...base, units: 1, rateCents, amountCents: rateCents, rateSource: "PLAN", planId: m.plan.id,
        planName: m.plan.name, planAmountCents: rateCents, status: "ESTIMATED",
      });
    } else if (m.kind === "tie") {
      desired.push({
        ...base, units: 1, rateCents: null, amountCents: null, rateSource: "PLAN", planId: null, planName: null,
        planAmountCents: null, status: "NEEDS_REVIEW",
        reviewReason: `Two per-event pay plans match this event equally: ${m.plans.map((p) => p.name).join(" and ")}.`,
      });
    }
  }

  // Private lessons: paid from the coach's rate for that lesson type (a flat
  // amount, or a percentage of what the client paid). No rate = needs review.
  for (const r of input.privateRows ?? []) {
    if (r.dateYmd < start || !privateRowPayable(r)) continue;
    const period = periodOf(r.userId, r.dateYmd);
    const base = {
      userId: r.userId, sourceType: "PRIVATE_LESSON", sourceId: r.bookingId, component: "BASE", workDate: r.dateYmd,
      periodStart: period?.periodStart ?? null, periodEnd: period?.periodEnd ?? null, planId: null, ...blank,
    };
    const what = `Private lesson · ${r.lessonTitle}${r.athleteName ? ` · ${r.athleteName}` : ""}`;
    const review = (reason: string): DesiredLine => ({
      ...base, description: what, units: 1, rateCents: null, amountCents: null, rateSource: "PLAN", planName: null,
      planAmountCents: null, status: "NEEDS_REVIEW", reviewReason: reason,
    });
    if (!r.rate) {
      desired.push(review(`No private-lesson pay rate is set for “${r.lessonTitle}”. Set one on their profile → Pay, or set the pay for this line.`));
    } else if (r.rate.payType === "PERCENT") {
      if (r.pricePaidCents === null) {
        desired.push(review("This coach is paid a percentage of the lesson price, and no price was recorded for this lesson. Set the pay for this line."));
      } else {
        const cents = Math.round((r.pricePaidCents * r.rate.payValue) / 100);
        desired.push({
          ...base, description: `${what} (${r.rate.payValue}% of ${fmtCents(r.pricePaidCents)})`, units: 1, rateCents: cents, amountCents: cents,
          rateSource: "PLAN", planName: "Private lesson rate", planAmountCents: cents, status: "ESTIMATED",
        });
      }
    } else {
      const cents = toCents(r.rate.payValue);
      desired.push({
        ...base, description: what, units: 1, rateCents: cents, amountCents: cents, rateSource: "PLAN",
        planName: "Private lesson rate", planAmountCents: cents, status: "ESTIMATED",
      });
    }
  }

  for (const per of input.periods ?? []) {
    if (per.periodStart < input.ledgerStart) continue; // only FULL periods on/after the start
    if (per.periodEnd < start) continue;
    const plans = plansByUser.get(per.userId) ?? [];
    for (const p of plans) {
      if (!planActiveOn(p, per.periodEnd)) continue;
      const base = {
        userId: per.userId, sourceId: `${p.id}|${per.periodEnd}`, workDate: per.periodEnd,
        periodStart: per.periodStart, periodEnd: per.periodEnd, planId: p.id, planName: p.name, ...blank,
      };
      if (p.baseType === "SALARY") {
        const cents = toCents(p.baseAmount);
        desired.push({
          ...base, sourceType: "SALARY", component: "BASE",
          description: `${p.name} · salary, ${fmtYmd(per.periodStart)} – ${fmtYmd(per.periodEnd)}`,
          units: 1, rateCents: cents, amountCents: cents, rateSource: "PLAN", planAmountCents: cents, status: "ESTIMATED",
        });
      }
      for (const b of p.bonuses) {
        if (b.bonusType === "ATTENDANCE" && b.countPer === "CLASS_DAY") continue;
        const got = input.periodBonusPay?.(p.id, b.id, per.periodEnd) ?? null;
        if (!got || got.pay <= 0) continue;
        const cents = toCents(got.pay);
        desired.push({
          ...base, sourceType: "BONUS", component: `BONUS:${b.id}`,
          description: `${BONUS_LABELS[b.bonusType] ?? "Bonus"} · ${got.basisLabel} · ${fmtYmd(per.periodStart)} – ${fmtYmd(per.periodEnd)}`,
          units: 1, rateCents: cents, amountCents: cents, rateSource: "PLAN", planAmountCents: cents, status: "ESTIMATED",
        });
      }
    }
  }

  return { desired, unpaidReasons };
}

export const BONUS_LABELS: Record<string, string> = {
  ATTENDANCE: "Attendance bonus",
  SIGNUP: "Signup bonus",
  REVENUE_SHARE: "Revenue share",
};

// ── Reconcile ───────────────────────────────────────────────────────────────

/** A stored line, as the reconciler needs it. */
export type ExistingLine = LineKey & {
  id: string;
  workDate: string;
  description: string;
  units: number;
  rateCents: number | null;
  amountCents: number | null;
  rateSource: string;
  planId: string | null;
  planName: string | null;
  planAmountCents: number | null;
  overrideReason: string | null;
  overrideByUserId: string | null;
  overrideAt: Date | null;
  status: string;
  reviewReason: string | null;
  voidReason: string | null;
  payoutId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
};

/** A line nobody may change any more: paid, or attached to a payout (even a pending one). */
export function lineLocked(l: Pick<ExistingLine, "status" | "payoutId">): boolean {
  return l.status === "PAID" || l.payoutId !== null;
}
/** A line a person added (bonus / adjustment): the generator never touches it. */
export const lineIsManual = (l: Pick<ExistingLine, "rateSource">) => l.rateSource === "MANUAL";
/** Class-day overrides live on the assignment; other lines carry their own. */
const lineOwnsOverride = (l: Pick<ExistingLine, "rateSource" | "sourceType">) => l.rateSource === "OVERRIDE" && l.sourceType !== "CLASS_SESSION";

export type LinePatch = Partial<Omit<DesiredLine, keyof LineKey>> & { voidReason?: string | null; status?: LineStatus };
export type ReconcilePlan = {
  create: DesiredLine[];
  update: { id: string; data: LinePatch }[];
  /** Generated lines that should no longer pay. */
  voids: { id: string; reason: string }[];
};

const sameDate = (a: Date | null, b: Date | null) => (a === null || b === null ? a === b : a.getTime() === b.getTime());

/**
 * Bring stored lines in line with `desired`. Touches only generated lines that
 * are not locked: a paid line, a line on a payout and a hand-made line are
 * never in the result. `existing` must be limited to the same window the
 * desired lines were planned for — a line outside it would look unwanted.
 */
export function reconcileLines(
  desired: readonly DesiredLine[],
  existing: readonly ExistingLine[],
  unpaidReasons: ReadonlyMap<string, string> = new Map(),
): ReconcilePlan {
  const out: ReconcilePlan = { create: [], update: [], voids: [] };
  const byKey = new Map(existing.map((l) => [lineKey(l), l]));
  const wanted = new Set<string>();

  for (const d of desired) {
    const k = lineKey(d);
    wanted.add(k);
    const cur = byKey.get(k);
    if (!cur) { out.create.push(d); continue; }
    if (lineLocked(cur) || lineIsManual(cur)) continue;
    const data: LinePatch = {};
    const keepOwnOverride = lineOwnsOverride(cur) && cur.status !== "VOID";
    const want: DesiredLine = keepOwnOverride
      ? {
          ...d, amountCents: cur.amountCents, rateSource: "OVERRIDE", status: "ESTIMATED", reviewReason: null,
          overrideReason: cur.overrideReason, overrideByUserId: cur.overrideByUserId, overrideAt: cur.overrideAt,
        }
      : d;
    if (cur.workDate !== want.workDate) data.workDate = want.workDate;
    if (cur.description !== want.description) data.description = want.description;
    if (Math.abs(cur.units - want.units) > 0.00005) data.units = want.units;
    if (cur.rateCents !== want.rateCents) data.rateCents = want.rateCents;
    if (cur.amountCents !== want.amountCents) data.amountCents = want.amountCents;
    if (cur.rateSource !== want.rateSource) data.rateSource = want.rateSource;
    if (cur.planId !== want.planId) data.planId = want.planId;
    if (cur.planName !== want.planName) data.planName = want.planName;
    if (cur.planAmountCents !== want.planAmountCents) data.planAmountCents = want.planAmountCents;
    if (cur.overrideReason !== want.overrideReason) data.overrideReason = want.overrideReason;
    if (cur.overrideByUserId !== want.overrideByUserId) data.overrideByUserId = want.overrideByUserId;
    if (!sameDate(cur.overrideAt, want.overrideAt)) data.overrideAt = want.overrideAt;
    if (cur.status !== want.status) data.status = want.status;
    if (cur.reviewReason !== want.reviewReason) data.reviewReason = want.reviewReason;
    if (cur.periodStart !== want.periodStart) data.periodStart = want.periodStart;
    if (cur.periodEnd !== want.periodEnd) data.periodEnd = want.periodEnd;
    if (cur.status === "VOID") data.voidReason = null; // wanted again
    if (Object.keys(data).length > 0) out.update.push({ id: cur.id, data });
  }

  for (const cur of existing) {
    if (wanted.has(lineKey(cur))) continue;
    if (lineLocked(cur) || lineIsManual(cur) || cur.status === "VOID") continue;
    const reason = cur.sourceType === "CLASS_SESSION"
      ? unpaidReasons.get(cur.sourceId) ?? "This class day is no longer on the schedule for this coach"
      : cur.sourceType === "SALARY"
        ? "The salary plan is no longer in force for this pay period"
        : cur.sourceType === "EVENT"
          ? "No longer payable from a per-event plan"
          : cur.sourceType === "PRIVATE_LESSON"
            ? "The private lesson was cancelled, moved, or given to another coach"
          : "The bonus no longer applies";
    out.voids.push({ id: cur.id, reason });
  }
  return out;
}

// ── Reading the ledger ──────────────────────────────────────────────────────

export type LedgerLineView = {
  id: string;
  userId: string;
  sourceType: string;
  sourceId: string;
  component: string;
  workDate: string;
  description: string;
  units: number;
  rateCents: number | null;
  amountCents: number | null;
  rateSource: string;
  planId: string | null;
  planName: string | null;
  planAmountCents: number | null;
  overrideReason: string | null;
  overrideByName: string | null;
  status: string;
  reviewReason: string | null;
  voidReason: string | null;
  payoutId: string | null;
  payoutStatus: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  /** For a substitute's class day: what the coach they covered would have been paid by their plan. */
  matchRegular: { name: string; cents: number } | null;
};

/** What a line counts as, for totals and for what can be done to it. */
export function lineBucket(l: Pick<LedgerLineView, "status" | "payoutId" | "payoutStatus">): "PAID" | "ON_PAYOUT" | "REVIEW" | "UNPAID" | "VOID" {
  if (l.status === "VOID") return "VOID";
  if (l.status === "PAID") return "PAID";
  if (l.payoutId) return "ON_PAYOUT";
  if (l.status === "NEEDS_REVIEW") return "REVIEW";
  return "UNPAID";
}

export type LedgerTotals = { unpaidCents: number; onPayoutCents: number; paidCents: number; reviewCount: number; payableLineIds: string[] };

export function summarizeLines(lines: readonly LedgerLineView[]): LedgerTotals {
  const t: LedgerTotals = { unpaidCents: 0, onPayoutCents: 0, paidCents: 0, reviewCount: 0, payableLineIds: [] };
  for (const l of lines) {
    const b = lineBucket(l);
    if (b === "REVIEW") t.reviewCount++;
    else if (b === "UNPAID") { t.unpaidCents += l.amountCents ?? 0; t.payableLineIds.push(l.id); }
    else if (b === "ON_PAYOUT") t.onPayoutCents += l.amountCents ?? 0;
    else if (b === "PAID") t.paidCents += l.amountCents ?? 0;
  }
  return t;
}

/** "1 × $25.00", "1.5 hr × $30.00", or "" for a line with nothing to multiply. */
export function lineMath(l: Pick<LedgerLineView, "units" | "rateCents" | "sourceType" | "component" | "rateSource">): string {
  if (l.rateSource !== "PLAN" || l.rateCents === null) return "";
  if (l.sourceType === "SALARY" || l.sourceType === "BONUS") return "";
  if (l.component.startsWith("BONUS:")) return `${l.units} × ${fmtCents(l.rateCents)}`;
  if (l.rateCents === 0) return "";
  return Math.abs(l.units - 1) < 0.00005 ? fmtCents(l.rateCents) : `${l.units} hr × ${fmtCents(l.rateCents)}`;
}

export const SOURCE_LABELS: Record<string, string> = {
  CLASS_SESSION: "Class", EVENT: "Event", PRIVATE_LESSON: "Private lesson", SALARY: "Salary", BONUS: "Bonus", ADJUSTMENT: "Adjustment",
};

// ── Plan input: validation + words ──────────────────────────────────────────

export type PlanInput = {
  name: string;
  baseType: PlanBaseType;
  baseAmount: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  baseScopes: PlanScope[];
  bonuses: {
    id?: string | null;
    bonusType: PlanBonusType;
    amount: number;
    minThreshold: number | null;
    maxThreshold: number | null;
    countPer: CountPer;
    scopes: PlanScope[];
  }[];
};

/** Tidy a plan the way it is stored; returns the first problem in plain words, or null. */
export function normalizePlanInput(raw: PlanInput): { plan: PlanInput; error: string | null } {
  const name = raw.name.trim().slice(0, 80);
  const allowedBase: string[] =
    raw.baseType === "PER_CLASS" || raw.baseType === "HOURLY" ? ["CLASS", "ROLE"] : raw.baseType === "PER_EVENT" ? ["EVENT", "EVENT_TYPE"] : [];
  const seen = new Set<string>();
  const baseScopes = raw.baseScopes
    .map((s) => ({ scopeType: s.scopeType, scopeId: s.scopeType === "ROLE" ? s.scopeId.trim().slice(0, 60) : s.scopeId }))
    .filter((s) => allowedBase.includes(s.scopeType) && s.scopeId !== "")
    .filter((s) => {
      const k = `${s.scopeType}|${s.scopeType === "ROLE" ? roleKey(s.scopeId) : s.scopeId}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  const bonuses = raw.bonuses.map((b) => {
    const min = b.minThreshold && b.minThreshold > 0 ? b.minThreshold : null;
    const max = b.maxThreshold && b.maxThreshold > 0 ? b.maxThreshold : null;
    return {
      id: b.id ?? null, bonusType: b.bonusType, amount: b.amount, minThreshold: min, maxThreshold: max,
      // Only an attendance bonus can be counted per class day.
      countPer: (b.bonusType === "ATTENDANCE" && b.countPer === "CLASS_DAY" ? "CLASS_DAY" : "PERIOD") as CountPer,
      scopes: b.scopes.filter((s) => (BONUS_SCOPE_TYPES as readonly string[]).includes(s.scopeType) && s.scopeId !== ""),
    };
  });
  const plan: PlanInput = { ...raw, name, baseScopes, bonuses, effectiveTo: raw.effectiveTo || null };
  let error: string | null = null;
  if (!name) error = "Give the pay plan a name.";
  else if (!isYmd(raw.effectiveFrom)) error = "Choose the date the plan starts.";
  else if (plan.effectiveTo !== null && !isYmd(plan.effectiveTo)) error = "The end date isn't a valid date.";
  else if (plan.effectiveTo !== null && plan.effectiveTo < raw.effectiveFrom) error = "The end date is before the start date.";
  else if (!Number.isFinite(raw.baseAmount) || raw.baseAmount < 0) error = "Enter the amount.";
  else if (bonuses.some((b) => !Number.isFinite(b.amount) || b.amount < 0)) error = "Enter an amount for each bonus.";
  else if (bonuses.some((b) => b.bonusType === "REVENUE_SHARE" && b.amount > 100)) error = "A revenue share can't be more than 100%.";
  else if (bonuses.some((b) => b.minThreshold !== null && b.maxThreshold !== null && b.minThreshold >= b.maxThreshold)) {
    error = "A bonus's \"starts after\" count must be less than its \"caps at\" count.";
  }
  return { plan, error };
}

export type ScopeNames = {
  classes: Record<string, string>;
  events?: Record<string, string>;
  memberships?: Record<string, string>;
  lessonTypes?: Record<string, string>;
};

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
const joinNames = (list: string[]) => (list.length <= 3 ? list.join(", ") : `${list.slice(0, 3).join(", ")} +${list.length - 3} more`);

/** What a plan's base rate applies to, in words: "Jr Frogs · Lead Coach", "Any class". */
export function baseScopeWords(plan: Pick<LedgerPlan, "baseType" | "baseScopes">, names: ScopeNames): string {
  if (plan.baseType === "SALARY") return "Every pay period";
  if (plan.baseType === "PER_EVENT") {
    const ev = ids(plan.baseScopes, "EVENT").map((id) => names.events?.[id] ?? "an event");
    const ty = ids(plan.baseScopes, "EVENT_TYPE").map((t) => EVENT_TYPE_LABELS[t] ?? t);
    const all = [...ev, ...ty];
    return all.length ? joinNames(all) : "Any event";
  }
  const cl = ids(plan.baseScopes, "CLASS").map((id) => names.classes[id] ?? "a class that was removed");
  const ro = ids(plan.baseScopes, "ROLE");
  const c = cl.length ? joinNames(cl) : "Any class";
  return ro.length ? `${c} · as ${joinNames(ro)}` : c;
}

/** Plain lines describing a plan: the base, then each bonus. */
export function planSummaryLines(plan: Pick<LedgerPlan, "baseType" | "baseAmount" | "baseScopes" | "bonuses">, names: ScopeNames): string[] {
  const meta = PLAN_BASE_LABELS[plan.baseType as PlanBaseType];
  const lines = [`${meta?.label ?? plan.baseType} · ${usd(plan.baseAmount)}${meta?.unit ?? ""} · ${baseScopeWords(plan, names)}`];
  for (const b of plan.bonuses) {
    const amt = b.bonusType === "REVENUE_SHARE" ? `${b.amount}%` : usd(b.amount);
    const unit = b.bonusType === "ATTENDANCE" ? "per attendee" : b.bonusType === "SIGNUP" ? "per signup" : "of revenue";
    const thr =
      b.minThreshold !== null && b.maxThreshold !== null ? `, after ${b.minThreshold} up to ${b.maxThreshold}`
        : b.minThreshold !== null ? `, after ${b.minThreshold}` : b.maxThreshold !== null ? `, up to ${b.maxThreshold}` : "";
    const per = b.bonusType === "ATTENDANCE" ? (b.countPer === "CLASS_DAY" ? ", counted each class day" : ", counted over the pay period") : "";
    lines.push(`${BONUS_LABELS[b.bonusType] ?? "Bonus"} · ${amt} ${unit}${thr}${per}`);
  }
  return lines;
}

/** Things the owner should know about a coach's pay setup (shown on Payroll). */
export function planWarnings(args: { plans: readonly LedgerPlan[]; hasSchedule: boolean; todayYmd: string }): string[] {
  const active = args.plans.filter((p) => planActiveOn(p, args.todayYmd));
  const out: string[] = [];
  if (!args.hasSchedule) {
    if (active.some((p) => p.baseType === "SALARY")) out.push("Has a salary plan but no pay schedule — salary is paid per pay period, so it can't be worked out until a pay schedule is set.");
    if (active.some((p) => p.bonuses.some((b) => !(b.bonusType === "ATTENDANCE" && b.countPer === "CLASS_DAY")))) {
      out.push("Has a bonus counted over the pay period but no pay schedule — that bonus can't be worked out until a pay schedule is set (an attendance bonus can be switched to count each class day instead).");
    }
  }
  if (active.filter((p) => p.baseType === "SALARY").length > 1) out.push("Has more than one salary plan in force — each one pays every pay period.");
  return out;
}


// ── CSV export ──────────────────────────────────────────────────────────────

/** One pay line, flattened for accounting. */
export type LedgerExportRow = {
  coach: string;
  workDate: string;
  sourceType: string;
  description: string;
  role: string | null;
  planName: string | null;
  rateCents: number | null;
  units: number;
  planAmountCents: number | null;
  amountCents: number | null;
  rateSource: string;
  reason: string | null;
  status: string;
  payoutId: string | null;
  payoutStatus: string | null;
  payoutDate: string | null;
  payoutMethod: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  lineId: string;
};

export const EXPORT_HEADERS = [
  "Coach", "Date", "Type", "Item", "Role", "Pay plan", "Rate", "Units", "Calculated amount", "Override / adjustment",
  "Reason", "Final amount", "Status", "Payout status", "Payout date", "Payout method", "Pay period start", "Pay period end", "Line ID",
] as const;

const money = (cents: number | null | undefined) => (cents === null || cents === undefined ? "" : (cents / 100).toFixed(2));
const STATUS_WORDS: Record<string, string> = { UNPAID: "Unpaid", REVIEW: "Needs review", ON_PAYOUT: "On a pending payout", PAID: "Paid", VOID: "Not payable" };

/** A cell that a spreadsheet will not run as a formula, quoted for CSV. */
export function csvCell(value: string | number | null | undefined): string {
  let v = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v)) v = `'${v}`;
  return `"${v.replace(/"/g, '""')}"`;
}

export function exportCells(r: LedgerExportRow): string[] {
  const bucket = lineBucket({ status: r.status, payoutId: r.payoutId, payoutStatus: r.payoutStatus });
  const changed = r.rateSource === "OVERRIDE" || r.rateSource === "MANUAL";
  return [
    r.coach,
    r.workDate,
    SOURCE_LABELS[r.sourceType] ?? r.sourceType,
    r.description,
    r.role ?? "",
    r.rateSource === "MANUAL" ? "Added by hand" : r.planName ?? "",
    r.rateSource === "MANUAL" ? "" : money(r.rateCents),
    r.rateSource === "MANUAL" ? "" : String(r.units),
    r.rateSource === "MANUAL" ? "" : money(r.planAmountCents),
    changed ? money(r.amountCents) : "",
    r.reason ?? "",
    bucket === "VOID" ? "0.00" : money(r.amountCents),
    STATUS_WORDS[bucket],
    r.payoutStatus ? r.payoutStatus.charAt(0) + r.payoutStatus.slice(1).toLowerCase() : "",
    r.payoutDate ?? "",
    r.payoutMethod ? r.payoutMethod.charAt(0) + r.payoutMethod.slice(1).toLowerCase() : "",
    r.periodStart ?? "",
    r.periodEnd ?? "",
    r.lineId,
  ];
}

/** The whole file: a header row, one row per pay line, CRLF line ends (what Excel expects). */
export function ledgerCsv(rows: readonly LedgerExportRow[]): string {
  const lines = [EXPORT_HEADERS.map(csvCell).join(",")];
  for (const r of rows) lines.push(exportCells(r).map(csvCell).join(","));
  return lines.join("\r\n") + "\r\n";
}
