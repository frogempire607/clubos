/**
 * Tests for lib/entitlements.resolveCoverage — the one answer to "does this
 * membership cover this session, on this day".
 *
 * No database. Run:  npm run test:entitlements
 *
 * The fixture is Frog Empire's real shape: MS/HS with a $175 full option and a
 * $110 Tue/Thu option, accepted by Ms/HS Olympic Season which runs Mon·Tue·Thu
 * as ONE class. That class is the whole reason entitlement is per-weekday and
 * not per-class — both members attend it and differ only on Monday.
 */
import {
  resolveSessionCoverage,
  shouldWarn,
  type CoverageSubscription,
  type CoverageVerdict,
} from "../lib/entitlements";
import { makeOption, type MembershipOption } from "../lib/membershipOptions";

let pass = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
    return;
  }
  const d = detail === undefined ? "" : ` — ${JSON.stringify(detail)}`;
  failures.push(`${label}${d}`);
  console.log(`  ✗ ${label}${d}`);
}

const MSHS_ID = "plan_mshs";
const FULL = makeOption({ id: "opt_full", label: "Monthly Full Membership", price: 175, billingPeriod: "MONTHLY" });
const TWO_DAY = makeOption({
  id: "opt_2day",
  label: "Monthly 2 days (Tue/Thu)",
  price: 110,
  billingPeriod: "MONTHLY",
  entitlement: { kind: "DAYS", days: [2, 4] },
});
const MSHS_OPTIONS: MembershipOption[] = [FULL, TWO_DAY];

const MON = 1, TUE = 2, WED = 3, THU = 4, SUN = 0;
const DROPIN = { amount: 25, source: "dropin" as const };

function sub(over: Partial<CoverageSubscription> = {}): CoverageSubscription {
  return {
    id: "sub_1",
    membershipId: MSHS_ID,
    status: "active",
    optionId: FULL.id,
    optionLabel: "Monthly Full Membership",
    billingPeriod: "MONTHLY",
    price: 175,
    endDate: null,
    plan: { id: MSHS_ID, name: "MS/HS", options: MSHS_OPTIONS },
    ...over,
  };
}

const on = (s: CoverageSubscription[], weekday: number, extra = {}): CoverageVerdict =>
  resolveSessionCoverage({ subscriptions: s, acceptedMembershipIds: [MSHS_ID], sessionWeekday: weekday, dropIn: DROPIN, ...extra });

// ── The case the phase exists for ───────────────────────────────────────────
console.log("\nOlympic Season runs Mon·Tue·Thu as one class:");
{
  const full = [sub()];
  const twoDay = [sub({ optionId: TWO_DAY.id, optionLabel: TWO_DAY.label, price: 110 })];

  check("$175 full member is covered Monday", on(full, MON).covered);
  check("$175 full member is covered Tuesday", on(full, TUE).covered);
  check("$175 full member is covered Thursday", on(full, THU).covered);

  check("$110 Tue/Thu member is covered Tuesday", on(twoDay, TUE).covered);
  check("$110 Tue/Thu member is covered Thursday", on(twoDay, THU).covered);

  const monday = on(twoDay, MON);
  check("$110 Tue/Thu member is NOT covered Monday", !monday.covered);
  check("  reason is DAY_NOT_INCLUDED", monday.reason === "DAY_NOT_INCLUDED");
  check("  message names the option", monday.message.includes("Monthly 2 days (Tue/Thu)"));
  check("  message names the days they DO have", monday.message.includes("Tue & Thu"));
  check("  message names the day they don't", monday.message.includes("Monday"));
  check("  message carries the drop-in amount", monday.message.includes("$25"), monday.message);
  check("  entitledDays is reported for the UI", JSON.stringify(monday.entitledDays) === "[2,4]");
  check("  and it warns", shouldWarn(monday));
}

// ── Absolute day sets: Sunday Funday (D1) ───────────────────────────────────
console.log("\nabsolute day sets:");
{
  const twoDay = [sub({ optionId: TWO_DAY.id, optionLabel: TWO_DAY.label, price: 110 })];
  const full = [sub()];
  check("Tue/Thu member is NOT covered on Sunday Funday", !on(twoDay, SUN).covered);
  check("full member IS covered on Sunday (entitlement ALL)", on(full, SUN).covered);
  check("full member is covered on a Wednesday the club adds later", on(full, WED).covered);
}

