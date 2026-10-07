/**
 * The pay ledger — the PURE rules (lib/payLedger.ts) and the plan editor's
 * form conversions (components/staff/pay/planDraft.ts).
 *
 *   npx tsx scripts/pay-ledger-tests.ts
 *
 * No database. What it pins — the owner's rules:
 *   1. which plan pays a class day: the most specific; a tie or no plan is
 *      "needs review", never a guessed amount
 *   2. only a class day that ENDED, with the coach still SCHEDULED, pays;
 *      cancelled pays only when marked paid; nothing before the ledger start
 *   3. a substitute is paid from their own plan, unless the pay for that one
 *      day was set (override) — the plan amount is kept beside it
 *   4. salary = one line per pay period at the full amount; only FULL periods
 *      on/after the ledger start
 *   5. reconcile never touches a paid line, a line on a payout, or a hand-made
 *      line; a line that is no longer payable is voided with the reason
 */
import {
  classRowPayable, classSpecificity, fmtCents, lineBucket, lineMath, matchClassPlan, matchEventPlan, normalizePlanInput,
  payableCount, planActiveOn, planClassAmount, planPayLines, planState, planSummaryLines, planWarnings, reconcileLines,
  roleKey, summarizeLines, toCents,
  type DesiredLine, type ExistingLine, type LedgerClassRow, type LedgerLineView, type LedgerPlan, type PlanInput,
} from "../lib/payLedger";
import { centsFromText, emptyPlanForm, planFormFromPlan, planInputFromForm } from "../components/staff/pay/planDraft";

let pass = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}
function eq(label: string, got: unknown, want: unknown) {
  check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}
const section = (t: string) => console.log(`\n${t}`);

const plan = (id: string, o: Partial<LedgerPlan> = {}): LedgerPlan => ({
  id, userId: "josh", name: id, baseType: "PER_CLASS", baseAmount: 25, effectiveFrom: "2026-10-01", effectiveTo: null,
  archived: false, baseScopes: [], bonuses: [], ...o,
});
const cls = (classId: string) => ({ scopeType: "CLASS", scopeId: classId });
const role = (r: string) => ({ scopeType: "ROLE", scopeId: r });
const row = (rowId: string, o: Partial<LedgerClassRow> = {}): LedgerClassRow => ({
  rowId, userId: "josh", classId: "jr", className: "Jr Frogs", dateYmd: "2026-10-14", minutes: 60, roleName: null,
  kind: "REGULAR", status: "SCHEDULED", ended: true, canceled: false, cancelPaid: false, payOverrideCents: null,
  payOverrideReason: null, payOverrideByUserId: null, payOverrideAt: null, attended: 0, ...o,
});
const START = "2026-10-13";
const lines = (o: Partial<Parameters<typeof planPayLines>[0]>) =>
  planPayLines({ fromYmd: START, ledgerStart: START, plans: [], classRows: [], ...o });

section("Money and small helpers");
eq("toCents rounds to the cent", [toCents(25), toCents(19.999), toCents(0.1 + 0.2)], [2500, 2000, 30]);
eq("fmtCents", [fmtCents(170000), fmtCents(-2550), fmtCents(null)], ["$1,700.00", "−$25.50", "—"]);
eq("a blank role is 'coach'; roles compare without case", [roleKey(null), roleKey("  "), roleKey("Lead Coach") === roleKey("lead coach")], ["coach", "coach", true]);
eq("thresholds: after 15, cap 30", [payableCount(12, 15, 30), payableCount(20, 15, 30), payableCount(40, 15, 30), payableCount(9, null, null)], [0, 5, 15, 9]);
eq("typed dollars → cents", [centsFromText("25"), centsFromText("$1,700.50"), centsFromText("-10"), centsFromText("abc"), centsFromText("1.234"), centsFromText("")], [2500, 170050, -1000, null, null, null]);

