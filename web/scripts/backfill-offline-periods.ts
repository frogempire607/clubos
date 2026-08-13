/**
 * Backfill `currentPeriodEnd` on offline (non-Stripe) subscriptions.
 *
 * DRY RUN BY DEFAULT. Prints its full proposal and writes nothing. Applying
 * requires BOTH `--apply` and an explicit `--subs` allowlist, so a stray
 * `--apply` cannot sweep the club.
 *
 *   npx tsx scripts/backfill-offline-periods.ts
 *   npx tsx scripts/backfill-offline-periods.ts --apply --subs cmr9wc7...,cmrigr9...
 *
 * ── What it proposes, and what it refuses to ────────────────────────────────
 *
 * The period end is derived as startDate (or billingAnchorDate, when the owner
 * set one) + one billing period, advanced forward until it lands in the future.
 * That is a GUESS about a date nobody recorded, so:
 *
 *   - It never touches a row that already has currentPeriodEnd.
 *   - It never touches a Stripe-billed row; those are the reconciler's.
 *   - It reports, and skips, any row with no usable start date at all rather
 *     than inventing one.
 *   - It prints how many whole periods it had to roll forward. A row needing
 *     many rolls is one where nobody has recorded a payment in a long time —
 *     that is a collection question, not a data question, and it is flagged
 *     rather than quietly normalised.
 *
 * It deliberately does NOT set `paidThroughDate`. How far the money reaches is
 * a fact about payments received, and this script has no evidence of that. It
 * stays null (= unknown) until a payment is recorded against the subscription.
 */
import { PrismaClient } from "@prisma/client";
import { addBillingPeriod } from "../lib/billingAdmin";

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const subsArg = args.find((a) => a.startsWith("--subs="))
  ?? (args.includes("--subs") ? args[args.indexOf("--subs") + 1] : undefined);
const ALLOWLIST = (subsArg?.replace(/^--subs=/, "") ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const fmt = (d: Date | null) =>
  d ? d.toISOString().slice(0, 10) : "—";

async function main() {
  const now = new Date();

  const rows = await prisma.memberSubscription.findMany({
    where: {
      stripeSubscriptionId: null,          // offline only — Stripe rows belong to the reconciler
      currentPeriodEnd: null,              // never overwrite a known period
      status: { in: ["active", "pending", "past_due"] },
      member: { deletedAt: null },
    },
    select: {
      id: true, memberId: true, price: true, optionLabel: true, billingPeriod: true,
      billingType: true, status: true, startDate: true, billingAnchorDate: true,
      endDate: true, effectiveStartDate: true,
      member: { select: { firstName: true, lastName: true, clubId: true } },
      membership: { select: { name: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(`\n${APPLY ? "APPLY" : "DRY RUN"} — ${rows.length} offline subscription(s) with no period end\n`);
  if (rows.length === 0) { console.log("Nothing to do.\n"); return; }

  type Proposal = {
    id: string; who: string; plan: string; period: string; price: string;
    basis: string; anchor: Date | null; proposed: Date | null; rolls: number; note: string;
  };
  const proposals: Proposal[] = [];

  for (const r of rows) {
    const who = `${r.member.firstName ?? ""} ${r.member.lastName ?? ""}`.trim() || "(no name)";
    const plan = `${r.membership?.name ?? "?"} · ${r.optionLabel}`;
    const period = r.billingPeriod ?? "?";
    const price = `$${Number(r.price ?? 0).toFixed(2)}`;

    // Prefer an owner-set anchor; fall back to the effective start, then start.
    const anchor = r.billingAnchorDate ?? r.effectiveStartDate ?? r.startDate ?? null;
    const basis = r.billingAnchorDate ? "billingAnchorDate"
      : r.effectiveStartDate ? "effectiveStartDate"
      : r.startDate ? "startDate" : "none";

    if (!anchor || !r.billingPeriod) {
      proposals.push({
        id: r.id, who, plan, period, price, basis, anchor: null, proposed: null, rolls: 0,
        note: "SKIP — no usable start date or billing period. Nothing to derive from.",
      });
      continue;
    }

    // Roll forward whole periods until the end lands in the future.
    let end = addBillingPeriod(anchor, r.billingPeriod);
    let rolls = 1;
    const MAX_ROLLS = 240; // ~20 years of monthly; a runaway guard, never expected
    while (end.getTime() <= now.getTime() && rolls < MAX_ROLLS) {
      end = addBillingPeriod(end, r.billingPeriod);
      rolls += 1;
    }

    const note = rolls === 1
      ? "current period, derived directly"
      : rolls <= 3
        ? `rolled forward ${rolls} periods`
        : `rolled forward ${rolls} periods — nobody has recorded a payment here in a long time; CONFIRM before applying`;

    proposals.push({ id: r.id, who, plan, period, price, basis, anchor, proposed: end, rolls, note });
  }

  const pad = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n);
  console.log(
    pad("SUBSCRIPTION", 28) + pad("MEMBER", 20) + pad("PLAN", 26) +
    pad("PERIOD", 13) + pad("PRICE", 10) + pad("FROM", 12) + pad("→ END", 12) + "NOTE",
  );
  console.log("─".repeat(150));
  for (const p of proposals) {
    console.log(
      pad(p.id, 28) + pad(p.who, 20) + pad(p.plan, 26) + pad(p.period, 13) +
      pad(p.price, 10) + pad(fmt(p.anchor), 12) + pad(fmt(p.proposed), 12) +
      `${p.note} [basis: ${p.basis}]`,
    );
  }

  const actionable = proposals.filter((p) => p.proposed !== null);
  const skipped = proposals.filter((p) => p.proposed === null);
  const needConfirm = actionable.filter((p) => p.rolls > 3);

  console.log(`\n${actionable.length} derivable · ${skipped.length} skipped · ${needConfirm.length} need a closer look`);

  if (!APPLY) {
    console.log(
      "\nDry run — nothing was written.\n" +
      "Review the END column above. To apply, pass the ids you accept:\n" +
      `  npx tsx scripts/backfill-offline-periods.ts --apply --subs ${actionable.slice(0, 3).map((p) => p.id).join(",")}${actionable.length > 3 ? ",…" : ""}\n`,
    );
    return;
  }

  if (ALLOWLIST.length === 0) {
    console.error(
      "\nREFUSING: --apply requires an explicit --subs allowlist.\n" +
      "These are guessed dates on real memberships; they get confirmed one at a time.\n",
    );
    process.exitCode = 1;
    return;
  }

  let written = 0;
  for (const p of actionable) {
    if (!ALLOWLIST.includes(p.id)) continue;
    // Conditional: only fill a period end that is still absent, so a value
    // written by anything else since the dry run wins over this guess.
    const res = await prisma.memberSubscription.updateMany({
      where: { id: p.id, currentPeriodEnd: null, stripeSubscriptionId: null },
      data: { currentPeriodEnd: p.proposed! },
    });
    if (res.count === 1) { written += 1; console.log(`  set ${p.id} (${p.who}) → ${fmt(p.proposed)}`); }
    else console.log(`  SKIPPED ${p.id} (${p.who}) — no longer null, or now Stripe-billed`);
  }
  const unmatched = ALLOWLIST.filter((id) => !actionable.some((p) => p.id === id));
  for (const id of unmatched) console.log(`  NOT IN PROPOSAL: ${id}`);
  console.log(`\n${written} row(s) updated.\n`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
