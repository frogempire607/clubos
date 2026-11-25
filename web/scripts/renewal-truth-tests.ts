/**
 * What a membership will actually do, whatever its stored flag says.
 *
 *   npx tsx scripts/renewal-truth-tests.ts
 *
 * No database, no Stripe. Relative dates only. The shapes are the real ones
 * found on 2026-11-25 (12 rows flagged "renews" that Stripe will stop, one end
 * date Stripe never got, one "doesn't renew" with no stop anywhere).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { endsBeforeNextCharge, renewalDay, renewalLine, renewalTruth, switchLine, type RenewalFacts } from "../lib/renewalTruth";
import { stopFromEvent, stopOf, type StopEvent } from "../lib/stripeStops";
import { renewalAmount, truthFor, viewOf, type RenewalRow } from "../lib/renewalServer";
import { describeForPortal } from "../lib/memberAutoRenewAccess";
import { derivePanel, type PanelSub } from "../lib/membershipPanel";

const ROOT = join(__dirname, "..");
const code = (rel: string) =>
  readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, (_m, p1) => p1);

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || detail === "" ? "" : `  — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}

const DAY = 86_400_000;
const now = new Date();
/** A billing day N days from now, at 00:00 UTC like every stored billing date. */
const day = (n: number) => new Date(Math.floor(now.getTime() / DAY) * DAY + n * DAY);
/** The expected words for a day, built independently of the code under test. */
const words = (d: Date) =>
  d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(d.getUTCFullYear() !== now.getUTCFullYear() ? { year: "numeric" as const } : {}), timeZone: "UTC" });

const F = (o: Partial<RenewalFacts>): RenewalFacts => ({ hasStripe: true, status: "active", autoRenew: true, endDate: null, stripeStop: null, currentPeriodEnd: day(8), amount: 110, ...o });
const line = (o: Partial<RenewalFacts>) => renewalLine(renewalTruth(F(o)), now);
const sw = (o: Partial<RenewalFacts>) => switchLine(renewalTruth(F(o)), now);

console.log("\n§1 card memberships");
{
  const bishop = { autoRenew: true, endDate: day(8), stripeStop: day(8) };
  check("flag on, Stripe stops it: “Ends Dec 3 · doesn't renew”", line(bishop) === `Ends ${words(day(8))} · doesn't renew`, line(bishop));
  check("…and the switch says “Off · ends Dec 3”", sw(bishop) === `Off · ends ${words(day(8))}`, sw(bishop));
  check("…named as a mismatch", renewalTruth(F(bishop)).mismatch === "FLAG_ON_BUT_ENDS");
  check("a plain renewing card: “Renews Dec 3 · $110”", line({}) === `Renews ${words(day(8))} · $110`, line({}));
  check("…switch on, no mismatch", sw({}) === `On · renews ${words(day(8))} · $110` && renewalTruth(F({})).mismatch === null, sw({}));
  check("cents only when there are cents", line({ amount: 113.59 }).endsWith("· $113.59"));
  check("free says no amount", line({ amount: 0 }) === `Renews ${words(day(8))}`);
  const titus = { autoRenew: true, endDate: day(230), stripeStop: null, currentPeriodEnd: day(230) };
  check("an end date Stripe never received: it renews, and says so", line(titus) === `Renews ${words(day(230))} · $110`, line(titus));
  const logan = { autoRenew: false, endDate: null, stripeStop: null };
  check("flag off with no stop at Stripe: it renews, and that's a mismatch", line(logan) === `Renews ${words(day(8))} · $110` && renewalTruth(F(logan)).mismatch === "FLAG_OFF_BUT_RENEWS");
  check("flag off and Stripe stops it: agrees, no mismatch", line({ autoRenew: false, endDate: day(8), stripeStop: day(8) }) === `Ends ${words(day(8))} · doesn't renew` && renewalTruth(F({ autoRenew: false, stripeStop: day(8) })).mismatch === null);
  check("Stripe's date wins over ours", line({ endDate: day(40), stripeStop: day(8) }) === `Ends ${words(day(8))} · doesn't renew`);
  check("ends later than the next charge (a 12-month plan): the stop, not the period", line({ endDate: day(365), stripeStop: day(365) }) === `Ends ${words(day(365))} · doesn't renew`);
  check("Stripe not known: the row's end date", line({ endDate: day(8), stripeStop: undefined }) === `Ends ${words(day(8))} · doesn't renew`);
  check("Stripe not known, flag off, no date: ends with the period", line({ autoRenew: false, stripeStop: undefined }) === `Ends ${words(day(8))} · doesn't renew`);
  check("Stripe not known, flag on, no date: renews", line({ stripeStop: undefined }) === `Renews ${words(day(8))} · $110`);
  check("no period date yet: still honest", line({ currentPeriodEnd: null }) === "Renews automatically · $110" && sw({ currentPeriodEnd: null }) === "On · renews automatically");
}