section("1. Which plan pays a class day");
{
  const any = plan("any");
  const jr = plan("jr-only", { baseScopes: [cls("jr")], baseAmount: 30 });
  const lead = plan("lead", { baseScopes: [role("Lead Coach")], baseAmount: 40 });
  const jrLead = plan("jr-lead", { baseScopes: [cls("jr"), role("Lead Coach")], baseAmount: 50 });
  eq("specificity: any 0, role 1, class 2, class+role 3", [any, lead, jr, jrLead].map((p) => classSpecificity(p, { classId: "jr", roleName: "Lead Coach" })), [0, 1, 2, 3]);
  eq("a class plan does not cover another class", classSpecificity(jr, { classId: "tad", roleName: null }), null);
  eq("a role plan does not cover another role", classSpecificity(lead, { classId: "jr", roleName: "Assistant Coach" }), null);
  const occ = { dateYmd: "2026-10-14", classId: "jr", roleName: "Lead Coach" };
  const m = matchClassPlan([any, jr, lead, jrLead], occ);
  check("class + role beats class beats role beats any", m.kind === "plan" && m.plan.id === "jr-lead");
  const m2 = matchClassPlan([any, jr, lead], { ...occ, roleName: "Assistant Coach" });
  check("an assistant on that class gets the class plan", m2.kind === "plan" && m2.plan.id === "jr-only");
  const m3 = matchClassPlan([any, lead], { ...occ, classId: "tad" });
  check("the lead of another class gets the role plan", m3.kind === "plan" && m3.plan.id === "lead");
  const tie = matchClassPlan([plan("a", { baseScopes: [cls("jr")] }), plan("b", { baseScopes: [cls("jr")] })], occ);
  check("two equally specific plans → a tie, not a pick", tie.kind === "tie" && tie.plans.length === 2);
  eq("no plan at all → none", matchClassPlan([], occ).kind, "none");
  eq("a plan for another class only → none", matchClassPlan([plan("tad", { baseScopes: [cls("tad")] })], occ).kind, "none");
  eq("a plan that has not started does not pay", matchClassPlan([plan("later", { effectiveFrom: "2026-11-01" })], occ).kind, "none");
  eq("a plan that ended does not pay", matchClassPlan([plan("old", { effectiveTo: "2026-10-13" })], occ).kind, "none");
  eq("…and pays on its last day", matchClassPlan([plan("old", { effectiveTo: "2026-10-14" })], occ).kind, "plan");
  eq("a removed plan never pays", matchClassPlan([plan("gone", { archived: true })], occ).kind, "none");
  const sal = plan("salary", { baseType: "SALARY", baseAmount: 1700 });
  eq("only a salary in force → the class day is covered by it", matchClassPlan([sal], occ).kind, "salary");
  const both = matchClassPlan([sal, jr], occ);
  check("salary plus a class plan → the class plan pays the class day", both.kind === "plan" && both.plan.id === "jr-only");
  eq("planActiveOn", [planActiveOn(any, "2026-09-30"), planActiveOn(any, "2026-10-01")], [false, true]);
  eq("planState", [planState(any, "2026-10-20"), planState(plan("x", { effectiveFrom: "2026-11-01" }), "2026-10-20"), planState(plan("x", { effectiveTo: "2026-10-01" }), "2026-10-20"), planState(plan("x", { archived: true }), "2026-10-20")], ["ACTIVE", "UPCOMING", "ENDED", "ARCHIVED"]);
  eq("hourly pays the hours", planClassAmount(plan("h", { baseType: "HOURLY", baseAmount: 30 }), 90), { units: 1.5, rateCents: 3000, amountCents: 4500 });
  const pe = plan("clinic", { baseType: "PER_EVENT", baseAmount: 100, baseScopes: [{ scopeType: "EVENT_TYPE", scopeId: "CLINIC" }] });
  eq("a per-event plan for clinics pays a clinic, not a camp", [matchEventPlan([pe], { dateYmd: "2026-10-14", eventId: "e1", eventType: "CLINIC" }).kind, matchEventPlan([pe], { dateYmd: "2026-10-14", eventId: "e1", eventType: "CAMP" }).kind], ["plan", "none"]);
}

