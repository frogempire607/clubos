/**
 * Retiring "Advanced billing" (2026-09-28) + the portal auto-renew toggle.
 *
 *   npx tsx scripts/billing-retire-tests.ts
 *
 * Pure: lib/migrationSetup (who sees Migration setup, which sections, where
 * /billing redirects) and lib/autoRenewCopy (the plain-date sentences a
 * family reads before turning auto-renew on or off), plus the offline stop
 * date in lib/autopay that the sentences promise.
 */
import {
  billingIsLive,
  migrationInProgress,
  billingPageDecision,
  migrationSetupSections,
  membershipPanelHref,
  LIVE_BILLING_NOTICE,
} from "../lib/migrationSetup";
import {
  autoRenewCopy,
  howYouPayLine,
  paymentMethodLabel,
  cadencePhrase,
  ordinal,
  monthsBetween,
  type AutoRenewInput,
} from "../lib/autoRenewCopy";
import { offlineStopDate } from "../lib/nonRenewal";

let pass = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); return; }
  failures.push(detail ? `${label} — ${detail}` : label);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}
function eq<T>(label: string, got: T, want: T) {
  check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const NOW = d("2026-09-28");

// ── Who is mid-migration ────────────────────────────────────────────────────
console.log("\nmigrationInProgress");
eq("native member (never imported) is not migrating", migrationInProgress({ imported: false, migrationStatus: null }), false);
eq("imported, not invited yet → migrating", migrationInProgress({ imported: true, migrationStatus: "IMPORTED" }), true);
eq("imported with no status (importedAt only) → migrating", migrationInProgress({ imported: true, migrationStatus: null }), true);
eq("ACTIVATED but not completed → still migrating", migrationInProgress({ imported: true, migrationStatus: "ACTIVATED" }), true);
eq("COMPLETED → done", migrationInProgress({ imported: true, migrationStatus: "COMPLETED" }), false);
eq("migrationCompletedAt stamped → done even if status lags", migrationInProgress({ imported: true, migrationStatus: "ACTIVATED", migrationCompletedAt: "2026-09-01" }), false);
eq("a status with no import facts still counts (status implies import)", migrationInProgress({ imported: false, migrationStatus: "INVITED" }), true);

// ── Live billing ────────────────────────────────────────────────────────────
console.log("\nbillingIsLive");
eq("active Stripe row → live", billingIsLive([{ status: "active" }]), true);
eq("past_due → live", billingIsLive([{ status: "past_due" }]), true);
eq("pending (scheduled first charge) → live", billingIsLive([{ status: "pending" }]), true);
eq("only canceled/expired history → not live", billingIsLive([{ status: "canceled" }, { status: "expired" }]), false);
eq("no rows → not live", billingIsLive([]), false);

// ── Redirect decision ───────────────────────────────────────────────────────
console.log("\nbillingPageDecision");
{
  const r = billingPageDecision({ memberId: "m1", migrating: false, live: true, query: {} });
  eq("not migrating → redirect to the profile memberships tab", r, { kind: "REDIRECT", to: "/dashboard/members/m1?tab=memberships", reason: "NOT_MIGRATING" });
}
{
  const r = billingPageDecision({ memberId: "m1", migrating: false, live: true, query: { changePlan: "sub_9", option: "opt_2" } });
  eq("?changePlan= & option= ride along to the panel", r.kind === "REDIRECT" ? r.to : null, "/dashboard/members/m1?tab=memberships&changePlan=sub_9&option=opt_2");
}
{
  const r = billingPageDecision({ memberId: "m1", migrating: true, live: true, query: { changePlan: "sub_9" } });
  eq("migrating member + changePlan → still the panel (live action)", r.kind === "REDIRECT" ? r.reason : r.kind, "LIVE_ACTION");
}
{
  const r = billingPageDecision({ memberId: "m1", migrating: true, live: false, query: { enrol: "1" } });
  eq("migrating, not live, ?enrol=1 → stays (offline activation lives here)", r.kind, "SHOW");
}
{
  const r = billingPageDecision({ memberId: "m1", migrating: true, live: true, query: { enrol: "1" } });
  eq("migrating, live, ?enrol=1 → the panel", r.kind === "REDIRECT" ? r.to : null, "/dashboard/members/m1?tab=memberships&enrol=1");
}
{
  const r = billingPageDecision({ memberId: "m1", migrating: false, live: false, query: { card_saved: "1", intent: "REPLACE", junk: "x" } });
  eq("card-setup return flags pass through; unknown keys dropped", r.kind === "REDIRECT" ? r.to : null, "/dashboard/members/m1?tab=memberships&card_saved=1&intent=REPLACE");
}
eq("migrating, plain visit → Migration setup", billingPageDecision({ memberId: "m1", migrating: true, live: true, query: {} }).kind, "SHOW");
eq("member ids are URL-encoded", membershipPanelHref("a b"), "/dashboard/members/a%20b?tab=memberships");

// ── Sections ────────────────────────────────────────────────────────────────
console.log("\nmigrationSetupSections");
{
  const s = migrationSetupSections({ live: true, activationAvailable: true, pendingActivation: false, hasReactivationOffer: false });
  eq("LIVE: no setup edit at all (Sal's mistake is impossible)", s.setupEdit, false);
  eq("LIVE: the one-line notice shows", s.liveNotice, true);
  eq("LIVE: no activation button, even if the server says available", s.activate, false);
  eq("LIVE: no payment-method block on this page", s.paymentMethods, false);
  eq("LIVE: no 'Already paid?' form", s.alreadyPaid, false);
  eq("LIVE: triage keeps its note but not the final billing date", [s.triage, s.triageFinalDate], [true, false]);
  eq("LIVE: no new reactivation offer", s.createOffer, false);
  eq("LIVE with no offer ever: the offer card hides", s.reactivation, false);
  eq("LIVE: history still shows", s.history, true);
}
{
  const s = migrationSetupSections({ live: true, activationAvailable: false, pendingActivation: true, hasReactivationOffer: true });
  eq("LIVE with an old offer: offer card shows (read only)", [s.reactivation, s.createOffer], [true, false]);
  eq("pending activation → cancel card shows", s.cancelPendingActivation, true);
}
{
  const s = migrationSetupSections({ live: false, activationAvailable: true, pendingActivation: false, hasReactivationOffer: false });
  eq("DRAFT: setup edit, activation, card collection, already-paid, offer, triage date",
    [s.setupEdit, s.activate, s.paymentMethods, s.alreadyPaid, s.createOffer, s.triageFinalDate, s.liveNotice],
    [true, true, true, true, true, true, false]);
}
eq("DRAFT, activation not available → no activate button",
  migrationSetupSections({ live: false, activationAvailable: false, pendingActivation: false, hasReactivationOffer: false }).activate, false);
check("live notice names the Membership panel and payment", LIVE_BILLING_NOTICE.includes("Membership panel") && LIVE_BILLING_NOTICE.startsWith("Billing is live."));

// ── Offline stop date (the write path the sentences promise) ────────────────
console.log("\nofflineStopDate");
eq("cash, 3-month commitment, paid through month 1 → stops at the commitment end, not early",
  offlineStopDate({ minimumTermEndsAt: d("2026-11-20"), endDate: null, currentPeriodEnd: d("2026-10-20"), paidThroughDate: d("2026-10-20") }, NOW)?.toISOString().slice(0, 10),
  "2026-11-20");
eq("cash, paid past the commitment → keeps the paid time",
  offlineStopDate({ minimumTermEndsAt: d("2026-11-20"), endDate: null, currentPeriodEnd: null, paidThroughDate: d("2027-01-20") }, NOW)?.toISOString().slice(0, 10),
  "2027-01-20");
eq("cash, no commitment → paid-through date",
  offlineStopDate({ minimumTermEndsAt: null, endDate: null, currentPeriodEnd: d("2026-10-15"), paidThroughDate: d("2026-10-27") }, NOW)?.toISOString().slice(0, 10),
  "2026-10-27");
eq("cash, commitment already served → paid-through date",
  offlineStopDate({ minimumTermEndsAt: d("2026-06-01"), endDate: null, currentPeriodEnd: null, paidThroughDate: d("2026-10-27") }, NOW)?.toISOString().slice(0, 10),
  "2026-10-27");
eq("cash, nothing recorded → null (the write refuses)", offlineStopDate({ minimumTermEndsAt: null, endDate: null, currentPeriodEnd: null, paidThroughDate: null }, NOW), null);

// ── Consequence wording ─────────────────────────────────────────────────────
console.log("\nautoRenewCopy");
const base: AutoRenewInput = {
  billing: "CARD", autoRenew: true, status: "active",
  startDate: d("2026-08-20"), minimumTermEndsAt: d("2026-11-20"), endDate: null,
  currentPeriodEnd: d("2026-10-27"), paidThroughDate: null,
  amount: 164.64, billingPeriod: "MONTHLY",
};
{
  const c = autoRenewCopy(base, NOW);
  eq("OFF inside a 3-month commitment — Julian's sentence", c.offSentence,
    "Auto-renew off: your membership ends Nov 20, 2026, after your 3-month commitment. You won't be charged after that.");
  check("ON — renews every month on the 27th for $164.64", c.onSentence.startsWith("On: renews every month on the 27th for $164.64."), c.onSentence);
  check("ON mentions the commitment still running", c.onSentence.includes("Your 3-month commitment runs through Nov 20, 2026."), c.onSentence);
  eq("current state (on) reads the on sentence", c.currentSentence, c.onSentence);
  eq("stopsOn = commitment end", c.stopsOn?.toISOString().slice(0, 10), "2026-11-20");
  eq("can toggle", c.canToggle, true);
}
{
  const c = autoRenewCopy({ ...base, minimumTermEndsAt: null, startDate: null }, NOW);
  eq("OFF month-to-month → ends at the paid period end", c.offSentence,
    "Auto-renew off: your membership ends Oct 27, 2026, at the end of the period you've paid for. You won't be charged after that.");
  eq("ON month-to-month (no commitment tail)", c.onSentence, "On: renews every month on the 27th for $164.64.");
}
{
  const c = autoRenewCopy({ ...base, commitmentMonths: 6 }, NOW);
  check("explicit commitmentMonths wins over the date math", c.offSentence.includes("after your 6-month commitment"), c.offSentence);
}
{
  const c = autoRenewCopy({ ...base, autoRenew: false, endDate: d("2026-11-20"), minimumTermEndsAt: d("2026-11-20") }, NOW);
  eq("already off: current sentence is the off sentence, with the recorded end", c.currentSentence,
    "Auto-renew off: your membership ends Nov 20, 2026, after your 3-month commitment. You won't be charged after that.");
}
{
  // Once off, endDate is the STOP date, not a commitment.
  const c = autoRenewCopy({ ...base, autoRenew: false, minimumTermEndsAt: null, endDate: d("2026-10-27") }, NOW);
  eq("already off with no term: never invents a commitment", c.currentSentence,
    "Auto-renew off: your membership ends Oct 27, 2026, at the end of the period you've paid for. You won't be charged after that.");
}
{
  const c = autoRenewCopy({
    ...base, billing: "OFFLINE", amount: 150, currentPeriodEnd: null, paidThroughDate: d("2026-10-20"),
  }, NOW);
  eq("cash OFF in commitment ends at the commitment end", c.stopsOn?.toISOString().slice(0, 10), "2026-11-20");
  check("cash ON says the club collects", c.onSentence.includes("paid to the club — no card is charged") && c.onSentence.includes("on the 20th for $150.00"), c.onSentence);
}
{
  const c = autoRenewCopy({
    ...base, billing: "OFFLINE", minimumTermEndsAt: null, currentPeriodEnd: null, paidThroughDate: null,
  }, NOW);
  eq("cash with no paid-through: can't turn off (no date to stop on)", c.canToggle, false);
  check("…and says why in plain words", !!c.blockedReason && c.blockedReason.includes("hasn't recorded"), c.blockedReason ?? "");
}
eq("an ended membership can't be toggled", autoRenewCopy({ ...base, status: "canceled" }, NOW).canToggle, false);
{
  const c = autoRenewCopy({ ...base, amount: 0 }, NOW);
  check("a $0 membership names no price", !c.onSentence.includes("$"), c.onSentence);
}
{
  const c = autoRenewCopy({ ...base, minimumTermEndsAt: d("2026-09-01") }, NOW);
  eq("a commitment already served is not a commitment", c.commitmentEndsOn, null);
}

// ── Cadence & helpers ───────────────────────────────────────────────────────
console.log("\ncadence & helpers");
eq("ordinals", [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 27, 31].map(ordinal), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "27th", "31st"]);
eq("weekly names the weekday", cadencePhrase("WEEKLY", d("2026-09-29")), "every week on Tuesdays");
eq("quarterly", cadencePhrase("QUARTERLY", d("2026-10-27")), "every 3 months on the 27th");
eq("annual names the date", cadencePhrase("ANNUAL", d("2026-10-27")), "every year on Oct 27");
eq("no anchor → no day", cadencePhrase("MONTHLY", null), "every month");
eq("3-month term from Aug 20 to Nov 20", monthsBetween(d("2026-08-20"), d("2026-11-20")), 3);
eq("term ending a day early still reads 3", monthsBetween(d("2026-08-20"), d("2026-11-19")), 3);