// ── Fail-open branches ──────────────────────────────────────────────────────
console.log("\nfails open where it cannot judge:");
{
  // Colton Waite's shape: $530 on a MONTHLY row, matching no option.
  const unidentifiable = [sub({ optionId: null, price: 530 })];
  const v = on(unidentifiable, MON);
  check("an unidentifiable option is COVERED, not denied", v.covered);
  check("  reason is OPTION_UNIDENTIFIED", v.reason === "OPTION_UNIDENTIFIED");
  check("  it says coverage was not checked", v.message.includes("coverage not checked"));
  check("  and it does NOT warn — these rows are already unusual", !shouldWarn(v));

  // An optionId pointing at an option since deleted from the plan.
  const orphan = [sub({ optionId: "opt_gone" })];
  check("an orphaned optionId also fails open", on(orphan, MON).covered);

  // A class nobody's plan covers is a paid class, not a coverage failure.
  const noPlans = resolveSessionCoverage({
    subscriptions: [sub()],
    acceptedMembershipIds: [],
    sessionWeekday: MON,
    dropIn: DROPIN,
  });
  check("a class accepting no plan is covered:true, NO_ACCEPTED_PLANS", noPlans.covered && noPlans.reason === "NO_ACCEPTED_PLANS");
  check("  and does not warn", !shouldWarn(noPlans));
}

// ── Inference still gates the day ───────────────────────────────────────────
console.log("\ninferred options are still judged:");
{
  // Hunter Meyer: no optionId, $175 MONTHLY — unique, so inferable.
  const inferred = [sub({ optionId: null, price: 175 })];
  const v = on(inferred, MON);
  check("an inferred full option is covered Monday", v.covered);
  check("  resolution is reported as inferred, not passed off as exact", v.optionResolution === "inferred");
  check("  and the message admits it was matched by price", v.message.includes("matched by price"));

  // Inference that lands on the restricted option must still restrict.
  const inferredTwoDay = [sub({ optionId: null, price: 110 })];
  const w = on(inferredTwoDay, MON);
  check("an inferred Tue/Thu option is NOT covered Monday", !w.covered);
  check("  a guess about identity does not become a grant of access", w.reason === "DAY_NOT_INCLUDED");
}

// ── Statuses, plans, terms ──────────────────────────────────────────────────
console.log("\nstatus, plan and term:");
{
  check("a pending subscription is not an active membership", !on([sub({ status: "pending" })], TUE).covered);
  check("a canceled subscription is not either", !on([sub({ status: "canceled" })], TUE).covered);
  check("  reason NO_ACTIVE_MEMBERSHIP", on([sub({ status: "canceled" })], TUE).reason === "NO_ACTIVE_MEMBERSHIP");
  check("  and it does NOT warn — non-member pricing already covers this", !shouldWarn(on([sub({ status: "canceled" })], TUE)));

  const otherPlan = [sub({ membershipId: "plan_tadpoles", plan: { id: "plan_tadpoles", name: "Tadpoles", options: [] } })];
  const v = on(otherPlan, TUE);
  check("a plan this class doesn't accept is not covered", !v.covered);
  check("  reason PLAN_NOT_ACCEPTED", v.reason === "PLAN_NOT_ACCEPTED");
  check("  message names the plan they actually hold", v.message.includes("Tadpoles"));
  check("  and does NOT warn", !shouldWarn(v));

  const ended = on([sub({ endDate: new Date("2026-08-01T00:00:00Z") })], TUE, {
    sessionAt: new Date("2026-08-18T19:00:00Z"),
  });
  check("a term that ended before the session is not covered", !ended.covered);
  check("  reason TERM_ENDED", ended.reason === "TERM_ENDED");
  check("  and it warns", shouldWarn(ended));

  const notYetEnded = on([sub({ endDate: new Date("2026-12-01T00:00:00Z") })], TUE, {
    sessionAt: new Date("2026-08-18T19:00:00Z"),
  });
  check("a future end date is still covered", notYetEnded.covered);
  check(
    "an absent endDate is open-ended, never 'expired'",
    on([sub({ endDate: null })], TUE, { sessionAt: new Date("2026-08-18T19:00:00Z") }).covered,
  );
  check(
    "with no sessionAt, a past endDate is not judged either way",
    on([sub({ endDate: new Date("2020-01-01T00:00:00Z") })], TUE).covered,
  );
}

