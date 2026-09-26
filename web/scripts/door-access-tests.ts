// The door rule (lib/doorAccess) — no covering membership → free trial if still
// available, otherwise pay the drop-in. PURE.   npm run test:door-access
import { decideDoor, verdictCovers, type DoorInput } from "../lib/doorAccess";
import { pickCurrentSession } from "../lib/frontDesk";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};
const base: DoorInput = { covered: false, hasActiveSubscription: false, trialWindowActive: false, trialCoversClass: true, newTrialDays: 7, dropInPrice: 25 };
const d = (o: Partial<DoorInput>) => decideDoor({ ...base, ...o });

eq("member covered → in", d({ covered: true, hasActiveSubscription: true }), { kind: "PRESENT", reason: "COVERED" });
eq("brand-new, trial available → start trial", d({}), { kind: "START_TRIAL", days: 7 });
eq("trial already running → in on trial", d({ trialWindowActive: true }), { kind: "TRIAL", reason: "TRIAL_RUNNING" });
eq("trial used up → pay drop-in", d({ newTrialDays: null }), { kind: "PAY", amount: 25 });
eq("club offers no trial → pay drop-in", d({ newTrialDays: null, trialCoversClass: false }), { kind: "PAY", amount: 25 });
eq("trial doesn't reach this class → pay", d({ trialCoversClass: false }), { kind: "PAY", amount: 25 });
eq("has a plan that doesn't cover today (Tue/Thu on Monday) → pay, never a trial", d({ hasActiveSubscription: true }), { kind: "PAY", amount: 25 });
eq("chose cash at the desk", d({ newTrialDays: null, payAtDesk: true }), { kind: "PAY_AT_DESK", amount: 25 });
eq("no drop-in price set → let them in, flagged", d({ newTrialDays: null, dropInPrice: null }), { kind: "PRESENT", reason: "NO_PRICE_SET" });
eq("$0 drop-in → let them in", d({ newTrialDays: null, dropInPrice: 0 }), { kind: "PRESENT", reason: "NO_PRICE_SET" });
eq("covered beats payAtDesk", d({ covered: true, payAtDesk: true }), { kind: "PRESENT", reason: "COVERED" });

eq("verdict COVERED", verdictCovers({ covered: true, reason: "COVERED" }, true), true);
eq("verdict DAY_NOT_INCLUDED", verdictCovers({ covered: false, reason: "DAY_NOT_INCLUDED" }, true), false);
eq("verdict unidentified option fails open", verdictCovers({ covered: true, reason: "OPTION_UNIDENTIFIED" }, true), true);
eq("class accepts no plan: plan holder in", verdictCovers({ covered: true, reason: "NO_ACCEPTED_PLANS" }, true), true);
eq("class accepts no plan: no plan pays", verdictCovers({ covered: true, reason: "NO_ACCEPTED_PLANS" }, false), false);
eq("no verdict: falls back to any plan", verdictCovers(null, false), false);

// Front desk: which class to open on. Stamps are wall-clock in UTC fields.
const sess = (id: string, s: string, e: string, canceled = false) => ({ id, startsAt: `2026-09-28T${s}:00.000Z`, endsAt: `2026-09-28T${e}:00.000Z`, canceled });
const day = [sess("jr", "17:00", "18:00"), sess("mshs", "18:00", "19:30"), sess("x", "20:00", "21:00", true)];
eq("front desk: 17:30 → the class running", pickCurrentSession(day, 17 * 60 + 30), "jr");
eq("front desk: 17:05 → still the running one, not the next", pickCurrentSession(day, 17 * 60 + 5), "jr");
eq("front desk: 16:15 → opens within the hour", pickCurrentSession(day, 16 * 60 + 15), "jr");
eq("front desk: 14:00 → the next class", pickCurrentSession(day, 14 * 60), "jr");
eq("front desk: 22:00 → the last (canceled skipped)", pickCurrentSession(day, 22 * 60), "mshs");
eq("front desk: no classes", pickCurrentSession([], 600), null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
