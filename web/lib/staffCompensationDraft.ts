// The compensation plan as the Edit Staff form holds it, and the two
// conversions either side of it.
//
// Extracted from app/dashboard/staff/page.tsx on 2026-09-26, when the modal's
// four independent save boundaries became one. These functions are the reason
// that change is safe to make, so they are testable on their own rather than
// buried in a 1,400-line client component:
//
//   · compDraftFromPlan  API shape → form shape (numbers become strings)
//   · compPayload        form shape → API shape (strings become numbers)
//
// Two properties matter, and scripts/staff-compensation-draft-tests.ts asserts
// both:
//
//   ROUND TRIP    compPayload(compDraftFromPlan(plan)) must equal `plan`. The
//                 modal now writes the plan as part of one save, so an
//                 unfaithful round trip would rewrite a plan the owner never
//                 touched — turning a display bug into data loss.
//
//   DIRTY BASE    compDraftFromPlan(null) must equal the draft you get from a
//                 plan the API would return for a staff member with no plan.
//                 The dirty check is a JSON comparison against the loaded
//                 draft, so if these differ, merely OPENING the modal on
//                 somebody with no plan reads as an unsaved edit and Cancel
//                 warns about changes nobody made.

export type ScopeType = "CLASS" | "EVENT" | "MEMBERSHIP" | "PRIVATE_LESSON_TYPE";
export type Scope = { scopeType: ScopeType; scopeId: string };

export type BonusDraft = {
  bonusType: "ATTENDANCE" | "SIGNUP" | "REVENUE_SHARE";
  amount: string;
  scopes: Scope[];
  minThreshold: string;
  maxThreshold: string;
};

// Every numeric field is a string so a half-typed amount is not coerced to 0 on
// each keystroke. "12." has to survive being in the box.
export type CompDraft = {
  baseType: "SALARY" | "PER_CLASS" | "HOURLY";
  baseAmount: string;
  baseScopes: Scope[];
  bonuses: BonusDraft[];
};

export type CompPlanFromApi = {
  baseType: CompDraft["baseType"];
  baseAmount: number | string | null;
  baseScopes?: Scope[] | null;
  bonuses?: {
    bonusType: BonusDraft["bonusType"];
    amount: number | string;
    scopes?: Scope[] | null;
    minThreshold?: number | null;
    maxThreshold?: number | null;
  }[] | null;
};

// HOURLY with an empty amount is what the API's own default produces for a
// staff member with no StaffCompensation row, so an absent plan and a blank one
// give the same draft. See DIRTY BASE above.
export function compDraftFromPlan(plan: CompPlanFromApi | null): CompDraft {
  if (!plan) return { baseType: "HOURLY", baseAmount: "", baseScopes: [], bonuses: [] };
  return {
    baseType: plan.baseType,
    baseAmount: String(plan.baseAmount ?? ""),
    baseScopes: plan.baseScopes ?? [],
    bonuses: (plan.bonuses ?? []).map((b) => ({
      bonusType: b.bonusType,
      amount: String(b.amount),
      scopes: b.scopes ?? [],
      minThreshold: b.minThreshold != null ? String(b.minThreshold) : "",
      maxThreshold: b.maxThreshold != null ? String(b.maxThreshold) : "",
    })),
  };
}

export function compPayload(d: CompDraft) {
  return {
    baseType: d.baseType,
    baseAmount: parseFloat(d.baseAmount) || 0,
    // SALARY has no scope: the amount is not per-class or per-hour, so a scope
    // list would be meaningless. The server applies the same rule.
    baseScopes: d.baseType === "PER_CLASS" || d.baseType === "HOURLY" ? d.baseScopes : [],
    bonuses: d.bonuses
      // A bonus row with no amount is an empty row the owner added and did not
      // fill in. Dropping it is deliberate — it is not a zero-value bonus.
      .filter((b) => b.amount.trim() !== "")
      .map((b) => ({
        bonusType: b.bonusType,
        amount: parseFloat(b.amount) || 0,
        scopes: b.scopes,
        minThreshold: b.minThreshold.trim() === "" ? null : Math.max(0, parseInt(b.minThreshold) || 0),
        maxThreshold: b.maxThreshold.trim() === "" ? null : Math.max(0, parseInt(b.maxThreshold) || 0),
      })),
  };
}

// True when the draft differs from the plan that was loaded. The modal compares
// JSON snapshots, so this is the one place the comparison is defined.
export function compIsDirty(loadedSnapshot: string, draft: CompDraft | null): boolean {
  if (draft === null || loadedSnapshot === "") return false;
  return JSON.stringify(draft) !== loadedSnapshot;
}
