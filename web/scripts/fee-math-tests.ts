/**
 * Pricing overhaul (2026-10-18) — the gross-up and platform-fee math in
 * lib/fees.ts, plus the 1.4% platform-rate floor in lib/tier.ts. Pure, no DB.
 *
 * Asserts, for every tier × every toggle combination × a sweep of prices:
 *   - both passed       → the club nets EXACTLY `net`
 *   - processing passed → club nets ≥ net − platform(parent pays) (rounded)
 *   - platform passed   → club nets ≥ net − stripe(parent pays)
 *   - neither           → parent pays net
 *   - parent total is the smallest cent that covers the passed fees
 *   - discounts reduce net BEFORE the gross-up
 */
import {
  quoteCharge, feePolicyFor, stripeFeeCents, applicationFeePercent, recurringUnitWithFee,
  feeBreakdown, legacyRecurringUnitWithFee, processingFeeLineItem, type FeePolicy,
} from "../lib/fees";
import { assertPlatformRate, getPlatformRate, PLATFORM_RATE_FLOOR, normalizeTier, TIER_FEATURES, canUseFeature, upgradeRequired } from "../lib/tier";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}
function eq(name: string, a: unknown, b: unknown) { check(name, a === b, { got: a, want: b }); }

const pol = (tier: string, pp: boolean, pf: boolean): FeePolicy => feePolicyFor({ tier, passProcessingFees: pp, passPlatformFee: pf });

// ── The worked $100 example (Starter, 2% — percentage only, no fixed part) ──
// Platform fee has NO fixed component (2026-10-18 pm). Stripe keeps its $0.30.
const PF = 0;
{
  const n = quoteCharge(10000, pol("starter", false, false));
  eq("neither: parent pays $100.00", n.totalCents, 10000);
  eq("neither: stripe fee $3.20", n.stripeFeeCents, 320);
  eq("neither: platform fee $2.00", n.applicationFeeCents, 200);
  eq("neither: club nets $94.80", n.clubNetCents, 9480);

  const p = quoteCharge(10000, pol("starter", true, false));
  eq("processing: parent pays $103.30 (not $102.90)", p.totalCents, 10330);
  eq("processing: stripe fee $3.30", p.stripeFeeCents, 330);
  eq("processing: platform on parent-paid $2.07", p.applicationFeeCents, Math.round(10330 * 0.02) + PF);
  eq("processing: club nets $97.93", p.clubNetCents, 10000 - (Math.round(10330 * 0.02) + PF));

  const f = quoteCharge(10000, pol("starter", false, true));
  eq("platform: parent pays ceil(100.00/0.98)", f.totalCents, Math.ceil(10000 / 0.98));
  eq("platform: club nets net − stripe(parent)", f.clubNetCents, 10000 - stripeFeeCents(f.totalCents));

  const b = quoteCharge(10000, pol("starter", true, true));
  eq("both: parent pays ceil(100.30/0.951)", b.totalCents, Math.ceil(10030 / 0.951));
  eq("both: club nets exactly $100.00", b.clubNetCents, 10000);
}

// The Member payments preview at Enterprise (1.4%, no fixed part) — the exact four
// rows the settings screen shows.
{
  const row = (pp: boolean, pf: boolean) => { const q = quoteCharge(10000, pol("enterprise", pp, pf)); return [q.totalCents, q.clubNetCents]; };
  eq("enterprise neither", JSON.stringify(row(false, false)), JSON.stringify([10000, 9540]));
  eq("enterprise processing", JSON.stringify(row(true, false)), JSON.stringify([10330, 9855]));
  eq("enterprise platform", JSON.stringify(row(false, true)), JSON.stringify([10142, 9676]));
  eq("enterprise both", JSON.stringify(row(true, true)), JSON.stringify([10481, 10000]));
}

// The old bug, pinned: legacy formula said $102.90 and the club netted $99.62.
eq("legacy formula = $102.90", legacyRecurringUnitWithFee(10000), 10290);
eq("legacy: club actually netted $99.62", 10290 - stripeFeeCents(10290), 9962);
eq("fixed: club nets $100.00 on processing pass", recurringUnitWithFee(10000, true) - stripeFeeCents(recurringUnitWithFee(10000, true)), 10000);

