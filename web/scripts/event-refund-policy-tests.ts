/**
 * Event refund policy (2026-11-25).
 *
 *   npx tsx scripts/event-refund-policy-tests.ts
 *
 * No database. Relative dates only. Runs twice in the build (UTC and Los
 * Angeles) because the server runs UTC and a phone does not: a deadline is the
 * CLUB's time wherever it is worked out.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHARGE_MARGIN_MS,
  NON_REFUNDABLE_CHECKBOX,
  chargeMayBeRunning,
  daysBeforeInZone,
  longDeadline,
  normalizeRefundPolicy,
  readRefundPolicy,
  refundIsOpen,
  refundOverride,
  refundPolicyView,
  selfCancelPlan,
  shortDeadline,
  type RefundPolicyEvent,
} from "../lib/eventRefundPolicy";
import { wallClockUTCToInstant, tzOffsetMs } from "../lib/datetime";
import { renderableRegistrationState } from "../lib/registrationRenderState";
import { renderLifecycleEmailHtml, renderLifecycleEmailText } from "../lib/eventLifecycleEmails";

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

const NY = "America/New_York";
const DAY = 86_400_000;
const now = new Date();
/** A club-clock moment N days from now at hh:mm. */
function at(days: number, hh: number, mm = 0, tz = NY): Date {
  const wall = new Date(now.getTime() + tzOffsetMs(tz, now) + days * DAY);
  const p = (n: number) => String(n).padStart(2, "0");
  return wallClockUTCToInstant(`${wall.toISOString().slice(0, 10)}T${p(hh)}:${p(mm)}:00Z`, tz);
}
/** What the club's clock reads at a moment. */
const wallOf = (d: Date, tz = NY) => new Date(d.getTime() + tzOffsetMs(tz, d)).toISOString().slice(0, 16);
/** The expected words, built independently of the code under test. */
function words(d: Date, o: { weekday: boolean; zone: boolean }, tz = NY): string {
  const y = (x: Date) => new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone: tz }).format(x);
  const date = new Intl.DateTimeFormat("en-US", { ...(o.weekday ? { weekday: "short" as const } : {}), month: "short", day: "numeric", ...(y(d) !== y(now) ? { year: "numeric" as const } : {}), timeZone: tz }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", ...(o.zone ? { timeZoneName: "short" as const } : {}), timeZone: tz }).format(d);
  return `${date}, ${time}`.replace(/[  ]/g, " ");
}
const E = (o: Partial<RefundPolicyEvent>): RefundPolicyEvent => ({ startsAt: at(20, 9), ...o });
const club = { timezone: NY, passProcessingFees: true, passPlatformFee: false };
const lines = (e: RefundPolicyEvent, c: { timezone?: string | null; passProcessingFees?: boolean } = club, n = now) => refundPolicyView(e, c, n)?.lines ?? null;