// ── Several memberships at once ─────────────────────────────────────────────
console.log("\nmultiple memberships:");
{
  const twoDay = sub({ id: "s1", optionId: TWO_DAY.id, optionLabel: TWO_DAY.label, price: 110 });
  const sundayPlan = sub({
    id: "s2",
    membershipId: "plan_sunday",
    optionId: "opt_sun",
    optionLabel: "Monthly",
    price: 75,
    plan: {
      id: "plan_sunday",
      name: "Sunday Funday",
      options: [makeOption({ id: "opt_sun", label: "Monthly", price: 75, billingPeriod: "MONTHLY" })],
    },
  });

  const both = resolveSessionCoverage({
    subscriptions: [twoDay, sundayPlan],
    acceptedMembershipIds: [MSHS_ID, "plan_sunday"],
    sessionWeekday: SUN,
    dropIn: DROPIN,
  });
  check("holding ANY plan that covers the day is enough", both.covered);
  check("  and the covering plan is the one named", both.planName === "Sunday Funday");

  // The Sunday Funday option is entitlement ALL, so it covers a Monday too —
  // in reality Olympic Season would not ACCEPT that plan, which is the class's
  // job, not the entitlement's. To test shortfall ranking, use two rows that
  // both genuinely fail on the same day for different reasons.
  const expired = sub({ id: "s4", endDate: new Date("2026-08-01T00:00:00Z") });
  const ranked = resolveSessionCoverage({
    subscriptions: [twoDay, expired],
    acceptedMembershipIds: [MSHS_ID],
    sessionWeekday: MON,
    sessionAt: new Date("2026-08-18T19:00:00Z"),
    dropIn: DROPIN,
  });
  check("when none covers, the most actionable shortfall wins", ranked.reason === "DAY_NOT_INCLUDED", ranked.reason);
  check("  (DAY_NOT_INCLUDED names an exact gap, TERM_ENDED does not)", !ranked.covered);

  const unidentifiedPlusDay = resolveSessionCoverage({
    subscriptions: [twoDay, sub({ id: "s3", optionId: null, price: 999 })],
    acceptedMembershipIds: [MSHS_ID],
    sessionWeekday: MON,
    dropIn: DROPIN,
  });
  check(
    "an unidentified row alongside a real one fails OPEN overall",
    unidentifiedPlusDay.covered,
  );
}

// ── Drop-in reporting ───────────────────────────────────────────────────────
console.log("\ndrop-in amount:");
{
  const twoDay = [sub({ optionId: TWO_DAY.id, optionLabel: TWO_DAY.label, price: 110 })];
  const noPrice = resolveSessionCoverage({
    subscriptions: twoDay,
    acceptedMembershipIds: [MSHS_ID],
    sessionWeekday: MON,
    dropIn: null,
  });
  check(
    "with no drop-in configured it says so rather than inventing one",
    /no drop-in price/i.test(noPrice.message),
    noPrice.message,
  );
  check("  and never prints $undefined or $NaN", !/\$(undefined|NaN)/.test(noPrice.message), noPrice.message);

  const nonMember = resolveSessionCoverage({
    subscriptions: twoDay,
    acceptedMembershipIds: [MSHS_ID],
    sessionWeekday: MON,
    dropIn: { amount: 40, source: "nonmember" },
  });
  check("a nonmember price is used when there is no dropin tier", nonMember.message.includes("$40"));
  check("cents render properly", on(twoDay, MON, { dropIn: { amount: 12.5, source: "dropin" } }).message.includes("$12.50"));
}

// ── The weekday convention ──────────────────────────────────────────────────
console.log("\nweekday convention:");
{
  // ClassSession.date is stored at UTC midnight and getUTCDay() is what
  // buildSessions selected on. Production: MS/HS Preseason 2026-11-12 → DOW 4.
  const nov12 = new Date("2026-11-12T00:00:00Z");
  check("2026-11-12 is Thursday by getUTCDay", nov12.getUTCDay() === THU);
  const twoDay = [sub({ optionId: TWO_DAY.id, optionLabel: TWO_DAY.label, price: 110 })];
  check("and a Tue/Thu member IS covered that session", on(twoDay, nov12.getUTCDay()).covered);

  const nov9 = new Date("2026-11-09T00:00:00Z");
  check("2026-11-09 is Monday", nov9.getUTCDay() === MON);
  check("and the same member is NOT covered that session", !on(twoDay, nov9.getUTCDay()).covered);
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nFailures:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