console.log("\n§2 cash and check");
{
  const cash = (o: Partial<RenewalFacts>) => line({ hasStripe: false, stripeStop: undefined, currentPeriodEnd: null, paidThroughDate: day(20), ...o });
  check("with an end date it ends, whatever the flag says", cash({ endDate: day(20), autoRenew: true }) === `Ends ${words(day(20))} · doesn't renew` && cash({ endDate: day(20), autoRenew: false }) === `Ends ${words(day(20))} · doesn't renew`);
  check("with none it renews when paid", cash({ autoRenew: false }) === `Paid through ${words(day(20))} · renews when paid` && cash({ paidThroughDate: null }) === "Renews when paid");
  check("…and is never called a mismatch", renewalTruth(F({ hasStripe: false, autoRenew: false, stripeStop: undefined })).mismatch === null);
}

console.log("\n§3 already ended");
{
  const orson = { status: "canceled", autoRenew: true, endDate: day(-2), canceledAt: day(-2) };
  check("flag still on: “Ended Nov 23”, never “auto-renew on”", line(orson) === `Ended ${words(day(-2))}` && sw(orson) === `Off · ended ${words(day(-2))}`, [line(orson), sw(orson)]);
  check("expired cash row", line({ hasStripe: false, status: "expired", expiredAt: day(-9), endDate: day(-10) }) === `Ended ${words(day(-9))}`);
}

console.log("\n§4 dates and the next charge");
{
  const other = new Date(Date.UTC(now.getUTCFullYear() + 1, 1, 9));
  check("another year is named", renewalDay(other, now) === `Feb 9, ${now.getUTCFullYear() + 1}`);
  check("a stored day never slips to the day before", renewalDay(new Date(Date.UTC(now.getUTCFullYear(), 11, 3)), now) === "Dec 3");
  check("it ends on the next charge date: there is no next charge", endsBeforeNextCharge(renewalTruth(F({ stripeStop: day(8) })), day(8)));
  check("it ends months later: there is one", !endsBeforeNextCharge(renewalTruth(F({ stripeStop: day(60) })), day(8)));
  check("it renews: there is one", !endsBeforeNextCharge(renewalTruth(F({})), day(8)));
  check("Stripe's stop a few seconds into the day still counts", endsBeforeNextCharge(renewalTruth(F({ stripeStop: new Date(day(8).getTime() + 30_000) })), day(8)));
}