// ── Sweep: every tier × combo × price ──────────────────────────────────────
const prices: number[] = [];
for (let c = 50; c <= 300000; c += c < 2000 ? 7 : c < 20000 ? 113 : 1777) prices.push(c);
prices.push(2500, 5000, 7500, 11000, 15000, 17500, 45000, 90000, 150000);
for (const tier of ["starter", "pro", "enterprise"]) {
  for (const pp of [false, true]) for (const pf of [false, true]) {
    const p = pol(tier, pp, pf);
    for (const net of prices) {
      const q = quoteCharge(net, p);
      const tag = `${tier} pp=${pp} pf=${pf} net=${net}`;
      check(`${tag} total ≥ net`, q.totalCents >= net, q);
      check(`${tag} app fee ≥ 0`, q.applicationFeeCents >= 0, q);
      check(`${tag} app fee < total`, q.applicationFeeCents < q.totalCents, q);
      check(`${tag} parts sum`, q.processingPartCents + q.platformPartCents === q.surchargeCents, q);
      if (pp && pf) {
        eq(`${tag} both: club nets exactly net`, q.clubNetCents, net);
        // App fee is at least the nominal platform fee on what was charged, less a cent of rounding.
        const nominal = Math.round(q.totalCents * p.platformRate) + PF;
        check(`${tag} both: platform not shortchanged`, q.applicationFeeCents >= nominal - 1, { q, nominal });
        const ceil = Math.ceil((net + 30 + PF) / (1 - 0.029 - p.platformRate) - 1e-7);
        check(`${tag} both: total = formula rounded UP (never down)`, q.totalCents >= ceil && q.totalCents <= ceil + 1, { q, ceil });
      } else if (pp) {
        check(`${tag} processing: club ≥ net − platform`, q.clubNetCents >= net - (Math.round(q.totalCents * p.platformRate) + PF), q);
        check(`${tag} processing: stripe covered`, q.totalCents - q.stripeFeeCents >= net, q);
        const ceil = Math.ceil((net + 30) / (1 - 0.029) - 1e-7);
        check(`${tag} processing: total = formula rounded UP (never down)`, q.totalCents >= ceil && q.totalCents <= ceil + 1, { q, ceil });
      } else if (pf) {
        eq(`${tag} platform: club = net − stripe(total)`, q.clubNetCents, net - q.stripeFeeCents);
        check(`${tag} platform: platform ≥ nominal`, q.applicationFeeCents >= Math.round(q.totalCents * p.platformRate) + PF, q);
        const ceil = Math.ceil((net + PF) / (1 - p.platformRate) - 1e-7);
        check(`${tag} platform: total = formula rounded UP (never down)`, q.totalCents >= ceil && q.totalCents <= ceil + 1, { q, ceil });
      } else {
        eq(`${tag} neither: total = net`, q.totalCents, net);
        if (net >= 200) eq(`${tag} neither: club = net − stripe − platform`, q.clubNetCents, net - stripeFeeCents(net) - (Math.round(net * p.platformRate) + PF));
      }
      // Subscription percent is floored: applied to the total it never exceeds the one-time app fee.
      const pct = applicationFeePercent(net, p);
      check(`${tag} sub percent ≤ app fee`, Math.round((q.totalCents * pct) / 100) <= q.applicationFeeCents + 0, { pct, q });
      check(`${tag} sub percent 2dp`, Math.abs(pct * 100 - Math.round(pct * 100)) < 1e-6, pct);
    }
  }
}

// ── Discounts reduce net BEFORE gross-up ───────────────────────────────────
{
  const p = pol("pro", true, true);
  const sticker = 17500, discount = 2500; // $25 sibling discount
  const after = quoteCharge(sticker - discount, p);
  eq("discount first: club nets the discounted price exactly", after.clubNetCents, 15000);
  check("discount first ≠ discounting the grossed-up total", after.totalCents !== quoteCharge(sticker, p).totalCents - discount, after);
}

// ── Zero / free ────────────────────────────────────────────────────────────
eq("$0 → $0", quoteCharge(0, pol("starter", true, true)).totalCents, 0);
eq("$0 → no app fee", quoteCharge(0, pol("starter", true, true)).applicationFeeCents, 0);
eq("$0 → no fee line", processingFeeLineItem(0, pol("starter", true, true)), null);
eq("boolean false → no fee line", processingFeeLineItem(10000, false), null);
eq("boolean true → $3.30 line", processingFeeLineItem(10000, true)?.price_data.unit_amount, 330);
eq("feeBreakdown(100, true).total", feeBreakdown(100, true).total, 103.3);
eq("tiny charge never makes club negative", quoteCharge(50, pol("starter", false, false)).clubNetCents >= 0, true);

// ── Platform rate floor ────────────────────────────────────────────────────
eq("floor is 1.4%", PLATFORM_RATE_FLOOR, 0.014);
let threw = false; try { assertPlatformRate(0.0139); } catch { threw = true; }
eq("1.39% rejected", threw, true);
threw = false; try { assertPlatformRate(0); } catch { threw = true; }
eq("0% rejected", threw, true);
threw = false; try { assertPlatformRate(NaN); } catch { threw = true; }
eq("NaN rejected", threw, true);
eq("1.4% accepted", assertPlatformRate(0.014), 0.014);
eq("starter 2%", getPlatformRate("starter"), 0.02);
eq("pro 1.5%", getPlatformRate("pro"), 0.015);
eq("no fixed platform part on any tier", Object.values(TIER_FEATURES).every((t) => t.platformFixedCents === 0), true);
eq("enterprise 1.4%", getPlatformRate("enterprise"), 0.014);
for (const t of Object.keys(TIER_FEATURES)) check(`${t} rate ≥ floor`, (TIER_FEATURES as any)[t].platformRate >= PLATFORM_RATE_FLOOR);

// ── Tier resolution ────────────────────────────────────────────────────────
eq("legacy 'growth' → starter", normalizeTier("growth"), "starter");
eq("unknown → starter", normalizeTier("bogus"), "starter");
eq("null → starter", normalizeTier(null), "starter");
eq("starter: no private messaging", canUseFeature("starter", "privateMessaging"), false);
eq("starter: email announcements", canUseFeature("starter", "emailSms"), true);
eq("pro: private messaging", canUseFeature("pro", "privateMessaging"), true);
eq("upgrade for branded app = pro", upgradeRequired("starter", "brandedApp"), "pro");
eq("upgrade for custom roles = enterprise", upgradeRequired("pro", "customRoles"), "enterprise");
eq("upgrade for 2nd entity on pro = enterprise", upgradeRequired("pro", "maxEntities"), "enterprise");
eq("upgrade for 2nd bank on starter = pro", upgradeRequired("starter", "maxBankAccounts"), "pro");
eq("upgrade for 26th seat on pro = enterprise", upgradeRequired("pro", "maxStaffSeats"), "enterprise");

console.log(`\nfee-math: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
