// Pay plan editor — the form's shape and the two conversions either side of it
// (stored plan → form, form → what the API takes). Pure; covered by
// scripts/pay-ledger-tests.ts. Numbers are strings in the form so a half-typed
// amount ("12.") survives being in the box.
import type { CountPer, LedgerPlan, PlanBaseType, PlanBonusType, PlanInput, PlanScope } from "../../../lib/payLedger";

export type BonusFormRow = {
  id: string | null;
  bonusType: PlanBonusType;
  amount: string;
  minThreshold: string;
  maxThreshold: string;
  countPer: CountPer;
  scopes: PlanScope[];
};

export type PlanForm = {
  name: string;
  baseType: PlanBaseType;
  baseAmount: string;
  effectiveFrom: string;
  effectiveTo: string;
  classIds: string[];
  roles: string[];
  eventTypes: string[];
  eventIds: string[];
  bonuses: BonusFormRow[];
};

export function emptyPlanForm(todayYmd: string): PlanForm {
  return {
    name: "", baseType: "PER_CLASS", baseAmount: "", effectiveFrom: todayYmd, effectiveTo: "",
    classIds: [], roles: [], eventTypes: [], eventIds: [], bonuses: [],
  };
}

const of = (scopes: readonly PlanScope[], t: string) => scopes.filter((s) => s.scopeType === t).map((s) => s.scopeId);

export function planFormFromPlan(p: LedgerPlan): PlanForm {
  return {
    name: p.name,
    baseType: p.baseType as PlanBaseType,
    baseAmount: String(p.baseAmount),
    effectiveFrom: p.effectiveFrom,
    effectiveTo: p.effectiveTo ?? "",
    classIds: of(p.baseScopes, "CLASS"),
    roles: of(p.baseScopes, "ROLE"),
    eventTypes: of(p.baseScopes, "EVENT_TYPE"),
    eventIds: of(p.baseScopes, "EVENT"),
    bonuses: p.bonuses.map((b) => ({
      id: b.id,
      bonusType: b.bonusType as PlanBonusType,
      amount: String(b.amount),
      minThreshold: b.minThreshold != null ? String(b.minThreshold) : "",
      maxThreshold: b.maxThreshold != null ? String(b.maxThreshold) : "",
      countPer: (b.countPer === "CLASS_DAY" ? "CLASS_DAY" : "PERIOD") as CountPer,
      scopes: b.scopes,
    })),
  };
}

const int = (s: string): number | null => (s.trim() === "" ? null : Math.max(0, parseInt(s, 10) || 0));

/** What the form would save. Scopes that don't belong to the chosen base type are left out. */
export function planInputFromForm(f: PlanForm): PlanInput {
  const perClass = f.baseType === "PER_CLASS" || f.baseType === "HOURLY";
  const perEvent = f.baseType === "PER_EVENT";
  const baseScopes: PlanScope[] = [
    ...(perClass ? f.classIds.map((id) => ({ scopeType: "CLASS", scopeId: id })) : []),
    ...(perClass ? f.roles.map((r) => ({ scopeType: "ROLE", scopeId: r })) : []),
    ...(perEvent ? f.eventTypes.map((t) => ({ scopeType: "EVENT_TYPE", scopeId: t })) : []),
    ...(perEvent ? f.eventIds.map((id) => ({ scopeType: "EVENT", scopeId: id })) : []),
  ];
  return {
    name: f.name.trim(),
    baseType: f.baseType,
    baseAmount: parseFloat(f.baseAmount) || 0,
    effectiveFrom: f.effectiveFrom,
    effectiveTo: f.effectiveTo.trim() === "" ? null : f.effectiveTo,
    baseScopes,
    bonuses: f.bonuses
      // A bonus row with no amount is an empty row that was added and not filled in.
      .filter((b) => b.amount.trim() !== "")
      .map((b) => ({
        id: b.id,
        bonusType: b.bonusType,
        amount: parseFloat(b.amount) || 0,
        minThreshold: int(b.minThreshold),
        maxThreshold: int(b.maxThreshold),
        countPer: b.bonusType === "ATTENDANCE" ? b.countPer : "PERIOD",
        scopes: b.scopes,
      })),
  };
}

export function emptyBonusRow(type: PlanBonusType): BonusFormRow {
  return { id: null, bonusType: type, amount: "", minThreshold: "", maxThreshold: "", countPer: type === "ATTENDANCE" ? "CLASS_DAY" : "PERIOD", scopes: [] };
}

/** Dollars typed in a box → cents, or null when it is not a number. */
export function centsFromText(text: string): number | null {
  const t = text.trim().replace(/[$,]/g, "");
  if (t === "" || !/^-?\d*(\.\d{0,2})?$/.test(t) || t === "-" || t === "." || t === "-.") return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