console.log("\n§5 what Stripe told us");
{
  const unix = (d: Date) => String(Math.floor(d.getTime() / 1000));
  const e = (o: Partial<StopEvent>): StopEvent => ({ sid: "sub", cancel_at: null, at_period_end: "false", period_end: unix(day(8)), item_period_end: null, ...o });
  check("cancel_at is the stop", stopFromEvent(e({ cancel_at: unix(day(60)) }))!.getTime() === day(60).getTime());
  check("cancel at period end is the period end (either place Stripe keeps it)", stopFromEvent(e({ at_period_end: "true" }))!.getTime() === day(8).getTime() && stopFromEvent(e({ at_period_end: "true", period_end: null, item_period_end: unix(day(9)) }))!.getTime() === day(9).getTime());
  check("neither = no stop", stopFromEvent(e({})) === null && stopFromEvent(e({ cancel_at: "" })) === null);
  const stops = new Map([["a", day(8)], ["b", null]]);
  check("known stop, known none, not known are three different answers", stopOf(stops, "a")!.getTime() === day(8).getTime() && stopOf(stops, "b") === null && stopOf(stops, "c") === undefined && stopOf(stops, null) === undefined);
  const src = code("lib/stripeStops.ts");
  check("it reads stored events only: no Stripe call, no write", !/stripe\.(subscriptions|invoices)|\.update\(|\.create\(|INSERT|UPDATE |DELETE/.test(src));
  const row: RenewalRow = { id: "s", status: "active", price: "110.00", autoRenew: true, endDate: day(8), currentPeriodEnd: day(8), paidThroughDate: null, stripeSubscriptionId: "a" };
  check("the amount shown is what the card is charged, fee included", renewalAmount(row, true) > 110 && renewalAmount(row, false) === 110 && renewalAmount({ ...row, stripeSubscriptionId: null }, true) === 110);
  check("rows, stops and the rule together", viewOf(truthFor(row, stops, false), now).line === `Ends ${words(day(8))} · doesn't renew` && truthFor({ ...row, stripeSubscriptionId: "b" }, stops, false).kind === "RENEWS");
}

console.log("\n§6 the member portal switch");
{
  const person = { memberId: "m", firstName: "Richard", lastName: "Bishop", isSelf: true };
  const base = { id: "s", memberId: "m", status: "active", autoRenew: true, optionLabel: "Monthly", price: "110", billingPeriod: "MONTHLY", billingType: "RECURRING", stripeSubscriptionId: "a", startDate: day(-22), endDate: day(8), minimumTermEndsAt: day(8), currentPeriodEnd: day(8), paidThroughDate: day(8), membership: { name: "Plan" } };
  const d = (sub: Partial<typeof base>, stop: Date | null | undefined) => describeForPortal({ sub: { ...base, ...sub } as never, person, passProcessingFees: false, card: null, lastPaidMethod: null, stripeStop: stop, now });
  const r = d({}, day(8));
  check("flagged on but ending: shows Off and the end", r.autoRenew === false && r.renewal === `Ends ${words(day(8))} · doesn't renew` && /^Auto-renew off: your membership ends/.test(r.copy.currentSentence), r);
  check("…and can't be flipped here (pressing it would do nothing and claim it worked)", r.locked && r.copy.canToggle === false && r.copy.blockedReason === "Want to keep it going? Ask your club.");
  check("…with no next charge promised", !/next charge/.test(r.howYouPay), r.howYouPay);
  const t = d({ endDate: day(230), minimumTermEndsAt: null as never }, null);
  check("an end date Stripe never got: shows On, no commitment made up from it", t.autoRenew && t.renewal!.startsWith("Renews") && !/commitment/.test(t.copy.currentSentence), t.copy.currentSentence);
  const l = d({ autoRenew: false, endDate: null as never, minimumTermEndsAt: null as never }, null);
  check("flagged off but renewing: shows On, and locked", l.autoRenew && l.locked && l.copy.blockedReason === "Want to stop it? Ask your club.");
  const ok = d({ endDate: null as never, minimumTermEndsAt: null as never }, null);
  check("flag and truth agree: unchanged, still theirs to flip", ok.autoRenew && !ok.locked && ok.copy.canToggle);
  const off = d({ autoRenew: false }, day(8));
  check("off and ending, agreed: still theirs to turn back on", !off.autoRenew && !off.locked && off.copy.canToggle);
  const route = code("app/api/member/subscriptions/[id]/auto-renew/route.ts");
  check("the server refuses a locked switch before any change", route.indexOf("before.locked") > 0 && route.indexOf("before.locked") < route.indexOf("await setAutoRenew("));
}

console.log("\n§7 the staff panel");
{
  const s = (o: Partial<PanelSub>): PanelSub => ({ id: "s", planName: "Plan", optionLabel: "Monthly", price: 110, billingPeriod: "MONTHLY", billingType: "RECURRING", status: "active", stripeStatus: "active", hasStripe: true, startDate: day(-22), endDate: day(8), currentPeriodEnd: day(8), paidThroughDate: day(8), autoRenew: true, minimumTermEndsAt: null, deliberateFree: false, cancelAt: day(8), stripeStopKnown: true, card: null, createdAt: day(-22), pausedAt: null, pausedUntil: null, ...o });
  const v = (o: Partial<PanelSub>) => derivePanel({ firstName: "R", memberStatus: "ACTIVE", subs: [s(o)], draft: null, hasCard: true, cardLabel: null, requestedPaymentMethod: null, payerName: null, passProcessingFees: false, now });
  check("ending: the pill, the fact and the money line all say so", /^Ends /.test(v({}).pill.label) && v({}).facts!.renews === `Ends ${words(day(8))} · doesn't renew` && /no renewal$/.test(v({}).moneyLine), v({}).facts);
  check("ending is told the same way when only the row knows", v({ cancelAt: null, stripeStopKnown: false }).facts!.renews === `Ends ${words(day(8))} · doesn't renew`);
  check("an end date Stripe never got: renews", v({ cancelAt: null }).facts!.renews === `Renews ${words(day(8))} · $110` && v({ cancelAt: null }).pill.label === "Active");
  check("cash with an end date and the flag on: ends", v({ hasStripe: false, cancelAt: null, stripeStatus: null }).facts!.renews === `Ends ${words(day(8))} · doesn't renew`);
  const route = code("app/api/members/[id]/membership-panel/route.ts");
  check("the switch text comes from the one rule", /nowText: truth\.kind === "WHEN_PAID" && renews \? "On · renews when paid" : switchLine\(truth, now\)/.test(route));
  check("a live answer from Stripe wins over a stored one", /stripeStop: live \? live\.cancelAt :/.test(route));
}

console.log("\n§8 the lists");
{
  const items = code("lib/reportsActionItems.ts");
  check("Action Center lists only memberships that will really stop, on the real day", /\.filter\(\(s\) => s\.truth\.kind === "ENDS"/.test(items) && /dayFmt\(endsAt\)/.test(items));
  check("…and “large renewals” leaves out the ones that end", /!endsBeforeNextCharge\(truthFor\(s, upcomingStops, false\), s\.currentPeriodEnd\)/.test(items));
  check("…and prints billing days as stored (UTC)", /year: "numeric", timeZone: "UTC" \}\);/.test(items));
  const roster = code("lib/membersQuery.ts");
  check("the renewal queues say per row which it is", (roster.match(/withRenewalLines\(clubId, f,/g) ?? []).length === 2 && /renewalLines/.test(code("components/members/MembersRoster.tsx")));
  const profile = code("app/dashboard/members/[id]/page.tsx");
  check("the profile's next charge ignores the flag when the truth is known", /chargesAgain/.test(profile) && !/activeSub\.autoRenew !== false && !activeSub\.canceledAt/.test(profile));
  check("membership rows say what will happen (and “Ended …” once over)", /renewal\.line/.test(profile));
  const billing = code("app/api/member/billing/route.ts");
  check("the portal's billing card names no next charge for one that stops first", /!endsBeforeNextCharge\(renewal, active\.currentPeriodEnd\)/.test(billing) && /endsOn: renewal\?\.kind === "ENDS" \? renewal\.endsAt : null/.test(billing));
  check("the activation email no longer says “Renews” beside an end date", !/>Renews \$\{endDate/.test(code("lib/email.ts")));
}

console.log("\n§9 display only");
{
  for (const f of ["lib/autopay.ts", "lib/nonRenewal.ts", "lib/membershipMoney.ts", "lib/membershipMoneyServer.ts", "lib/cardActivation.ts", "lib/chargeDate.ts"]) {
    check(`no billing code reads it: ${f}`, !/renewalTruth|renewalServer|stripeStops/.test(code(f)));
  }
  for (const f of ["lib/renewalTruth.ts", "lib/renewalServer.ts", "lib/stripeStops.ts"]) {
    check(`it writes nothing: ${f}`, !/\.(update|updateMany|create|createMany|delete|deleteMany|upsert|executeRaw)\(|\$executeRaw/.test(code(f)));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
