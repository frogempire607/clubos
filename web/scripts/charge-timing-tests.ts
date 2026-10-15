/**
 * Stripe stop dates + "pay today or after the free trial" (2026-10-15).
 *
 *   npx tsx scripts/charge-timing-tests.ts
 *
 * 1. Turning auto-renew back on failed for Weston: Stripe refuses an update
 *    naming both cancel_at and cancel_at_period_end. lib/stripeStop sends one.
 * 2. Families were charged a week late because a first purchase silently
 *    started a free trial (or stacked one on a running class trial).
 *    lib/freeTrial trialStartFor / trialCheckoutFields decide what each
 *    choice means.
 */
import * as fs from "fs";
import * as path from "path";
import { makeFakeDb, installFakePrisma } from "./fake-prisma";

installFakePrisma(makeFakeDb({ relations: {}, uniques: {} }));

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy";

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

async function main() {
  const { stopSteps, setStripeStop } = await import("../lib/stripeStop");
  const { trialStartFor, trialCheckoutFields, CHECKOUT_TRIAL_MIN_MS } = await import("../lib/freeTrial");
  const { stripe } = await import("../lib/stripe");

  const both = (p: Record<string, unknown>) => "cancel_at" in p && "cancel_at_period_end" in p;

  console.log("\nstopSteps (pure):");
  {
    const s1 = stopSteps({ cancel_at: 1794700800, cancel_at_period_end: false }, null);
    check("Weston: a date stop is cleared with cancel_at only", s1.length === 1 && s1[0].cancel_at === "" && !("cancel_at_period_end" in s1[0]), s1);
    const s2 = stopSteps({ cancel_at: 1794700800, cancel_at_period_end: true }, null);
    check("period-end stop is cleared with cancel_at_period_end only", s2.length === 1 && s2[0].cancel_at_period_end === false && !("cancel_at" in s2[0]), s2);
    check("nothing scheduled → nothing sent", stopSteps({ cancel_at: null, cancel_at_period_end: false }, null).length === 0);
    const s3 = stopSteps({ cancel_at_period_end: true }, 1800000000);
    check("new date over a period-end stop = two single-parameter updates", s3.length === 2 && s3.every((p) => !both(p as Record<string, unknown>)) && s3[1].cancel_at === 1800000000, s3);
    const s4 = stopSteps({ cancel_at: null }, 1800000000, { proration_behavior: "none" });
    check("extras ride on the last step", s4.length === 1 && s4[0].proration_behavior === "none" && s4[0].cancel_at === 1800000000, s4);
    const s5 = stopSteps({ cancel_at: null, cancel_at_period_end: false }, null, { metadata: { a: "1" } });
    check("extras alone when the stop needn't change", s5.length === 1 && !!s5[0].metadata && !("cancel_at" in s5[0]), s5);
    let none = true;
    for (const live of [{}, { cancel_at: 5 }, { cancel_at_period_end: true }, { cancel_at: 5, cancel_at_period_end: true }]) {
      for (const at of [null, 99]) for (const p of stopSteps(live, at, { proration_behavior: "none" })) if (both(p as Record<string, unknown>)) none = false;
    }
    check("no combination ever names both parameters", none);
  }

  console.log("\nsetStripeStop against a Stripe that refuses both:");
  {
    const calls: Record<string, unknown>[] = [];
    let live: Record<string, unknown> = { id: "sub_w", cancel_at: 1794700800, cancel_at_period_end: false, status: "active" };
    const subs = stripe.subscriptions as unknown as Record<string, unknown>;
    subs.retrieve = async () => live;
    subs.update = async (_id: string, p: Record<string, unknown>) => {
      if (both(p)) throw new Error("Received both cancel_at_period_end and cancel_at parameters. Please pass in only one.");
      calls.push(p);
      if (p.cancel_at === "") live = { ...live, cancel_at: null };
      if (p.cancel_at_period_end === false) live = { ...live, cancel_at_period_end: false, cancel_at: null };
      if (typeof p.cancel_at === "number") live = { ...live, cancel_at: p.cancel_at };
      return live;
    };
    const out = await setStripeStop({ subscriptionId: "sub_w", stripeAccount: "acct_x", stopAt: null });
    check("auto-renew back on: accepted, stop removed", (out as unknown as { cancel_at: unknown }).cancel_at == null && calls.length === 1, calls);
    calls.length = 0;
    live = { id: "sub_w", cancel_at: 1794700800, cancel_at_period_end: true };
    await setStripeStop({ subscriptionId: "sub_w", stripeAccount: "acct_x", stopAt: new Date("2027-01-01T00:00:00Z"), idempotencyKey: "k" });
    check("moving a period-end stop to a date: accepted", calls.length === 2 && (live as { cancel_at: number }).cancel_at === Math.floor(Date.parse("2027-01-01T00:00:00Z") / 1000), calls);
  }

  console.log("\nno route still sends both in one update (source scan):");
  {
    const root = path.resolve(__dirname, "..");
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        if (fs.statSync(p).isDirectory()) { if (f !== "node_modules" && f !== ".next") walk(p); continue; }
        if (!/\.(ts|tsx)$/.test(f)) continue;
        const src = fs.readFileSync(p, "utf8");
        for (const line of src.split("\n")) if (/cancel_at\s*:/.test(line) && /cancel_at_period_end\s*:/.test(line)) offenders.push(`${path.relative(root, p)}: ${line.trim().slice(0, 90)}`);
      }
    };
    walk(path.join(root, "app")); walk(path.join(root, "lib"));
    check("none in app/ or lib/", offenders.length === 0, offenders);
  }

  console.log("\ntrialStartFor / trialCheckoutFields:");
  {
    const now = new Date("2026-10-15T15:00:00Z");
    const t1 = trialStartFor(7, null, now);
    check("first purchase, trial plan → 7 days, first charge Oct 22", t1?.kind === "DAYS" && t1.days === 7 && t1.firstChargeAt.toISOString() === "2026-10-22T15:00:00.000Z", t1);
    check("…pay today → no trial fields", JSON.stringify(trialCheckoutFields(t1, "TODAY")) === "{}");
    check("…after trial → trial_period_days 7", trialCheckoutFields(t1, "AFTER_TRIAL").trial_period_days === 7);
    const win = new Date("2026-10-19T15:00:00Z");
    const t2 = trialStartFor(7, win, now);
    check("already in a class trial → it ends the trial (no second 7 days)", t2?.kind === "WINDOW" && t2.firstChargeAt.getTime() === win.getTime(), t2);
    check("…after trial → trial_end = window end", trialCheckoutFields(t2, "AFTER_TRIAL").trial_end === Math.floor(win.getTime() / 1000));
    check("…window counts even when the plan trial was used before", trialStartFor(null, win, now)?.kind === "WINDOW");
    const soon = new Date(now.getTime() + CHECKOUT_TRIAL_MIN_MS - 60_000);
    check("window ending in under 48h → pay today only (Stripe minimum)", trialStartFor(7, soon, now) === null);
    check("expired window → back to the plan's trial", trialStartFor(7, new Date("2026-10-01T00:00:00Z"), now)?.kind === "DAYS");
    check("no trial applies → nothing to choose", trialStartFor(null, null, now) === null && JSON.stringify(trialCheckoutFields(null, "AFTER_TRIAL")) === "{}");
  }

  console.log(`\n${failed ? "✗" : "✓"} ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