console.log("\n§1 each policy, in words");
{
  check("not set → nothing at all", lines(E({})) === null && lines(E({ refundPolicy: null, refundNote: "x" })) === null);
  check("a value nobody recognises → nothing at all", lines(E({ refundPolicy: "SOMETIMES" })) === null);
  check("anytime", lines(E({ refundPolicy: "ANYTIME" }))![0] === "Refundable anytime before the event.");
  check("non-refundable", lines(E({ refundPolicy: "NONE" }))![0] === "Non-refundable. Once you pay, you won't get a refund.");
  const until = at(6, 17);
  check("until a date and time, with the club's date, time and zone", lines(E({ refundPolicy: "UNTIL", refundUntilAt: until }))![0] === `Refundable until ${words(until, { weekday: true, zone: true })}. After that, no refunds.`, lines(E({ refundPolicy: "UNTIL", refundUntilAt: until })));
  check("…and it really says 5:00 PM with an Eastern zone", /5:00 PM E[SD]T/.test(lines(E({ refundPolicy: "UNTIL", refundUntilAt: until }))![0]));
  const past = at(-2, 17);
  check("after the date it says when it was, and that there are none now", lines(E({ refundPolicy: "UNTIL", refundUntilAt: past }))![0] === `The refund deadline was ${words(past, { weekday: true, zone: true })}. No refunds now.`);
  const charge = at(5, 7);
  check("until the card is charged shows that date", lines(E({ refundPolicy: "UNTIL_CHARGED", autoChargeDate: charge }))![0] === `Refundable until cards are charged on ${words(charge, { weekday: true, zone: true })}. After that, no refunds.`);
  check("…with no charge date set, cards are charged when the event starts", readRefundPolicy(E({ refundPolicy: "UNTIL_CHARGED" }), NY)!.deadline!.getTime() === new Date(E({}).startsAt).getTime());
  const charged = at(-1, 7);
  check("…and after it", lines(E({ refundPolicy: "UNTIL_CHARGED", autoChargeDate: charged }))![0] === `Refunds ended when cards were charged on ${words(charged, { weekday: true, zone: true })}. No refunds now.`);
  check("the note is kept, last", lines(E({ refundPolicy: "ANYTIME", refundNote: "  Weigh-in fees are non-refundable " }))!.at(-1) === "Weigh-in fees are non-refundable");
  check("the card fee line only when the club adds one, and only while refunds are open",
    lines(E({ refundPolicy: "ANYTIME" }))!.some((l) => /processing fee isn't refunded/.test(l)) &&
    !lines(E({ refundPolicy: "ANYTIME" }), { timezone: NY, passProcessingFees: false })!.some((l) => /processing fee/.test(l)) &&
    !lines(E({ refundPolicy: "NONE" }))!.some((l) => /processing fee/.test(l)));
  check("a half-filled “until” says nothing rather than something untrue", lines(E({ refundPolicy: "UNTIL" })) === null);
  check("another year is named", longDeadline(new Date(now.getTime() + 400 * DAY), NY, now).includes(String(new Date(now.getTime() + 400 * DAY).getUTCFullYear())) || /\d{4}/.test(longDeadline(new Date(now.getTime() + 400 * DAY), NY, now)));
  check("a bad timezone never throws", typeof longDeadline(until, "Not/AZone", now) === "string" && readRefundPolicy(E({ refundPolicy: "UNTIL", refundUntilDays: 3 }), "Not/AZone") !== null);
}

console.log("\n§2 deadlines on the club's clock");
{
  const start = at(20, 9);
  const p = readRefundPolicy(E({ startsAt: start, refundPolicy: "UNTIL", refundUntilDays: 3 }), NY)!;
  check("3 days before a 9:00 AM event is 9:00 AM, three calendar days earlier, there", wallOf(p.deadline!) === wallOf(at(17, 9)), [wallOf(p.deadline!), wallOf(at(17, 9))]);
  check("0 days before is the start itself", readRefundPolicy(E({ startsAt: start, refundPolicy: "UNTIL", refundUntilDays: 0 }), NY)!.deadline!.getTime() === start.getTime());
  check("a date and time wins over days", readRefundPolicy(E({ refundPolicy: "UNTIL", refundUntilAt: at(4, 12), refundUntilDays: 3 }), NY)!.deadline!.getTime() === at(4, 12).getTime());
  check("the same days-before means a different moment in another club's zone, same clock reading",
    wallOf(daysBeforeInZone(at(20, 9, 0, "America/Los_Angeles"), 3, "America/Los_Angeles"), "America/Los_Angeles").endsWith("T09:00"));
  // The next two clock changes from today, found rather than written down.
  let change: Date | null = null;
  for (let i = 1; i < 400 && !change; i++) {
    const a = new Date(now.getTime() + i * DAY), b = new Date(now.getTime() + (i + 1) * DAY);
    if (tzOffsetMs(NY, a) !== tzOffsetMs(NY, b)) change = b;
  }
  const dayNo = Math.round((change!.getTime() - now.getTime()) / DAY);
  const afterChange = at(dayNo + 2, 9);
  const d = daysBeforeInZone(afterChange, 5, NY);
  check("across a clock change it is still 9:00 AM", wallOf(d).endsWith("T09:00") && wallOf(afterChange).endsWith("T09:00"), [wallOf(d), wallOf(afterChange)]);
  check("…which is not a multiple of 24 hours", (afterChange.getTime() - d.getTime()) % DAY !== 0);
  check("with no club timezone it is plain 24-hour days", daysBeforeInZone(start, 2, null).getTime() === start.getTime() - 2 * DAY);
  const open = readRefundPolicy(E({ refundPolicy: "UNTIL", refundUntilAt: at(2, 17) }), NY)!;
  const edge = open.deadline!;
  check("open one second before, closed at the moment itself", refundIsOpen(open, new Date(edge.getTime() - 1000)) && !refundIsOpen(open, edge) && !refundIsOpen(open, new Date(edge.getTime() + 1)));
  check("anytime is always open, non-refundable never", refundIsOpen({ kind: "ANYTIME", deadline: null, note: null }, now) && !refundIsOpen({ kind: "NONE", deadline: null, note: null }, now));
}

console.log("\n§3 the checkbox");
{
  const must = (o: Partial<RefundPolicyEvent>) => refundPolicyView(E(o), club, now)!.mustAcknowledge;
  check("required for non-refundable, and once the deadline has passed", must({ refundPolicy: "NONE" }) && must({ refundPolicy: "UNTIL", refundUntilAt: at(-1, 9) }) && must({ refundPolicy: "UNTIL_CHARGED", autoChargeDate: at(-1, 7) }));
  check("not while refunds are open", !must({ refundPolicy: "ANYTIME" }) && !must({ refundPolicy: "UNTIL", refundUntilAt: at(1, 9) }));
  check("it says exactly “I understand this is non-refundable.”", NON_REFUNDABLE_CHECKBOX === "I understand this is non-refundable.");
  const reg = code("app/api/member/events/[id]/register/route.ts");
  check("the member route refuses a confirm without it", /refundView\?\.mustAcknowledge && body\.acknowledgeNonRefundable !== true/.test(reg) && (reg.match(/const noAck = refundNotAcknowledged\(\);/g) ?? []).length === 2);
  const gate = reg.indexOf("if (!reviewOnly) {\n      const noAck");
  check("…before a guardian approval is queued and before any paid write", gate > 0 && gate < reg.indexOf("await applyParentalControls(") && gate < reg.indexOf("const upsertRegistrationRow"));
  const splitGate = reg.indexOf("const noAck = refundNotAcknowledged();");
  check("…and before a shared-cost registration is written", splitGate > reg.indexOf("if (hasVariableCost)") && splitGate < reg.indexOf("const reg = await requestCoachReview(estPerHead);"));
  check("a guardian's later approval carries the tick", /acknowledgeNonRefundable: true/.test(reg.slice(reg.indexOf("kind: \"EVENT_REGISTER\""), reg.indexOf("kind: \"EVENT_REGISTER\"") + 900)));
  const pub = code("app/api/public/events/[slug]/register/route.ts");
  const pubGate = pub.indexOf("refundView?.mustAcknowledge && body.acknowledgeNonRefundable !== true");
  check("the public route refuses without it, before anything is written", pubGate > 0 && pubGate < pub.indexOf("db.eventRegistration.create"));
  check("the tick is stored where it can't be forged or shown as an answer", /__nonRefundableAcknowledged/.test(pub) && /__nonRefundableAcknowledged/.test(reg));
  const flow = code("components/member/events/registerFlow.tsx");
  check("both confirm screens block their button until it is ticked", /\(needsRefundAck && !nonRefundable\)\}/.test(flow) && /\(needsRefundAck && !nonRefundable\);/.test(flow));
  check("free and covered spots are never asked", /r\.pricing === "FREE" \|\| r\.pricing === "COVERED" \? null : refundView/.test(reg));
}

