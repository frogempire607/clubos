/**
 * Pricing overhaul (2026-10-18) — put the AthletixOS platform fee on a club's
 * EXISTING Stripe subscriptions.
 *
 * WHY THIS EXISTS: a Stripe subscription stores its own application_fee_percent
 * from the day it was created. Every subscription created before 2026-10-18
 * stores 0%. The new code (and the Member payments toggles) only decide the fee
 * on NEW charges and NEW subscriptions — they cannot reach into a subscription
 * Stripe already holds. This script does that, one subscription at a time.
 *
 * WHAT IT CHANGES: only `application_fee_percent`. The amount the family pays
 * is NOT changed — the club absorbs the platform fee on these subscriptions
 * (tier rate + $0.30, folded into one percent for each subscription's amount,
 * rounded DOWN to Stripe's 2 decimals so the club is never over-charged).
 * Takes effect from each subscription's NEXT invoice. Nothing is charged now.
 *
 * DRY RUN BY DEFAULT. Writing needs --apply AND either --all or --subs.
 *
 *   npx tsx scripts/backfill-platform-fee.ts --club frogempire607
 *   npx tsx scripts/backfill-platform-fee.ts --club frogempire607 --apply --subs sub_123,sub_456
 *   npx tsx scripts/backfill-platform-fee.ts --club frogempire607 --apply --all
 *
 * Re-running is safe: a subscription already at its target percent is skipped.
 * Julian runs this from his own terminal (it needs the live STRIPE_SECRET_KEY
 * and DATABASE_URL in web/.env).
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import Stripe from "stripe";
import { PrismaClient } from "@prisma/client";
import { feePolicyFor, platformNominalCents } from "../lib/fees";
import { describePlatformFee } from "../lib/tier";

const argv = process.argv.slice(2);
const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const APPLY = argv.includes("--apply");
const ALL = argv.includes("--all");
const SUBS = (arg("--subs") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const SLUG = arg("--club");

if (!SLUG) { console.error("Refusing: --club <slug> is required (e.g. --club frogempire607)."); process.exit(1); }
if (APPLY && !ALL && SUBS.length === 0) { console.error("Refusing: --apply needs --all or --subs sub_…,sub_…"); process.exit(1); }
if (!process.env.STRIPE_SECRET_KEY) { console.error("STRIPE_SECRET_KEY is not set (run from web/ so .env loads)."); process.exit(1); }

const LIVE = new Set(["active", "trialing", "past_due", "unpaid", "paused"]);

async function main() {
  const prisma = new PrismaClient();
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2023-10-16" });
  try {
    const club = await prisma.club.findUnique({
      where: { slug: SLUG },
      select: { id: true, name: true, tier: true, stripeAccountId: true, passProcessingFees: true, passPlatformFee: true },
    });
    if (!club) throw new Error(`No club with slug "${SLUG}"`);
    if (!club.stripeAccountId) throw new Error(`${club.name} has no connected Stripe account`);
    const policy = feePolicyFor(club);
    console.log(`${club.name} · tier ${club.tier} · platform fee ${describePlatformFee(club.tier)} · ${APPLY ? "APPLY" : "DRY RUN"}\n`);

    const rows: { id: string; status: string; unitCents: number; fromPct: number; toPct: number; feePerPeriodCents: number; action: string }[] = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await stripe.subscriptions.list(
        { limit: 100, status: "all", expand: ["data.items.data.price"], ...(startingAfter ? { starting_after: startingAfter } : {}) },
        { stripeAccount: club.stripeAccountId },
      );
      for (const sub of res.data) {
        if (!LIVE.has(sub.status)) continue;
        const item = sub.items.data[0];
        const unitCents = (item?.price?.unit_amount ?? 0) * (item?.quantity ?? 1);
        const fromPct = sub.application_fee_percent ?? 0;
        // The family pays `unitCents` (unchanged); the platform fee is taken on it.
        const feeCents = platformNominalCents(unitCents, { ...policy, passPlatform: false });
        const toPct = unitCents > 0 ? Math.floor((feeCents / unitCents) * 10000) / 100 : 0;
        let action = "update";
        if (unitCents <= 0) action = "skip: $0 subscription";
        else if (Math.abs(fromPct - toPct) < 0.001) action = "skip: already set";
        else if (!ALL && SUBS.length && !SUBS.includes(sub.id)) action = "skip: not in --subs";
        rows.push({ id: sub.id, status: sub.status, unitCents, fromPct, toPct, feePerPeriodCents: Math.round((unitCents * toPct) / 100), action });
      }
      if (!res.has_more) break;
      startingAfter = res.data[res.data.length - 1]?.id;
    }

    for (const r of rows) {
      console.log(`${r.id}  ${r.status.padEnd(9)} $${(r.unitCents / 100).toFixed(2).padStart(8)}  ${r.fromPct.toFixed(2)}% → ${r.toPct.toFixed(2)}%  (≈$${(r.feePerPeriodCents / 100).toFixed(2)}/period)  ${r.action}`);
    }
    const todo = rows.filter((r) => r.action === "update");
    console.log(`\n${rows.length} live subscriptions · ${todo.length} to update`);

    if (!APPLY) {
      console.log("\nDry run — nothing changed. Re-run with --apply --all (or --apply --subs …) to write.");
      return;
    }
    const done: typeof rows = [];
    for (const r of todo) {
      try {
        await stripe.subscriptions.update(r.id, { application_fee_percent: r.toPct }, { stripeAccount: club.stripeAccountId, idempotencyKey: `aox-backfill-platform-fee-${r.id}-${r.toPct}` });
        done.push(r);
        console.log(`  ✓ ${r.id} → ${r.toPct}%`);
      } catch (e) {
        console.log(`  ✗ ${r.id} — ${String(e)}`);
      }
    }
    const log = `backfill-platform-fee-${SLUG}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    writeFileSync(log, JSON.stringify({ club: club.name, at: new Date().toISOString(), updated: done, attempted: todo.length }, null, 2));
    console.log(`\nUpdated ${done.length}/${todo.length}. Log: web/${log}`);
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
