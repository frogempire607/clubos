/**
 * The Edit Staff compensation draft conversions.
 *
 *   npm run test:staff-comp-draft
 *
 * No database, no network — these are pure functions.
 *
 * Why they are worth a test. Before 2026-09-26 the compensation plan had its
 * own Save button inside the Edit Staff modal, and the modal's footer "Save
 * changes" button silently discarded the plan. The fix folds the plan into the
 * one save, which means the plan is now written on every save where it looks
 * changed. That turns two previously cosmetic questions into data-integrity
 * ones:
 *
 *   · if the plan → draft → payload round trip is not faithful, saving a staff
 *     member whose plan nobody touched rewrites that plan;
 *   · if a staff member with NO plan produces a draft that differs from the
 *     "no plan" baseline, merely opening and closing the modal reads as an
 *     unsaved edit — and the plan gets written where none existed.
 */

import {
  compDraftFromPlan,
  compPayload,
  compIsDirty,
  type CompPlanFromApi,
  type CompDraft,
} from "../lib/staffCompensationDraft";

let passed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, a === e ? undefined : `got ${a}, want ${e}`);
}

console.log("\nEDIT STAFF — compensation draft conversions\n");

// ── ROUND TRIP ──────────────────────────────────────────────────────────────
console.log("Round trip: a plan nobody touched must come back byte-identical");

const hourlyWithScopes: CompPlanFromApi = {
  baseType: "HOURLY",
  baseAmount: 32.5,
  baseScopes: [{ scopeType: "CLASS", scopeId: "cls_1" }],
  bonuses: [
    {
      bonusType: "ATTENDANCE",
      amount: 2,
      scopes: [{ scopeType: "CLASS", scopeId: "cls_1" }],
      minThreshold: 10,
      maxThreshold: 25,
    },
    { bonusType: "REVENUE_SHARE", amount: 15, scopes: [], minThreshold: null, maxThreshold: null },
  ],
};
eq(
  "HOURLY with base scopes and two bonuses",
  compPayload(compDraftFromPlan(hourlyWithScopes)),
  {
    baseType: "HOURLY",
    baseAmount: 32.5,
    baseScopes: [{ scopeType: "CLASS", scopeId: "cls_1" }],
    bonuses: [
      {
        bonusType: "ATTENDANCE",
        amount: 2,
        scopes: [{ scopeType: "CLASS", scopeId: "cls_1" }],
        minThreshold: 10,
        maxThreshold: 25,
      },
      { bonusType: "REVENUE_SHARE", amount: 15, scopes: [], minThreshold: null, maxThreshold: null },
    ],
  },
);

const salary: CompPlanFromApi = { baseType: "SALARY", baseAmount: 48000, baseScopes: [], bonuses: [] };
eq("SALARY with no bonuses", compPayload(compDraftFromPlan(salary)), {
  baseType: "SALARY",
  baseAmount: 48000,
  baseScopes: [],
  bonuses: [],
});

// A zero base is a real stored value (the old UI could produce one from an
// empty amount field), so it has to survive rather than reading as "unset".
eq("zero base amount survives", compPayload(compDraftFromPlan({ baseType: "PER_CLASS", baseAmount: 0, baseScopes: [], bonuses: [] })), {
  baseType: "PER_CLASS",
  baseAmount: 0,
  baseScopes: [],
  bonuses: [],
});

// Decimals arrive from Prisma as strings often enough to matter.
eq(
  "string decimal from the API round-trips to a number",
  compPayload(compDraftFromPlan({ baseType: "HOURLY", baseAmount: "27.75", baseScopes: [], bonuses: [] })).baseAmount,
  27.75,
);

// minThreshold 0 is meaningfully different from null (no bound). String("0")
// is truthy, so this only works because the check is against null, not falsy.
eq(
  "minThreshold 0 is preserved, not collapsed to null",
  compPayload(
    compDraftFromPlan({
      baseType: "HOURLY",
      baseAmount: 10,
      baseScopes: [],
      bonuses: [{ bonusType: "SIGNUP", amount: 5, scopes: [], minThreshold: 0, maxThreshold: null }],
    }),
  ).bonuses[0],
  { bonusType: "SIGNUP", amount: 5, scopes: [], minThreshold: 0, maxThreshold: null },
);

// SALARY cannot carry base scopes. If the API ever returns some, dropping them
// is correct and must not be mistaken for an edit the owner made.
eq(
  "SALARY drops base scopes",
  compPayload(
    compDraftFromPlan({
      baseType: "SALARY",
      baseAmount: 1000,
      baseScopes: [{ scopeType: "CLASS", scopeId: "cls_9" }],
      bonuses: [],
    }),
  ).baseScopes,
  [],
);

// ── DIRTY BASE ──────────────────────────────────────────────────────────────
console.log("\nDirty baseline: opening the modal must not look like an edit");

const noPlan = compDraftFromPlan(null);
eq("no plan → HOURLY with an empty amount", noPlan, {
  baseType: "HOURLY",
  baseAmount: "",
  baseScopes: [],
  bonuses: [],
});

const snapshot = JSON.stringify(noPlan);
ok("an untouched no-plan draft is not dirty", compIsDirty(snapshot, noPlan) === false);
ok(
  "an untouched loaded draft is not dirty",
  compIsDirty(JSON.stringify(compDraftFromPlan(hourlyWithScopes)), compDraftFromPlan(hourlyWithScopes)) === false,
);
ok("a draft still loading is never dirty", compIsDirty("", null) === false);
ok(
  "changing the base amount is dirty",
  compIsDirty(snapshot, { ...noPlan, baseAmount: "20" }) === true,
);
ok(
  "adding a bonus row is dirty",
  compIsDirty(snapshot, {
    ...noPlan,
    bonuses: [{ bonusType: "ATTENDANCE", amount: "", scopes: [], minThreshold: "", maxThreshold: "" }],
  }) === true,
);

// ── EMPTY BONUS ROWS ────────────────────────────────────────────────────────
console.log("\nEmpty bonus rows are dropped, not saved as zero");

const withBlank: CompDraft = {
  baseType: "HOURLY",
  baseAmount: "25",
  baseScopes: [],
  bonuses: [
    { bonusType: "ATTENDANCE", amount: "3", scopes: [], minThreshold: "", maxThreshold: "" },
    { bonusType: "SIGNUP", amount: "   ", scopes: [], minThreshold: "", maxThreshold: "" },
  ],
};
eq("a whitespace-only amount is dropped", compPayload(withBlank).bonuses.length, 1);
eq("the filled row is kept", compPayload(withBlank).bonuses[0].amount, 3);

// A half-typed amount must not be coerced while the owner is still typing —
// that is the whole reason the draft holds strings.
eq('a partially typed "12." saves as 12', compPayload({ ...withBlank, baseAmount: "12.", bonuses: [] }).baseAmount, 12);
eq("an unparseable amount saves as 0 rather than NaN", compPayload({ ...withBlank, baseAmount: "abc", bonuses: [] }).baseAmount, 0);

// ── Result ──────────────────────────────────────────────────────────────────
console.log("");
if (failures.length > 0) {
  console.log(`✗ ${failures.length} failed, ${passed} passed`);
  failures.forEach((f) => console.log(`   ${f}`));
  process.exit(1);
}
console.log(`✓ ${passed}/${passed} passed — compensation draft conversions`);
process.exit(0);
