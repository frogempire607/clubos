// Modular compensation engine.
//
// A staff member's pay = ONE base component + any number of stackable bonuses,
// each optionally scoped to specific classes / events / memberships / private
// lesson types. This module is pure: the caller fetches the period's raw data
// and passes a `CompContext`; we return a structured payout breakdown that the
// payroll API and preview UI render directly.

export type BaseType = "SALARY" | "PER_CLASS" | "HOURLY";
export type BonusType = "ATTENDANCE" | "SIGNUP" | "REVENUE_SHARE";
export type ScopeType = "CLASS" | "EVENT" | "MEMBERSHIP" | "PRIVATE_LESSON_TYPE";

export type Scope = { scopeType: ScopeType; scopeId: string };

export type CompPlan = {
  baseType: BaseType;
  baseAmount: number;
  // CLASS scopes attached to the base component (bonusId = null). Empty = all
  // classes this staff is assigned to.
  baseScopeClassIds: string[];
  bonuses: {
    id: string;
    bonusType: BonusType;
    amount: number; // $ for ATTENDANCE/SIGNUP, percentage for REVENUE_SHARE
    scopes: Scope[]; // empty = applies to everything this staff is tied to
    // Threshold counts (apply to attendance count / signup count). For
    // REVENUE_SHARE these still gate the count of qualifying items.
    minThreshold?: number | null; // null = no lower bound
    maxThreshold?: number | null; // null = no upper bound
  }[];
};

export type TaughtSession = {
  sessionId: string;
  classId: string;
  className: string;
  date: string; // ISO
  minutes: number;
  dropInPrice: number; // 0 if none configured
};

export type CompContext = {
  // Class sessions in range whose RecurringClass.assignedStaffIds includes this staff.
  taughtSessions: TaughtSession[];
  // Attendance rows in range. classId derived from the session's parent class.
  attendance: { classId: string | null; eventId: string | null; status: string }[];
  // DROP_IN (paid) attendance in range, with the class's drop-in price, keyed by classId.
  paidDropIns: { classId: string; price: number }[];
  // Member subscriptions whose createdAt falls in range.
  subscriptions: { membershipId: string; price: number }[];
  // Event registrations whose createdAt falls in range.
  eventRegistrations: { eventId: string; amountPaid: number; status: string }[];
  // Event ids this staff is assigned to (EventStaffAssignment).
  assignedEventIds: string[];
  // This coach's COMPLETED private bookings in range.
  privateBookings: { lessonTypeId: string; pricePaid: number }[];
};

const ATTENDED = new Set(["PRESENT", "LATE", "DROP_IN", "TRIAL"]);

function scopeIds(scopes: Scope[], type: ScopeType): string[] {
  return scopes.filter((s) => s.scopeType === type).map((s) => s.scopeId);
}

// Apply min/max thresholds to a count. Items at or below `min` are excluded,
// items above `max` are excluded. Returns the number of qualifying items.
//   payableCount(15, 10, null)  → 5   (athletes 11-15)
//   payableCount(30, 10, 25)    → 15  (athletes 11-25)
//   payableCount(8,  10, null)  → 0   (below threshold)
//   payableCount(15, null, 10)  → 10  (cap at 10)
function payableCount(count: number, min?: number | null, max?: number | null): number {
  const lo = min != null && min > 0 ? min : 0;
  const hi = max != null && max > 0 ? Math.min(count, max) : count;
  return Math.max(0, hi - lo);
}

function thresholdLabel(min?: number | null, max?: number | null): string {
  if (min == null && max == null) return "";
  if (min != null && max != null) return ` (after ${min}, up to ${max})`;
  if (min != null) return ` (after ${min})`;
  return ` (cap ${max})`;
}

export type PayoutBreakdown = {
  base: { type: BaseType; amount: number; detail: string; pay: number };
  bonuses: { id: string; type: BonusType; rate: number; basisLabel: string; basisCount: number; pay: number }[];
  classesCoached: number;
  hoursCoached: number;
  attendanceTotal: number;
  signupTotal: number;
  total: number;
};