section("2. What earns a pay line");
{
  eq("worked = scheduled on a day that ended", classRowPayable(row("r")), true);
  eq("a future class never pays", classRowPayable(row("r", { ended: false })), false);
  eq("cancelled → unpaid", classRowPayable(row("r", { canceled: true })), false);
  eq("cancelled but marked paid → paid", classRowPayable(row("r", { canceled: true, cancelPaid: true })), true);
  eq("called out / replaced / no-show / removed never pay", ["NEEDS_COVERAGE", "REPLACED", "NO_SHOW", "REMOVED"].map((status) => classRowPayable(row("r", { status }))), [false, false, false, false]);

  const p = plan("jr", { baseScopes: [cls("jr")] });
  const res = lines({ plans: [p], classRows: [row("before", { dateYmd: "2026-10-12" }), row("first", { dateYmd: "2026-10-13" }), row("ok"), row("future", { dateYmd: "2026-10-21", ended: false }), row("cx", { dateYmd: "2026-10-15", canceled: true })] });
  eq("nothing dated before the ledger start; the start day itself counts", res.desired.map((d) => d.sourceId), ["first", "ok"]);
  eq("the line keeps the rate that priced it", res.desired.map((d) => [d.amountCents, d.rateCents, d.planName, d.rateSource, d.status]), [[2500, 2500, "jr", "PLAN", "ESTIMATED"], [2500, 2500, "jr", "PLAN", "ESTIMATED"]]);
  check("a day that does not pay carries the reason", res.unpaidReasons.get("cx")!.includes("cancelled") && res.unpaidReasons.get("future")!.includes("not happened"));
  check("a day before the ledger is not even considered", !res.unpaidReasons.has("before"));

  const none = lines({ plans: [], classRows: [row("r")] }).desired[0];
  eq("no plan → needs review, NO amount", [none.status, none.amountCents, none.planId], ["NEEDS_REVIEW", null, null]);
  check("…and it says why", /no pay plan/i.test(none.reviewReason ?? ""));
  const wrong = lines({ plans: [plan("tad", { baseScopes: [cls("tad")] })], classRows: [row("r")] }).desired[0];
  check("a plan for another class → needs review, different words", wrong.status === "NEEDS_REVIEW" && /covers this class/.test(wrong.reviewReason ?? ""));
  const tie = lines({ plans: [plan("a"), plan("b")], classRows: [row("r")] }).desired[0];
  check("a tie → needs review naming both plans", tie.status === "NEEDS_REVIEW" && /a and b/.test(tie.reviewReason ?? ""));
  const sal = lines({ plans: [plan("s", { baseType: "SALARY", baseAmount: 1700 })], classRows: [row("r")] }).desired[0];
  eq("a salaried coach's class day is a $0 line, not a review", [sal.amountCents, sal.status, /covered by salary/.test(sal.description)], [0, "ESTIMATED", true]);
  const paidCx = lines({ plans: [p], classRows: [row("r", { canceled: true, cancelPaid: true })] }).desired[0];
  check("cancelled-paid pays and says so", paidCx.amountCents === 2500 && /cancelled, paid/.test(paidCx.description));
}

section("3. Substitutes and the one-day override");
{
  const mine = plan("sub-own", { userId: "matt", baseAmount: 20 });
  const sub = row("sub", { userId: "matt", kind: "SUBSTITUTE", roleName: "Substitute" });
  const d = lines({ plans: [mine], classRows: [sub, row("orig", { status: "REPLACED" })] });
  eq("the substitute is paid from THEIR OWN plan; the replaced coach is not paid", d.desired.map((x) => [x.userId, x.amountCents]), [["matt", 2000]]);
  check("the replaced coach's reason is recorded", /substitute covered/i.test(d.unpaidReasons.get("orig") ?? ""));
  const at = new Date("2026-10-15T12:00:00Z");
  const over = lines({ plans: [mine], classRows: [{ ...sub, payOverrideCents: 4000, payOverrideReason: "Lead rate", payOverrideByUserId: "owner", payOverrideAt: at }] }).desired[0];
  eq("an override pays the set amount and keeps the plan amount beside it", [over.amountCents, over.rateSource, over.planAmountCents, over.overrideReason, over.overrideByUserId], [4000, "OVERRIDE", 2000, "Lead rate", "owner"]);
  const noPlan = lines({ plans: [], classRows: [{ ...sub, payOverrideCents: 4000, payOverrideReason: "x", payOverrideByUserId: "owner", payOverrideAt: at }] }).desired[0];
  eq("no plan + an override → payable at the override (no review)", [noPlan.status, noPlan.amountCents, noPlan.planAmountCents], ["ESTIMATED", 4000, null]);
  const zero = lines({ plans: [mine], classRows: [{ ...sub, payOverrideCents: 0, payOverrideReason: "volunteer", payOverrideByUserId: "owner", payOverrideAt: at }] }).desired[0];
  eq("an override of $0 is an override, not 'no override'", [zero.amountCents, zero.rateSource], [0, "OVERRIDE"]);
}

