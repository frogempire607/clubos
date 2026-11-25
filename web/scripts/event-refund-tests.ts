/**
 * Event refunds (2026-11-25).
 *
 *   npx tsx scripts/event-refund-tests.ts
 *
 * No database, no Stripe. The REAL engine (lib/eventRefundServer) runs against
 * a small stand-in for Stripe that keeps Stripe's own rules: one result per
 * idempotency key, a stored refusal replayed for the same key, a different
 * body under a used key refused, and never more than the charge.
 *
 * The worked example is the real one: Michael Riservato, Parabellum Duals,
 * $60.00 price, $62.11 paid, removed, refund refused for low balance.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LOW_BALANCE_TEXT,
  REFUNDED_ACTION,
  REFUND_FAILED_ACTION,
  cardText,
  describeRefundError,
  parseDollars,
  paidLabel,
  refundFacts,
  refundFee,
  refundIdempotencyKey,
  refundIsStale,
  refundLeft,
  refundOptions,
  removedRefundLabel,
  resolveRefund,
} from "../lib/eventRefunds";
import { failedRefundIds, matchTransaction, refundEventRegistration, refundSheetData, txRefunded, type RefundDeps, type RefundInput, type RefundTarget } from "../lib/eventRefundServer";
import { refundReceiptSubject, renderRefundReceiptHtml, renderRefundReceiptText } from "../lib/eventRefundEmail";
import { buildAttendeeLedger, summarizeLedger, type LedgerEvent, type LedgerRegistration } from "../lib/eventAttendees";
import { attendeeTiles, canRefund, removePlan } from "../lib/eventAttendeeActions";

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

const now = new Date();
const daysAhead = (n: number) => new Date(now.getTime() + n * 86_400_000);

// ── A stand-in for Stripe ───────────────────────────────────────────────────
class StripeLike extends Error {
  constructor(public type: string, public code: string, message: string, public statusCode: number) { super(message); }
}
const lowBalance = () => new StripeLike("StripeInvalidRequestError", "balance_insufficient", "Insufficient funds in your Stripe balance to refund this amount.", 400);

function world(over: Partial<RefundTarget["reg"]> = {}, txOver: Partial<NonNullable<RefundTarget["tx"]>> = {}) {
  const reg: RefundTarget["reg"] = {
    id: "reg1", eventId: "ev1", clubId: "club1", memberId: null, name: "Michael Riservato ", email: "family@example.test",
    status: "PAID", amountDue: "60.00", amountPaid: "62.11", paidVia: "STRIPE", transactionId: "tx1", stripePaymentIntentId: "pi_1",
    event: { id: "ev1", name: "Parabellum Duals", startsAt: daysAhead(2), autoChargeDate: null },
    club: { id: "club1", name: "Test Club", timezone: "America/New_York", stripeAccountId: "acct_1", contactEmail: "club@example.test", contactPhone: null },
    ...over,
  };
  const tx = {
    id: "tx1", amount: "62.11", status: "SUCCEEDED", refundedAmount: null as unknown, notes: null as string | null, paymentMethod: "STRIPE",
    paymentSource: "STRIPE", reconciliationStatus: "VERIFIED", stripePaymentIntentId: "pi_1" as string | null, stripeChargeId: "ch_1" as string | null,
    ...txOver,
  };
  const w = {
    reg, tx,
    stripe: { charge: 6211, refunded: 0, balance: 1_000_000, keys: new Map<string, { body: string; result?: { id: string; status: string | null; amountCents: number; chargeRefundedCents: number | null }; error?: unknown }>(), refunds: [] as number[], down: false, loseAnswer: false },
    audits: [] as { action: string; before: Record<string, unknown>; after: Record<string, unknown>; note: string }[],
    receipts: [] as { receipt: { amount: number; refundedTotal: number; removed: boolean; card: string | null } }[],
    removed: [] as string[],
    removeFails: false,
  };
  const deps: RefundDeps = {
    load: async (clubId, _e, id) => (clubId === reg.clubId && id === reg.id ? { reg: { ...w.reg }, tx: { ...w.tx } } : null),
    live: async () => { if (w.stripe.down) throw new StripeLike("StripeConnectionError", "", "socket hang up", 0); return { refundedCents: w.stripe.refunded, card: { brand: "visa", last4: "4242" } }; },
    refusals: async (clubId, id) => w.audits.filter((a) => clubId === "club1" && a.action === REFUND_FAILED_ACTION && a.after.registrationId === id && a.after.definite === true).length,
    createRefund: async (params, opts) => {
      const body = JSON.stringify(params);
      const seen = w.stripe.keys.get(opts.idempotencyKey);
      if (seen) {
        if (seen.body !== body) throw new StripeLike("StripeIdempotencyError", "", "Keys for idempotent requests can only be used with the same parameters.", 400);
        if (seen.error) throw seen.error;
        return seen.result!;
      }
      const amount = params.amount as number;
      const refuse = (e: unknown) => { w.stripe.keys.set(opts.idempotencyKey, { body, error: e }); throw e; };
      if (amount > w.stripe.balance) refuse(lowBalance());
      if (w.stripe.refunded + amount > w.stripe.charge) refuse(new StripeLike("StripeInvalidRequestError", "charge_already_refunded", "Charge has already been refunded.", 400));
      w.stripe.refunded += amount;
      w.stripe.refunds.push(amount);
      const result = { id: `re_${w.stripe.refunds.length}`, status: "succeeded", amountCents: amount, chargeRefundedCents: w.stripe.refunded };
      w.stripe.keys.set(opts.idempotencyKey, { body, result });
      if (w.stripe.loseAnswer) { w.stripe.loseAnswer = false; throw new StripeLike("StripeConnectionError", "", "socket hang up", 0); }
      return result;
    },
    recordRefund: async (x) => {
      const cur = w.tx.refundedAmount == null ? null : Number(w.tx.refundedAmount);
      if (cur !== (x.fromRefunded == null ? null : Number(x.fromRefunded))) return false;
      w.tx.refundedAmount = x.refundedTotal;
      if (x.full) w.tx.status = "REFUNDED";
      w.tx.notes = x.note;
      return true;
    },
    auditOnce: async (id, e) => {
      if (w.audits.some((a) => a.action === REFUNDED_ACTION && a.after.refundId === id)) return false;
      w.audits.push(e as never);
      return true;
    },
    audit: (async (e: never) => { w.audits.push(e); }) as never,
    remove: async () => { if (w.removeFails) throw new Error("db"); w.reg.status = "CANCELED"; w.removed.push(reg.id); },
    receipt: (async (e: never) => { w.receipts.push(e); return { sent: 1 }; }) as never,
    now: () => now,
  };
  const refund = (over2: Partial<RefundInput> = {}) =>
    refundEventRegistration({ clubId: "club1", eventId: "ev1", registrationId: "reg1", mode: "price", expectedRefundedCents: 0, actorUserId: "u1", reason: "Test", ...over2 }, deps);
  return { w, deps, refund };
}

async function main() {
  console.log("\n§1 how much");
  {
    const f = refundFacts({ amountPaid: "62.11", amountDue: "60.00", txAmount: "62.11", refundedCents: 0 });
    const o = refundOptions(f);
    check("event price only is first, so it is the default", o[0].mode === "price" && o[0].cents === 6000, o);
    check("it keeps the $2.11 card fee and says so", refundFee(f) === 211 && /Keeps the \$2\.11 card processing fee/.test(o[0].note), o[0].note);
    check("everything paid is $62.11 and says it includes the fee", o[1].mode === "all" && o[1].label === "Everything paid" && o[1].cents === 6211 && /Includes the \$2\.11/.test(o[1].note));
    check("custom goes up to what's left", o[2].mode === "custom" && /up to \$62\.11/.test(o[2].note));
    check("custom above what's left is refused, in words", (() => { const r = resolveRefund("custom", 6212, f); return !r.ok && r.error === "The most you can refund is $62.11."; })());
    check("custom of nothing, or not a whole cent, is refused", !resolveRefund("custom", 0, f).ok && !resolveRefund("custom", null, f).ok && !resolveRefund("custom", 10.5, f).ok);
    const part = refundFacts({ amountPaid: "62.11", amountDue: "60.00", txAmount: "62.11", refundedCents: 2000 });
    check("after $20, the price option offers the $40 still in the price", refundOptions(part)[0].cents === 4000 && refundLeft(part) === 4211);
    check("…and the other reads “Everything left”", refundOptions(part)[1].label === "Everything left" && refundOptions(part)[1].cents === 4211);
    const priceGone = refundFacts({ amountPaid: "62.11", amountDue: "60.00", txAmount: "62.11", refundedCents: 6000 });
    check("once the price is back, only the $2.11 fee is left", refundOptions(priceGone)[0].mode === "all" && refundOptions(priceGone)[0].cents === 211);
    const none = refundFacts({ amountPaid: "62.11", amountDue: "60.00", txAmount: "62.11", refundedCents: 6211 });
    check("nothing left: no options, and asking is refused", refundOptions(none).length === 0 && !resolveRefund("all", null, none).ok);
    const cash = refundFacts({ amountPaid: "60", amountDue: "60", txAmount: "60", refundedCents: 0 });
    check("no fee on the payment: price and everything are one choice", refundOptions(cash).map((x) => x.mode).join() === "price,custom" && resolveRefund("all", null, cash).ok);
    const noPrice = refundFacts({ amountPaid: "62.11", amountDue: null, txAmount: "62.11", refundedCents: 0 });
    check("price not recorded: it isn't offered, and asking for it is refused", refundOptions(noPrice)[0].mode === "all" && !resolveRefund("price", null, noPrice).ok);
    check("a price above what was paid can't raise the refund", refundOptions(refundFacts({ amountPaid: "50", amountDue: "60", txAmount: "50", refundedCents: 0 }))[0].cents === 5000);
    check("a registration can't claim more than its payment row", refundLeft(refundFacts({ amountPaid: "100", amountDue: "60", txAmount: "62.11", refundedCents: 0 })) === 6211);
    check("typed amounts: 25, 25.5, $1,025.50 — not 25.555, -5, abc", parseDollars("25") === 2500 && parseDollars("25.5") === 2550 && parseDollars("$1,025.50") === 102550 && parseDollars("25.555") === null && parseDollars("-5") === null && parseDollars("abc") === null);
    check("the card in words", cardText({ brand: "visa", last4: "4242" }) === "Visa ending in 4242" && cardText({ brand: "amex", last4: "0005" }) === "American Express ending in 0005" && cardText(null) === null);
  }

  console.log("\n§2 a refund that goes through");
  {
    const { w, refund, deps } = world({ status: "CANCELED" });
    const sheet = await refundSheetData("club1", "ev1", "reg1", deps);
    check("the sheet shows paid, refunded, left and the card, for someone already removed", !!sheet && sheet.blocked === null && sheet.removed && sheet.facts.paidCents === 6211 && sheet.leftCents === 6211 && sheet.card === "Visa ending in 4242", sheet);
    const r = await refund();
    check("price only sends $60.00 to Stripe, once", r.ok && r.cents === 6000 && w.stripe.refunds.join() === "6000", r);
    check("the payment row carries it and stays SUCCEEDED (a part refund)", Number(w.tx.refundedAmount) === 60 && w.tx.status === "SUCCEEDED");
    check("audited with who, how much and what's refunded in all", w.audits.length === 1 && w.audits[0].action === REFUNDED_ACTION && w.audits[0].after.amount === 60 && w.audits[0].after.refunded === 60);
    check("the family gets a receipt for $60.00 to their card", w.receipts.length === 1 && w.receipts[0].receipt.amount === 60 && w.receipts[0].receipt.card === "Visa ending in 4242");
    check("the message says which card", r.ok && /\$60\.00 refunded to Visa ending in 4242/.test(r.message));
    const again = await refund({ mode: "all", expectedRefundedCents: 6000 });
    check("a second, deliberate refund sends the $2.11 that's left", again.ok && again.cents === 211 && w.stripe.refunded === 6211);
    check("now the payment is REFUNDED in full", w.tx.status === "REFUNDED" && Number(w.tx.refundedAmount) === 62.11);
    const third = await refund({ mode: "all", expectedRefundedCents: 6211 });
    check("a third is refused: never more than was paid", !third.ok && third.code === "AMOUNT" && /already been refunded in full/.test(third.error) && w.stripe.refunded === 6211, third);
    check("two receipts, one per refund", w.receipts.length === 2 && w.receipts[1].receipt.refundedTotal === 62.11);
  }
  {
    const { w, refund } = world();
    for (const c of [1000, 2000, 3211]) {
      const before = w.stripe.refunded;
      const r = await refund({ mode: "custom", customCents: c, expectedRefundedCents: before });
      check(`custom $${c / 100} on top of $${before / 100}`, r.ok && w.stripe.refunded === before + c, r);
    }
    check("three parts make exactly the whole", w.stripe.refunded === 6211 && w.tx.status === "REFUNDED");
    check("someone still registered stays registered", w.reg.status === "PAID" && w.removed.length === 0);
  }

  console.log("\n§3 twice is impossible");
  {
    const { w, refund } = world();
    const [a, b] = await Promise.all([refund(), refund()]);
    check("two taps at the same moment: one refund at Stripe", w.stripe.refunds.length === 1 && a.ok && b.ok, [a, b]);
    check("…one audit row and one receipt", w.audits.filter((x) => x.action === REFUNDED_ACTION).length === 1 && w.receipts.length === 1, w.audits.length);
    const late = await refund();
    check("a tap that arrives after the first finished is refused as out of date", !late.ok && late.code === "CHANGED" && w.stripe.refunds.length === 1, late);
    check("…in plain words", !late.ok && /\$60\.00 has already been refunded/.test(late.error));
  }
  {
    const { w, refund } = world();
    const [a, b] = await Promise.all([refund({ mode: "custom", customCents: 1000 }), refund({ mode: "custom", customCents: 2000 })]);
    const oks = [a, b].filter((x) => x.ok).length;
    check("two staff, two amounts, same moment: one goes through, the other is told", oks === 1 && w.stripe.refunds.length === 1 && [a, b].some((x) => !x.ok && x.code === "BUSY"), [a, b]);
    check("that clash is not counted as Stripe refusing the payment", w.audits.every((x) => x.action !== REFUND_FAILED_ACTION || x.after.definite === false));
  }
  {
    const { w, refund } = world();
    w.stripe.loseAnswer = true;
    const r = await refund();
    check("Stripe did it but the answer was lost: we say we can't tell, not that it failed", !r.ok && r.code === "UNKNOWN" && /can't tell/.test(r.error), r);
    const r2 = await refund();
    check("trying again finds it already refunded and sends nothing", !r2.ok && r2.code === "CHANGED" && w.stripe.refunds.length === 1, r2);
  }
  {
    check("the key names the payment's state, not the amount", refundIdempotencyKey("r", 0, 0) !== refundIdempotencyKey("r", 6000, 0) && refundIdempotencyKey("r", 0, 0) !== refundIdempotencyKey("r", 0, 1) && refundIdempotencyKey("r", 0, 0) === refundIdempotencyKey("r", 0, 0));
    check("stale: nothing to say when the numbers agree", refundIsStale(0, { paidCents: 10, priceCents: 10, refundedCents: 0 }) === null);
  }

  console.log("\n§4 Stripe says no — nothing changes");
  {
    const { w, refund } = world({ status: "CANCELED" });
    w.stripe.balance = 0;
    const before = JSON.stringify([w.reg, w.tx]);
    const r = await refund();
    check("low balance reads exactly as asked", !r.ok && r.error === "The club's Stripe balance is too low right now. Try again after new payments come in." && LOW_BALANCE_TEXT === r.error, r);
    check("registration and payment are exactly as they were", JSON.stringify([w.reg, w.tx]) === before);
    check("no receipt", w.receipts.length === 0);
    check("the attempt is in the audit log with the amount and the reason", w.audits.length === 1 && w.audits[0].action === REFUND_FAILED_ACTION && w.audits[0].after.attempted === 60 && w.audits[0].after.kind === "LOW_BALANCE" && /too low/.test(w.audits[0].note));
    // The important one: Stripe replays a stored refusal under the same key.
    w.stripe.balance = 100_000;
    const r2 = await refund();
    check("once the balance recovers, trying again works (a new key, not the stored refusal)", r2.ok && w.stripe.refunds.join() === "6000", r2);
  }
  {
    const { w, refund } = world();
    w.stripe.down = true;
    const r = await refund();
    check("Stripe unreachable before anything: nothing sent, nothing written", !r.ok && r.status === 502 && w.stripe.refunds.length === 0 && w.audits.length === 0 && /couldn't reach Stripe/.test(r.error), r);
  }
  {
    const texts = [
      new StripeLike("StripeInvalidRequestError", "charge_disputed", "Charge ch_123 has been charged back; cannot issue a refund.", 400),
      new StripeLike("StripeInvalidRequestError", "charge_already_refunded", "Charge ch_123 has already been refunded.", 400),
      new StripeLike("StripeInvalidRequestError", "resource_missing", "No such payment_intent: 'pi_123'", 404),
      new StripeLike("StripeAPIError", "", "An error occurred", 500),
      new StripeLike("StripeRateLimitError", "rate_limit", "Too many requests", 429),
      lowBalance(),
      new Error("boom"),
      null,
    ].map((e) => describeRefundError(e));
    check("no raw codes, ids or Stripe messages ever reach the screen", texts.every((t) => !/ch_|pi_|_[a-z]+_|StripeE|boom|null|undefined|\d{3}/.test(t.text) && /\.$/.test(t.text)), texts.map((t) => t.text));
    check("a 5xx or rate limit is never treated as a definite no", !texts[3].definite && !texts[4].definite && texts[2].definite);
    check("“Insufficient funds” is recognised from the message alone", describeRefundError({ message: "Insufficient funds in your Stripe balance to refund this amount.", type: "StripeInvalidRequestError" }).kind === "LOW_BALANCE");
  }

  console.log("\n§5 Remove and refund");
  {
    const { w, refund } = world();
    w.stripe.balance = 0;
    const r = await refund({ remove: true });
    check("the refund fails → they are NOT removed", !r.ok && w.reg.status === "PAID" && w.removed.length === 0, r);
    check("…and the audit row says they are still registered", /still registered/.test(w.audits[0].note));
    w.stripe.balance = 1_000_000;
    const ok = await refund({ remove: true });
    check("the refund works → refunded, then removed", ok.ok && ok.removed && w.reg.status === "CANCELED" && w.stripe.refunds.join() === "6000");
    check("the receipt says they are off the event", w.receipts[0].receipt.removed === true);
    const twice = await refund({ remove: true });
    check("a second tap refunds nothing more", !twice.ok && w.stripe.refunds.length === 1);
  }
  {
    const { w, refund } = world();
    w.removeFails = true;
    const r = await refund({ remove: true });
    check("refunded but the removal hiccuped: it says so, and it's audited as still registered", r.ok && !r.removed && /couldn't be taken off/.test(r.message) && w.audits[0].after.status === "PAID", r);
  }
  {
    const route = code("app/api/events/[id]/registrations/[regId]/route.ts");
    check("the route only reports a removal the engine confirmed", /status: r\.removed \? "CANCELED" : reg\.status/.test(route));
    const approval = code("lib/eventApproval.ts");
    check("a coach's decline and a family's decline use the same engine", (approval.match(/await refundEventRegistration\(/g) ?? []).length === 2 && !/stripe\.refunds/.test(approval));
    const all = ["lib/eventApproval.ts", "app/api/events/[id]/registrations/[regId]/route.ts", "app/api/events/[id]/registrations/[regId]/refund/route.ts", "app/api/member/bookings/cancel/route.ts"].map(code).join("\n");
    check("no other event code calls Stripe refunds directly", !/refunds\.create/.test(all));
  }

  console.log("\n§6 cash and check");
  {
    const { w, refund, deps } = world({ stripePaymentIntentId: null, paidVia: "CASH", amountPaid: "60" }, { amount: "60", paymentMethod: "CASH", paymentSource: "CASH", reconciliationStatus: "OFFLINE", stripePaymentIntentId: null, stripeChargeId: null });
    const [a, b] = await Promise.all([refund(), refund()]);
    check("recorded without Stripe, once, however many taps", w.stripe.refunds.length === 0 && [a, b].filter((x) => x.ok).length === 1 && Number(w.tx.refundedAmount) === 60, [a, b]);
    check("the message says to hand it back", [a, b].some((x) => x.ok && /Hand it back in cash/.test(x.message)));
    const s = await refundSheetData("club1", "ev1", "reg1", deps);
    check("the sheet then says it has all been refunded", s?.blocked === "The whole $60.00 has already been refunded.", s?.blocked ?? "");
  }
  {
    const s = await refundSheetData("club1", "ev1", "reg1", world({ amountPaid: null }).deps);
    check("never paid: nothing to refund", !!s?.blocked && s.leftCents >= 0, s?.blocked ?? "");
    const bad = await world({}, { reconciliationStatus: "VOID" }).refund();
    check("a voided payment can't be refunded", !bad.ok && /voided/.test(bad.error));
    const other = await refundEventRegistration({ clubId: "club2", eventId: "ev1", registrationId: "reg1", mode: "price", expectedRefundedCents: 0, actorUserId: "u", reason: "x" }, world().deps);
    check("another club's registration is not found", !other.ok && other.status === 404);
  }

  console.log("\n§7 what the Attendees screen shows");
  {
    const EV: LedgerEvent = { capacity: null, coveredOrFree: false, sessionCount: 1 };
    const R = (o: Partial<LedgerRegistration>): LedgerRegistration => ({ id: "x", memberId: null, name: "N", email: null, phone: null, status: "PAID", amountDue: 60, amountPaid: 62.11, paidByCard: true, ...o });
    const l = buildAttendeeLedger(EV, [
      R({ id: "michael", name: "Michael Riservato", status: "CANCELED", approvalStatus: "APPROVED", refundFailed: true }),
      R({ id: "partlive", refundedAmount: 60 }),
      R({ id: "live" }),
      R({ id: "gone", status: "CANCELED", refundedAmount: 62.11, refundFailed: true }),
    ], []);
    const row = (id: string) => l.rows.find((x) => x.registrationId === id)!;
    const owner = { canDecideMoney: true };
    check("Michael reads “Paid $62.11, refund failed, not refunded”", row("michael").label === "Paid $62.11, refund failed, not refunded" && row("michael").removed, row("michael").label);
    check("…and has a working Refund button", canRefund(row("michael"), owner));
    check("staff without billing permission never see it", !canRefund(row("michael"), { canDecideMoney: false }) && !canRefund(row("michael"), null));
    check("still registered with $60 back reads “Paid $62.11, $60.00 refunded”", row("partlive").label === "Paid $62.11, $60.00 refunded", row("partlive").label);
    check("fully refunded: no button, and an old failure no longer shows", !canRefund(row("gone"), owner) && row("gone").label === "Removed, refunded $62.11", row("gone").label);
    check("Collected is what the club still holds: 62.11 + 2.11 + 62.11 + 0", l.tiles.collected === 126.33, l.tiles.collected);
    check("the events list gets the same number", summarizeLedger(l).collected === 126.33);
    check("the tile names the money kept from removed people", /\$62\.11 from removed/.test(attendeeTiles(l)[0].sub), attendeeTiles(l)[0].sub);
    const p = removePlan(row("partlive"), null, owner);
    check("removing a part-refunded person knows $2.11 is still held", p.kind === "paid" && p.held === 2.11 && p.refundUnavailable === null);
    check("labels", removedRefundLabel(60, 20, true) === "Removed, paid $60.00, $20.00 refunded, last refund failed" && paidLabel(60, 60, false) === "Paid $60.00, refunded in full" && paidLabel(60, 0, true) === "Paid $60.00, refund failed");
    const ago = (m: number) => new Date(now.getTime() - m * 60_000);
    const f = failedRefundIds([
      { action: REFUND_FAILED_ACTION, before: { registrationId: "a" }, after: { registrationId: "a", error: "x" }, createdAt: ago(10) },
      { action: REFUND_FAILED_ACTION, before: { registrationId: "b" }, after: { registrationId: "b" }, createdAt: ago(10) },
      { action: REFUNDED_ACTION, before: { registrationId: "b" }, after: { registrationId: "b" }, createdAt: ago(5) },
      { action: REFUNDED_ACTION, before: { registrationId: "c" }, after: {}, createdAt: ago(9) },
      { action: REFUND_FAILED_ACTION, before: { registrationId: "c" }, after: null, createdAt: ago(2) },
    ]);
    check("“refund failed” = the latest try failed (rows written before today count too)", f.has("a") && !f.has("b") && f.has("c"));
    check("the payment is matched by card payment first, then by link", matchTransaction({ transactionId: "t1", stripePaymentIntentId: "pi" }, [{ id: "t1", stripePaymentIntentId: null }, { id: "t2", stripePaymentIntentId: "pi" }])?.id === "t2");
    check("a REFUNDED payment counts as all of it even with no figure", txRefunded({ amount: "62.11", refundedAmount: null, status: "REFUNDED" }) === 62.11);
    const server = code("lib/eventAttendeesServer.ts");
    check("both the Attendees screen and the events list subtract refunds", (server.match(/loadRegistrationRefunds\(clubId, regs/g) ?? []).length === 2);
  }

  console.log("\n§8 the receipt");
  {
    const r = { clubName: "Test <Club>", clubContact: "c@example.test", eventName: "Parabellum Duals", athleteName: "Michael Riservato", amount: 60, paid: 62.11, refundedTotal: 60, via: "CARD" as const, card: "Visa ending in 4242", when: now, timeZone: "America/New_York", removed: true };
    const t = renderRefundReceiptText(r);
    check("subject and body name the amount, the event and the card", refundReceiptSubject(r) === "Refund receipt: $60.00 for Parabellum Duals" && /Visa ending in 4242/.test(t) && /Refunded now: \$60\.00/.test(t));
    check("it says what wasn't refunded, and that they're off the event", /Not refunded: \$2\.11/.test(t) && /no longer registered/.test(t));
    const h = renderRefundReceiptHtml(r);
    check("names are escaped", /Test &lt;Club&gt;/.test(h) && !/<Club>/.test(h));
    check("nothing under 12px", (h.match(/font-size:(\d+)px/g) ?? []).every((x) => Number(x.match(/\d+/)![0]) >= 12));
    check("cash says cash", /returned in cash/.test(renderRefundReceiptText({ ...r, via: "CASH", card: null })));
    check("per refund and per address, so a second guardian isn't dropped", /dedupeKey: `event-refund:\$\{args\.reg\.id\}:\$\{args\.refundKey\}:\$\{to\.email\}`/.test(code("lib/eventRefundEmail.ts")));
  }

  console.log("\n§9 who, and the rest of the wiring");
  {
    const route = code("app/api/events/[id]/registrations/[regId]/refund/route.ts");
    check("reading and refunding both need billing:full, checked live", (route.match(/requirePermissionLive\(session, "billing", "full"\)/g) ?? []).length === 2);
    check("a refund must say what it saw", /expectedRefundedCents: z\.number\(\)\.int\(\)\.min\(0\),/.test(route));
    const hook = code("app/api/stripe/webhook/route.ts");
    const part = hook.slice(hook.indexOf('case "charge.refunded"'), hook.indexOf('case "charge.dispute.created"'));
    check("a late webhook never lowers a refund already recorded", /Math\.max\(\(charge\.amount_refunded \|\| 0\) \/ 100, Number\(tx\.refundedAmount \?\? 0\)\)/.test(part));
    const sheet = readFileSync(join(ROOT, "components/events/attendees/RefundSheet.tsx"), "utf8");
    check("the button runs one at a time and can't be dismissed mid-refund", /flight\.run\("refund"/.test(sheet) && /dismissable=\{!busy\}/.test(sheet));
    check("no text under 12px and no browser dialogs", !/text-\[(?:[0-9]|1[01])(?:\.\d+)?px\]|text-xs/.test(sheet) && !/\b(alert|confirm|prompt)\(/.test(sheet));
    const modal = code("components/events/AttendeesModal.tsx");
    check("Refund is on the registrant sheet and in the Removed section", /onRefund=\{canRefund\(openRow/.test(modal) && /canRefund\(r, \{ canDecideMoney \}\)/.test(modal));
    for (const f of ["lib/eventLifecycleEmails.ts", "lib/registrationPage.ts", "app/api/member/registrations/route.ts"]) {
      check(`families see the refund: ${f}`, /amountRefunded: refunds?(\.get\(reg\.id\))?\?\.refunded \?\? null/.test(code(f)));
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