console.log("\nhowYouPayLine / paymentMethodLabel");
eq("Julian's line — label, next charge, amount",
  howYouPayLine({ billing: "CARD", methodLabel: "Cash App Pay", nextChargeOn: d("2026-10-27"), amount: 164.64, autoRenew: true, stopsOn: d("2026-11-20") }),
  "How you pay: Cash App Pay · next charge Oct 27 · $164.64");
eq("no charge on/after the stop date → no next charge",
  howYouPayLine({ billing: "CARD", methodLabel: "Visa ···· 4242", nextChargeOn: d("2026-10-27"), amount: 164.64, autoRenew: false, stopsOn: d("2026-10-27") }),
  "How you pay: Visa ···· 4242");
eq("cash fallback wording",
  howYouPayLine({ billing: "OFFLINE", methodLabel: null, nextChargeOn: d("2026-10-20"), amount: 150, autoRenew: true, stopsOn: null }),
  "How you pay: Cash or check at the club · next payment due Oct 20 · $150.00");
eq("label wins", paymentMethodLabel({ label: "Cash App Pay", brand: "visa", last4: "4242" }), "Cash App Pay");
eq("brand/last4 fallback", paymentMethodLabel({ brand: "american_express", last4: "0005" }), "American Express ···· 0005");
eq("link type", paymentMethodLabel({ type: "link" }), "Link");
eq("nothing → null", paymentMethodLabel(null), null);

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