section("4. Salary, pay periods and bonuses");
{
  const sal = plan("Salary", { userId: "sal", baseType: "SALARY", baseAmount: 1700 });
  const per = (periodStart: string, periodEnd: string) => ({ userId: "sal", periodStart, periodEnd });
  const d = lines({ plans: [sal], periods: [per("2026-09-29", "2026-10-12"), per("2026-10-13", "2026-10-26"), per("2026-10-27", "2026-11-09")] });
  eq("one salary line per FULL period on/after the start — the in-progress Sep 29–Oct 12 period gets none", d.desired.map((x) => [x.sourceType, x.workDate, x.amountCents, x.periodStart]), [["SALARY", "2026-10-26", 170000, "2026-10-13"], ["SALARY", "2026-11-09", 170000, "2026-10-27"]]);
  eq("the salary line's key is plan + payday (so it can never be made twice)", d.desired[0].sourceId, "Salary|2026-10-26");
  eq("a salary plan that ended before the payday pays nothing for that period", lines({ plans: [{ ...sal, effectiveTo: "2026-10-20" }], periods: [per("2026-10-13", "2026-10-26")] }).desired.length, 0);
  eq("no pay schedule → no periods → no salary line (it is flagged instead)", lines({ plans: [sal], periods: [] }).desired.length, 0);
  check("…flagged", planWarnings({ plans: [sal], hasSchedule: false, todayYmd: "2026-10-20" }).some((w) => /salary/i.test(w)));

  const b = { id: "b1", bonusType: "ATTENDANCE", amount: 5, minThreshold: 15, maxThreshold: 30, countPer: "CLASS_DAY", scopes: [cls("jr")] };
  const withDay = plan("p", { bonuses: [b] });
  const dd = lines({ plans: [withDay], classRows: [row("r1", { attended: 12 }), row("r2", { attended: 21, dateYmd: "2026-10-15" }), row("r3", { attended: 40, classId: "tad", className: "Tadpoles", dateYmd: "2026-10-16" })] });
  eq("an attendance bonus counted per class day: 21 attending, after 15 → 6 × $5; 12 → nothing; another class → nothing", dd.desired.filter((x) => x.component === "BONUS:b1").map((x) => [x.sourceId, x.units, x.amountCents]), [["r2", 6, 3000]]);
  const perPeriod = plan("pp", { userId: "sal", bonuses: [{ ...b, id: "b2", countPer: "PERIOD" }] });
  const dp = lines({ plans: [perPeriod], periods: [per("2026-10-13", "2026-10-26")], periodBonusPay: (planId, bonusId, end) => (planId === "pp" && bonusId === "b2" && end === "2026-10-26" ? { pay: 45, basisLabel: "9/24 attendance" } : null) });
  eq("a bonus counted over the pay period is one line for the period, from the shared calculator", dp.desired.map((x) => [x.sourceType, x.component, x.amountCents, x.workDate]), [["BONUS", "BONUS:b2", 4500, "2026-10-26"]]);
  check("a period bonus with no pay schedule is flagged", planWarnings({ plans: [perPeriod], hasSchedule: false, todayYmd: "2026-10-20" }).some((w) => /bonus/i.test(w)));
  eq("…a per-class-day bonus is not", planWarnings({ plans: [withDay], hasSchedule: false, todayYmd: "2026-10-20" }), []);
  const period = lines({ plans: [plan("p")], classRows: [row("r")], periodOf: () => ({ periodStart: "2026-10-13", periodEnd: "2026-10-26" }) }).desired[0];
  eq("a class line carries the pay period it falls in", [period.periodStart, period.periodEnd], ["2026-10-13", "2026-10-26"]);
}