console.log("\n§4 staff: a warning, never a lock");
{
  const passed = at(-3, 17);
  const o = refundOverride(E({ refundPolicy: "UNTIL", refundUntilAt: passed }), NY, now)!;
  check("“This is past the refund deadline (Dec 1, 5:00 PM).”", o.warning === `This is past the refund deadline (${words(passed, { weekday: false, zone: false })}).`, o.warning);
  check("…short form: month, day, time", /^[A-Z][a-z]{2} \d{1,2}(, \d{4})?, 5:00 PM$/.test(shortDeadline(passed, NY, now)), shortDeadline(passed, NY, now));
  check("non-refundable events warn too", refundOverride(E({ refundPolicy: "NONE" }), NY, now)!.warning === "This event is non-refundable.");
  check("no warning before the deadline, or when no policy is set", refundOverride(E({ refundPolicy: "UNTIL", refundUntilAt: at(1, 9) }), NY, now) === null && refundOverride(E({}), NY, now) === null && refundOverride(E({ refundPolicy: "ANYTIME" }), NY, now) === null);
  check("the override is recorded with the deadline", o.audit.policyOverride === true && o.audit.deadline === passed.toISOString() && /past the refund deadline/.test(o.auditNote));
  const engine = code("lib/eventRefundServer.ts");
  check("it goes on the audit row of a refund and of a refused try", (engine.match(/\.\.\.\(override\?\.audit \?\? \{\}\)/g) ?? []).length === 2);
  check("only a person's choice is an override (a coach's decline isn't)", /input\.byStaff \? refundOverride/.test(engine) && !/byStaff/.test(code("lib/eventApproval.ts")));
  for (const f of ["app/api/events/[id]/registrations/[regId]/refund/route.ts", "app/api/events/[id]/registrations/[regId]/route.ts"]) check(`staff refunds say so: ${f.split("/").slice(-2).join("/")}`, /byStaff: true/.test(code(f)));
  check("the sheet shows the warning and keeps the button", /data\.policyWarning && !data\.blocked/.test(code("components/events/attendees/RefundSheet.tsx")));
}