export function computeStaffPayout(plan: CompPlan, ctx: CompContext): PayoutBreakdown {
  // ── Class sessions, optionally restricted to the base component's CLASS scope.
  const baseSessions = plan.baseScopeClassIds.length
    ? ctx.taughtSessions.filter((s) => plan.baseScopeClassIds.includes(s.classId))
    : ctx.taughtSessions;

  const classesCoached = baseSessions.length;
  const hoursCoached = +(baseSessions.reduce((a, s) => a + s.minutes, 0) / 60).toFixed(2);

  // ── Base component ──────────────────────────────────────────────────────────
  let base: PayoutBreakdown["base"];
  if (plan.baseType === "SALARY") {
    base = { type: "SALARY", amount: plan.baseAmount, detail: "Fixed for the period", pay: +plan.baseAmount.toFixed(2) };
  } else if (plan.baseType === "PER_CLASS") {
    base = {
      type: "PER_CLASS",
      amount: plan.baseAmount,
      detail: `${classesCoached} class${classesCoached === 1 ? "" : "es"} × $${plan.baseAmount.toFixed(2)}`,
      pay: +(plan.baseAmount * classesCoached).toFixed(2),
    };
  } else {
    base = {
      type: "HOURLY",
      amount: plan.baseAmount,
      detail: `${hoursCoached.toFixed(2)} hr × $${plan.baseAmount.toFixed(2)}`,
      pay: +(plan.baseAmount * hoursCoached).toFixed(2),
    };
  }

  // ── Bonuses (stack) ─────────────────────────────────────────────────────────
  let attendanceTotal = 0;
  let signupTotal = 0;
  const bonuses: PayoutBreakdown["bonuses"] = plan.bonuses.map((b) => {
    if (b.bonusType === "ATTENDANCE") {
      const classScope = scopeIds(b.scopes, "CLASS");
      const eventScope = scopeIds(b.scopes, "EVENT");
      const hasScope = classScope.length > 0 || eventScope.length > 0;
      const rawCount = ctx.attendance.filter((a) => {
        if (!ATTENDED.has(a.status)) return false;
        if (!hasScope) {
          // Default: attendance on classes this staff taught, or assigned events.
          if (a.classId) return ctx.taughtSessions.some((s) => s.classId === a.classId);
          if (a.eventId) return ctx.assignedEventIds.includes(a.eventId);
          return false;
        }
        if (a.classId && classScope.includes(a.classId)) return true;
        if (a.eventId && eventScope.includes(a.eventId)) return true;
        return false;
      }).length;
      const count = payableCount(rawCount, b.minThreshold, b.maxThreshold);
      attendanceTotal += count;
      const thr = thresholdLabel(b.minThreshold, b.maxThreshold);
      return {
        id: b.id, type: b.bonusType, rate: b.amount,
        basisLabel: `${count}/${rawCount} attendance${thr} × $${b.amount.toFixed(2)}`,
        basisCount: count, pay: +(count * b.amount).toFixed(2),
      };
    }

    if (b.bonusType === "SIGNUP") {
      const membershipScope = scopeIds(b.scopes, "MEMBERSHIP");
      const classScope = scopeIds(b.scopes, "CLASS");
      const hasScope = membershipScope.length > 0 || classScope.length > 0;

      let rawCount = 0;
      if (!hasScope) {
        rawCount += ctx.subscriptions.length;
        rawCount += ctx.paidDropIns.filter((d) =>
          ctx.taughtSessions.some((s) => s.classId === d.classId)
        ).length;
      } else {
        if (membershipScope.length) {
          rawCount += ctx.subscriptions.filter((s) => membershipScope.includes(s.membershipId)).length;
        }
        if (classScope.length) {
          rawCount += ctx.paidDropIns.filter((d) => classScope.includes(d.classId)).length;
        }
      }
      const count = payableCount(rawCount, b.minThreshold, b.maxThreshold);
      signupTotal += count;
      const thr = thresholdLabel(b.minThreshold, b.maxThreshold);
      return {
        id: b.id, type: b.bonusType, rate: b.amount,
        basisLabel: `${count}/${rawCount} signup${rawCount === 1 ? "" : "s"}${thr} × $${b.amount.toFixed(2)}`,
        basisCount: count, pay: +(count * b.amount).toFixed(2),
      };
    }

    // REVENUE_SHARE — amount is a percentage.
    const classScope = scopeIds(b.scopes, "CLASS");
    const eventScope = scopeIds(b.scopes, "EVENT");
    const membershipScope = scopeIds(b.scopes, "MEMBERSHIP");
    const privateScope = scopeIds(b.scopes, "PRIVATE_LESSON_TYPE");
    const noScope = b.scopes.length === 0;

    // Collect qualifying items with their dollar value, then apply thresholds
    // on item count (sorted by date if available — we just rely on collection
    // order which is fine for an in-range query).
    type Item = { value: number };
    const items: Item[] = [];

    if (noScope || privateScope.length) {
      for (const p of ctx.privateBookings) {
        if (!privateScope.length || privateScope.includes(p.lessonTypeId)) {
          items.push({ value: p.pricePaid });
        }
      }
    }
    if (noScope || classScope.length) {
      for (const d of ctx.paidDropIns) {
        const allowed = classScope.length
          ? classScope.includes(d.classId)
          : ctx.taughtSessions.some((s) => s.classId === d.classId);
        if (allowed) items.push({ value: d.price });
      }
    }
    if (noScope || eventScope.length) {
      for (const r of ctx.eventRegistrations) {
        if (r.status === "CANCELED") continue;
        const allowed = eventScope.length
          ? eventScope.includes(r.eventId)
          : ctx.assignedEventIds.includes(r.eventId);
        if (allowed) items.push({ value: r.amountPaid });
      }
    }
    if (membershipScope.length) {
      for (const s of ctx.subscriptions) {
        if (membershipScope.includes(s.membershipId)) items.push({ value: s.price });
      }
    }

    const totalCount = items.length;
    // Threshold-trim: drop the first `min` items, keep through item `max`.
    const lo = b.minThreshold != null && b.minThreshold > 0 ? b.minThreshold : 0;
    const hi = b.maxThreshold != null && b.maxThreshold > 0 ? b.maxThreshold : totalCount;
    const eligible = items.slice(lo, hi);
    const revenue = eligible.reduce((a, x) => a + x.value, 0);
    const pay = +((revenue * b.amount) / 100).toFixed(2);
    const thr = thresholdLabel(b.minThreshold, b.maxThreshold);
    return {
      id: b.id, type: b.bonusType, rate: b.amount,
      basisLabel: `${b.amount}% of $${revenue.toFixed(2)}${thr ? ` from ${eligible.length}/${totalCount} items` : ""}`,
      basisCount: +revenue.toFixed(2), pay,
    };
  });

  const total = +(base.pay + bonuses.reduce((a, x) => a + x.pay, 0)).toFixed(2);

  return {
    base,
    bonuses,
    classesCoached,
    hoursCoached,
    attendanceTotal,
    signupTotal,
    total,
  };
}