section("5. Reconcile");
{
  const want = (o: Partial<DesiredLine> = {}): DesiredLine => ({
    userId: "josh", sourceType: "CLASS_SESSION", sourceId: "r1", component: "BASE", workDate: "2026-10-14", description: "Jr Frogs · Coach",
    units: 1, rateCents: 2500, amountCents: 2500, rateSource: "PLAN", planId: "p", planName: "p", planAmountCents: 2500,
    overrideReason: null, overrideByUserId: null, overrideAt: null, status: "ESTIMATED", reviewReason: null, periodStart: null, periodEnd: null, ...o,
  });
  const have = (o: Partial<ExistingLine> = {}): ExistingLine => ({ id: "L1", ...want(), voidReason: null, payoutId: null, ...o });
  eq("a new line is created", reconcileLines([want()], []).create.length, 1);
  const same = reconcileLines([want()], [have()]);
  eq("nothing changed → nothing written (idempotent)", [same.create.length, same.update.length, same.voids.length], [0, 0, 0]);
  const rate = reconcileLines([want({ rateCents: 3000, amountCents: 3000, planAmountCents: 3000 })], [have()]);
  eq("the plan's rate changed → the UNPAID line is re-priced", rate.update, [{ id: "L1", data: { rateCents: 3000, amountCents: 3000, planAmountCents: 3000 } }]);
  const paid = reconcileLines([want({ rateCents: 3000, amountCents: 3000, planAmountCents: 3000 })], [have({ status: "PAID", payoutId: "po1" })]);
  eq("…a PAID line is never touched", [paid.create.length, paid.update.length, paid.voids.length], [0, 0, 0]);
  const pending = reconcileLines([], [have({ payoutId: "po1" })]);
  eq("a line on a pending payout is not touched either — even when no longer wanted", [pending.update.length, pending.voids.length], [0, 0]);
  const gone = reconcileLines([], [have()], new Map([["r1", "The class day was cancelled (not marked paid)"]]));
  eq("a line that no longer pays is VOIDED with the reason (kept on record)", gone.voids, [{ id: "L1", reason: "The class day was cancelled (not marked paid)" }]);
  const back = reconcileLines([want()], [have({ status: "VOID", voidReason: "x" })]);
  eq("…and comes back if it pays again", back.update, [{ id: "L1", data: { status: "ESTIMATED", voidReason: null } }]);
  const manual = reconcileLines([], [have({ id: "M1", sourceType: "ADJUSTMENT", sourceId: "manual_1", rateSource: "MANUAL" })]);
  eq("a bonus / adjustment added by hand is never voided or changed", [manual.update.length, manual.voids.length], [0, 0]);
  const own = reconcileLines(
    [want({ sourceType: "SALARY", sourceId: "s|2026-10-26", amountCents: 180000, planAmountCents: 180000, rateCents: 180000 })],
    [have({ sourceType: "SALARY", sourceId: "s|2026-10-26", amountCents: 150000, rateSource: "OVERRIDE", overrideReason: "half period", overrideByUserId: "owner", planAmountCents: 170000, rateCents: 170000 })],
  );
  eq("an override set on a salary line survives a plan change; only the 'plan would pay' figure moves", own.update, [{ id: "L1", data: { rateCents: 180000, planAmountCents: 180000 } }]);
}

