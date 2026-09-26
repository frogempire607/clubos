// B21 — Pay tab helpers, pure. The plan model itself (draft ⇄ API) lives in
// lib/staffCompensationDraft.ts and is unchanged; this file only adds the
// switch-per-bonus-type view of it. Covered by scripts/staff-access-ui-tests.ts.
import type { BonusDraft, CompDraft, ScopeType } from "../../../lib/staffCompensationDraft";

export type BonusType = BonusDraft["bonusType"];
export const BONUS_TYPES: BonusType[] = ["ATTENDANCE", "SIGNUP", "REVENUE_SHARE"];

export const BASE_META: Record<CompDraft["baseType"], { label: string; desc: string; amountLabel: string; unit: string }> = {
  SALARY: { label: "Salary (monthly)", desc: "The same amount every month.", amountLabel: "Monthly amount", unit: "/mo" },
  PER_CLASS: { label: "Per class", desc: "Paid for each class taught.", amountLabel: "Amount per class", unit: " per class" },
  HOURLY: { label: "Hourly", desc: "Paid for hours on the schedule.", amountLabel: "Hourly rate", unit: "/hr" },
};

export const BONUS_META: Record<BonusType, { label: string; desc: string; amountLabel: string; percent: boolean; unit: string }> = {
  ATTENDANCE: {
    label: "Attendance bonus",
    desc: "An amount for each member attending the selected classes or events, so growth and retention raise pay.",
    amountLabel: "Amount per attendee",
    percent: false,
    unit: "per attendee",
  },
  SIGNUP: {
    label: "Signup bonus",
    desc: "An amount for each qualifying signup or purchase, paid in that payroll period.",
    amountLabel: "Amount per signup",
    percent: false,
    unit: "per signup",
  },
  REVENUE_SHARE: {
    label: "Revenue share",
    desc: "A percentage of the revenue from the assigned scope — classes, events, memberships or private lesson types.",
    amountLabel: "Percent of revenue",
    percent: true,
    unit: "of revenue",
  },
};

/** What each bonus type can be scoped to (same as the old builder's BONUS_SCOPES). */
export const BONUS_SCOPES: Record<BonusType, ScopeType[]> = {
  ATTENDANCE: ["CLASS", "EVENT"],
  SIGNUP: ["CLASS", "MEMBERSHIP"],
  REVENUE_SHARE: ["CLASS", "EVENT", "MEMBERSHIP", "PRIVATE_LESSON_TYPE"],
};

/** Indexes (into draft.bonuses) of every bonus of this type — a plan may hold more than one. */
export function bonusIndexes(d: CompDraft, type: BonusType): number[] {
  const out: number[] = [];
  d.bonuses.forEach((b, i) => {
    if (b.bonusType === type) out.push(i);
  });
  return out;
}

export function emptyBonus(type: BonusType): BonusDraft {
  return { bonusType: type, amount: "", scopes: [], minThreshold: "", maxThreshold: "" };
}

/** Switch on → one empty row of that type (if none yet). Switch off → remove every row of that type. */
export function setBonusTypeOn(d: CompDraft, type: BonusType, on: boolean): CompDraft {
  if (on) {
    if (d.bonuses.some((b) => b.bonusType === type)) return d;
    return { ...d, bonuses: [...d.bonuses, emptyBonus(type)] };
  }
  return { ...d, bonuses: d.bonuses.filter((b) => b.bonusType !== type) };
}

/** How many parts of the plan differ from the saved one: the base counts as one, each bonus type as one. */
export function payChangeCount(saved: CompDraft, draft: CompDraft): number {
  let n = 0;
  const baseSame =
    saved.baseType === draft.baseType &&
    saved.baseAmount === draft.baseAmount &&
    JSON.stringify(saved.baseScopes) === JSON.stringify(draft.baseScopes);
  if (!baseSame) n += 1;
  for (const t of BONUS_TYPES) {
    const a = saved.bonuses.filter((b) => b.bonusType === t);
    const b = draft.bonuses.filter((x) => x.bonusType === t);
    if (JSON.stringify(a) !== JSON.stringify(b)) n += 1;
  }
  return n;
}

const usd = (v: string) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}` : "$0";
};

/** Plain lines describing the plan as shown ("Salary · $1,700/mo", "Signup bonus · $25 per signup"). */
export function planSummaryLines(d: CompDraft): string[] {
  const lines = [`${BASE_META[d.baseType].label.replace(" (monthly)", "")} · ${usd(d.baseAmount)}${BASE_META[d.baseType].unit}`];
  for (const b of d.bonuses) {
    const m = BONUS_META[b.bonusType];
    if (b.amount.trim() === "") continue; // compPayload drops these on save
    const amt = m.percent ? `${parseFloat(b.amount) || 0}%` : usd(b.amount);
    lines.push(`${m.label} · ${amt} ${m.unit}${b.scopes.length ? ` (${b.scopes.length} selected)` : ""}`);
  }
  return lines;
}