console.log("\n§5 a family cancels itself");
{
  const R = { status: "PAID", paidCents: 6211, priceLeftCents: 6000, leftCents: 6211, feeCents: 211, byCard: true, charging: false };
  const until = (d: Date) => readRefundPolicy(E({ refundPolicy: "UNTIL", refundUntilAt: d }), NY);
  const P = (policy: ReturnType<typeof until>, regs = [R], priced = true) => selfCancelPlan({ policy, now, tz: NY, priced, registrations: regs });
  const open = P(until(at(2, 17)));
  check("before the deadline: the event price goes back, and says the fee doesn't", open.kind === "REFUND" && open.refundCents === 6000 && /\$60\.00 back on the card/.test(open.text) && /\$2\.11 card processing fee isn't refunded/.test(open.text), open);
  const passed = at(-2, 17);
  const late = P(until(passed));
  check("after it: no refund, with the date, before they confirm", late.kind === "NO_REFUND" && late.refundCents === 0 && late.text === `The refund deadline was ${words(passed, { weekday: true, zone: true })}. If you cancel now, you won't get a refund.`, late.text);
  check("non-refundable says so", P(readRefundPolicy(E({ refundPolicy: "NONE" }), NY)).text === "This event is non-refundable. If you cancel, you won't get a refund.");
  check("not charged yet: they won't be", P(until(passed), [{ ...R, status: "SCHEDULED", paidCents: 0, priceLeftCents: 0, leftCents: 0 }]).kind === "NOT_CHARGED");
  check("being charged right now: wait", P(until(at(2, 17)), [{ ...R, status: "SCHEDULED", paidCents: 0, charging: true }]).kind === "BLOCKED");
  check("paid in cash: the club returns it", P(until(at(2, 17)), [{ ...R, byCard: false }]).kind === "RETURN_BY_HAND");
  check("already refunded: nothing more", P(until(at(2, 17)), [{ ...R, priceLeftCents: 0, leftCents: 211 }]).kind === "NO_REFUND");
  check("no policy set and paid: exactly as before, the club reviews it", P(null).kind === "LEGACY");
  // No policy, but the card hasn't been charged (2026-11-25): it must not be.
  const S = { ...R, status: "SCHEDULED", paidCents: 0, priceLeftCents: 0, leftCents: 0, feeCents: 0, byCard: false };
  check("no policy, card charge still to come: canceling stops it, and says so", P(null, [S]).kind === "NOT_CHARGED" && P(null, [S]).text === "You haven't been charged for this. If you cancel, you won't be.", P(null, [S]));
  check("no policy, charge may be running: can't cancel right now", P(null, [{ ...S, charging: true }]).kind === "BLOCKED");
  check("no policy, owes cash or an invoice: unchanged", P(null, [{ ...S, status: "AWAITING_CASH" }]).kind === "LEGACY" && P(null, [{ ...S, status: "REGISTERED" }]).kind === "LEGACY");
  check("no policy, two registrations with a charge to come: a person decides, and they're told about the charge", P(null, [S, S]).kind === "LEGACY" && /card charge is still scheduled/.test(P(null, [S, S]).text));
  check("…the same with a policy", P(until(at(2, 17)), [S, R]).kind === "LEGACY" && /card charge is still scheduled/.test(P(until(at(2, 17)), [S, R]).text));
  const charge = (o: Partial<Parameters<typeof chargeMayBeRunning>[0]>) => chargeMayBeRunning({ status: "SCHEDULED", stripePaymentIntentId: null, scheduledChargeAt: at(3, 7), lastChargeError: null, ...o }, now);
  check("days away with nothing started: safe to take back", !charge({}) && !charge({ scheduledChargeAt: null }));
  check("due, or seconds from due: not safe (the runner reads a due row, then charges)", charge({ scheduledChargeAt: now }) && charge({ scheduledChargeAt: new Date(now.getTime() + CHARGE_MARGIN_MS - 1000) }) && !charge({ scheduledChargeAt: new Date(now.getTime() + CHARGE_MARGIN_MS + 1000) }));
  check("a payment exists, or an earlier try never got an answer: not safe", charge({ stripePaymentIntentId: "pi" }) && charge({ lastChargeError: "timeout" }));
  check("only scheduled cards are ever 'charging'", !charge({ status: "PAID", stripePaymentIntentId: "pi" }) && !charge({ status: "AWAITING_CASH" }));
  check("no money record: no refund after the deadline, the club before it", P(until(passed), []).kind === "NO_REFUND" && P(until(at(2, 17)), []).kind === "LEGACY" && P(until(passed), [], false).kind === "LEGACY");
  check("two registrations: a person decides", P(until(at(2, 17)), [R, R]).kind === "LEGACY");
  check("what they agreed to changes when the deadline passes", open.token !== late.token);
  const route = code("app/api/member/bookings/cancel/route.ts");
  check("the server refuses terms they weren't shown, before canceling anything", /data\.agreed !== policyCancel\.plan\.token/.test(route) && route.indexOf("data.agreed !== policyCancel.plan.token") < route.indexOf("await runSelfCancel("));
  const run = code("lib/eventSelfCancelServer.ts");
  check("it refunds the event price only, through the one engine, and removes only after", /mode: "price"/.test(run) && /remove: true,\s*keepBooking: true/.test(run));
  check("a refused refund cancels nothing, and never tells the family about the club's balance", /nothing was canceled and you still have your spot/.test(run) && !/message: r\.error/.test(run));
  check("a canceled scheduled charge can't run, and can't race one that started", /scheduledChargeAt: null/.test(run) && /stripePaymentIntentId: null/.test(run));
  check("…checked again in the write itself, not just when the sheet opened", /lastChargeError: null, OR: \[\{ scheduledChargeAt: null \}, \{ scheduledChargeAt: \{ gt: new Date\(Date\.now\(\) \+ CHARGE_MARGIN_MS\) \} \}\]/.test(run));
  check("registrations are read with or without a policy", !/policy\s*\?\s*await prisma\.eventRegistration/.test(run));
  check("the runner still charges SCHEDULED rows only", /reg\.status !== "SCHEDULED"/.test(code("lib/eventAutoCharge.ts")));
  check("staff are told when a charge is left for them to decide", /policyCancel\?\.scheduledLeft/.test(route) && /STILL SCHEDULED/.test(route));
}

console.log("\n§6 saving it");
{
  const n = (i: Parameters<typeof normalizeRefundPolicy>[0]) => normalizeRefundPolicy(i);
  const col = (i: Parameters<typeof normalizeRefundPolicy>[0]) => { const r = n(i); return r.ok ? r.columns : "bad"; };
  check("not sent → nothing changes", col({}) === null);
  check("“Not set” clears all four", JSON.stringify(col({ refundPolicy: null })) === JSON.stringify({ refundPolicy: null, refundUntilAt: null, refundUntilDays: null, refundNote: null }));
  const iso = at(4, 17).toISOString();
  check("a date and time is kept, days are dropped", (() => { const c = col({ refundPolicy: "UNTIL", refundUntilAt: iso, refundUntilDays: 3 }); return !!c && c !== "bad" && c.refundUntilAt!.toISOString() === iso && c.refundUntilDays === null; })());
  check("days are kept when there's no date", (() => { const c = col({ refundPolicy: "UNTIL", refundUntilDays: 3 }); return !!c && c !== "bad" && c.refundUntilDays === 3; })());
  check("“until” with neither is refused in words", (() => { const r = n({ refundPolicy: "UNTIL" }); return !r.ok && /Set when refunds stop/.test(r.error); })());
  check("silly days and unknown policies are refused", !n({ refundPolicy: "UNTIL", refundUntilDays: -1 }).ok && !n({ refundPolicy: "UNTIL", refundUntilDays: 999 }).ok && !n({ refundPolicy: "MAYBE" }).ok);
  check("a leftover date is dropped when the policy isn't “until”", (() => { const c = col({ refundPolicy: "NONE", refundUntilAt: iso, refundNote: " x " }); return !!c && c !== "bad" && c.refundUntilAt === null && c.refundNote === "x"; })());
  for (const f of ["app/api/events/route.ts", "app/api/events/[id]/route.ts"]) check(`one rule on save: ${f}`, /normalizeRefundPolicy\(/.test(code(f)) && /\.\.\.\(refund\.columns \?\? \{\}\)/.test(code(f)));
  const sql = readFileSync(join(ROOT, "prisma/migrations/20261125000000_event_refund_policy/migration.sql"), "utf8").replace(/--.*$/gm, "");
  check("the migration only adds nullable columns", (sql.match(/ADD COLUMN IF NOT EXISTS/g) ?? []).length === 4 && !/NOT NULL|DROP|UPDATE|DELETE|DEFAULT/i.test(sql.replace(/IF NOT EXISTS/g, "")));
  const ed = code("components/events/EventEditor.tsx");
  check("the editor offers “until the card is charged” only when cards are charged on a date", /k !== "UNTIL_CHARGED" \|\| chargesOnDate/.test(ed));
  check("the editor types the date on the club's clock", /wallClockUTCToInstant\(`\$\{refundUntil\}:00Z`, clubTz\)/.test(ed));
}

console.log("\n§7 everywhere families read it");
{
  const until = at(6, 17);
  const event = { id: "ev", name: "Duals", startsAt: at(20, 9), endsAt: at(20, 17), memberPrice: 60, nonMemberPrice: 60, refundPolicy: "UNTIL", refundUntilAt: until, refundNote: "Weigh-in fees are non-refundable <b>" };
  const ctx = (over: Record<string, unknown>, ev: Record<string, unknown> = {}) =>
    renderableRegistrationState({
      registration: { id: "r1", name: "A", status: "PAID", amountDue: 60, amountPaid: 62.11, paidAt: now, ...over } as never,
      event: { ...event, ...ev } as never,
      club: { name: "C", timezone: NY, passProcessingFees: true },
      activeCount: 1,
      baseUrl: "https://example.test",
      now,
    });
  const c = ctx({});
  const sentence = `Refundable until ${words(until, { weekday: true, zone: true })}. After that, no refunds.`;
  check("the registration page and My registrations get it", c.meta.refundPolicy[0] === sentence, c.meta.refundPolicy);
  const html = renderLifecycleEmailHtml(c, NY);
  const text = renderLifecycleEmailText(c, NY);
  check("the confirmation email says it, in both versions", html.includes(sentence) && text.includes(sentence));
  check("…with the note, escaped", html.includes("Weigh-in fees are non-refundable &lt;b&gt;"));
  check("no text under 12px in the email", (html.match(/font-size:(\d+)px/g) ?? []).every((x) => Number(x.match(/\d+/)![0]) >= 12));
  check("a canceled registration doesn't repeat it", ctx({ status: "CANCELED" }).meta.refundPolicy.length === 0);
  check("a free spot has nothing to say", ctx({ status: "REGISTERED", amountDue: null, amountPaid: null }, { memberPrice: null, nonMemberPrice: null, pricingModel: "FREE" }).meta.refundPolicy.length === 0);
  check("no policy, no words", ctx({}, { refundPolicy: null }).meta.refundPolicy.length === 0);
  const uses = (f: string, re: RegExp) => check(`${f}`, re.test(code(f)));
  uses("app/api/member/events/[id]/route.ts", /refundPolicy: pricing === "FREE"/);
  uses("app/member/events/[id]/page.tsx", /<RefundPolicyLines view=\{d\.refundPolicy\}/);
  uses("app/api/public/events/[slug]/route.ts", /refundPolicyView\(event, event\.club/);
  uses("app/e/[slug]/page.tsx", /<RefundPolicyLines view=\{event\.refundPolicy\}/);
  uses("components/member/events/registerFlow.tsx", /<RefundPolicyLines view=\{review\.refundPolicy\}[\s\S]*<RefundPolicyLines view=\{prompt\.refundPolicy\}/);
  uses("components/registration/RegistrationCard.tsx", /m\.refundPolicy\.length > 0/);
  uses("components/member/BookingsPanel.tsx", /refundLine\(b, clubTz\)/);
  uses("lib/email.ts", /refundPolicy\?\.length/);
  check("the paid confirmations that don't use the registration email carry it too", (code("app/api/member/events/[id]/register/route.ts").match(/refundPolicy: refundView\?\.lines,/g) ?? []).length === 2 && /refundPolicy: refundPolicyView\(event, contact/.test(code("app/api/stripe/webhook/route.ts")));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