section("Reading: buckets, totals, words");
{
  const v = (o: Partial<LedgerLineView>): LedgerLineView => ({
    id: "x", userId: "u", sourceType: "CLASS_SESSION", sourceId: "r", component: "BASE", workDate: "2026-10-14", description: "d", units: 1,
    rateCents: 2500, amountCents: 2500, rateSource: "PLAN", planId: "p", planName: "p", planAmountCents: 2500, overrideReason: null,
    overrideByName: null, status: "ESTIMATED", reviewReason: null, voidReason: null, payoutId: null, payoutStatus: null, periodStart: null,
    periodEnd: null, matchRegular: null, ...o,
  });
  const set = [v({ id: "a" }), v({ id: "b", status: "NEEDS_REVIEW", amountCents: null }), v({ id: "c", status: "PAID", payoutId: "p1", payoutStatus: "PAID" }), v({ id: "d", payoutId: "p2", payoutStatus: "PENDING" }), v({ id: "e", status: "VOID" }), v({ id: "f", amountCents: -500, sourceType: "ADJUSTMENT", rateSource: "MANUAL" })];
  eq("buckets", set.map(lineBucket), ["UNPAID", "REVIEW", "PAID", "ON_PAYOUT", "VOID", "UNPAID"]);
  eq("totals: unpaid nets an adjustment; review has a count, not an amount; void counts for nothing", summarizeLines(set), { unpaidCents: 2000, onPayoutCents: 2500, paidCents: 2500, reviewCount: 1, payableLineIds: ["a", "f"] });
  eq("the math shown on a line", [lineMath(v({})), lineMath(v({ units: 1.5, rateCents: 3000 })), lineMath(v({ component: "BONUS:b", units: 6, rateCents: 500 })), lineMath(v({ rateSource: "OVERRIDE" }))], ["$25.00", "1.5 hr × $30.00", "6 × $5.00", ""]);
  const p = plan("x", { baseScopes: [cls("jr"), role("Lead Coach")], bonuses: [{ id: "b", bonusType: "ATTENDANCE", amount: 5, minThreshold: 15, maxThreshold: 30, countPer: "CLASS_DAY", scopes: [] }] });
  eq("a plan in words", planSummaryLines(p, { classes: { jr: "Jr Frogs" } }), ["Per class · $25 per class · Jr Frogs · as Lead Coach", "Attendance bonus · $5 per attendee, after 15 up to 30, counted each class day"]);
  eq("a salary in words", planSummaryLines(plan("s", { baseType: "SALARY", baseAmount: 1700 }), { classes: {} }), ["Salary · $1,700 per pay period · Every pay period"]);
}

section("The plan editor: form ⇄ what is saved");
{
  const stored = plan("Jr Frogs Lead", {
    baseScopes: [cls("jr"), role("Lead Coach")],
    bonuses: [{ id: "b1", bonusType: "ATTENDANCE", amount: 5, minThreshold: 15, maxThreshold: null, countPer: "CLASS_DAY", scopes: [cls("jr")] }],
  });
  const round = planInputFromForm(planFormFromPlan(stored));
  const want: PlanInput = {
    name: "Jr Frogs Lead", baseType: "PER_CLASS", baseAmount: 25, effectiveFrom: "2026-10-01", effectiveTo: null, baseScopes: [cls("jr"), role("Lead Coach")],
    bonuses: [{ id: "b1", bonusType: "ATTENDANCE", amount: 5, minThreshold: 15, maxThreshold: null, countPer: "CLASS_DAY", scopes: [cls("jr")] }],
  };
  eq("opening a plan and saving it unchanged saves the same plan — bonus ids included", round, want);
  const f = planFormFromPlan(stored);
  eq("switching to salary drops the class and role scopes", planInputFromForm({ ...f, baseType: "SALARY" }).baseScopes, []);
  eq("an empty bonus row is not saved", planInputFromForm({ ...f, bonuses: [...f.bonuses, { id: null, bonusType: "SIGNUP", amount: "", minThreshold: "", maxThreshold: "", countPer: "PERIOD", scopes: [] }] }).bonuses.length, 1);
  eq("a new plan form starts today, per class", [emptyPlanForm("2026-10-20").effectiveFrom, emptyPlanForm("2026-10-20").baseType], ["2026-10-20", "PER_CLASS"]);
  const bad = (o: Partial<PlanInput>) => normalizePlanInput({ ...want, ...o }).error;
  eq("validation in plain words", [bad({ name: "  " }), bad({ effectiveTo: "2026-09-01" }), bad({ baseAmount: -1 }), bad({}), bad({ bonuses: [{ ...want.bonuses[0], minThreshold: 30, maxThreshold: 10 }] }) !== null], ["Give the pay plan a name.", "The end date is before the start date.", "Enter the amount.", null, true]);
  eq("only an attendance bonus can count per class day", normalizePlanInput({ ...want, bonuses: [{ ...want.bonuses[0], bonusType: "SIGNUP", countPer: "CLASS_DAY" }] }).plan.bonuses[0].countPer, "PERIOD");
  eq("the same role twice (different case) is stored once", normalizePlanInput({ ...want, baseScopes: [role("Lead Coach"), role("lead coach")] }).plan.baseScopes.length, 1);
}

console.log(`\n${failures.length === 0 ? "✓" : "✗"} ${pass} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
