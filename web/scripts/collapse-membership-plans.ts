/**
 * Collapse a commitment plan into its parent plan. DRY RUN BY DEFAULT, and
 * ONE STEP PER RUN — there is no "do it all" mode on purpose.
 *
 * plan.md §8.10. Each step is approved by the owner before it runs, so the
 * script refuses to guess which step you meant and never chains them.
 *
 *   npx tsx scripts/collapse-membership-plans.ts --step 3
 *   npx tsx scripts/collapse-membership-plans.ts --step 3 --apply
 *
 * ── Steps ───────────────────────────────────────────────────────────────────
 *   3  Append the commitment options to the parent plan (MS/HS, Jr Frogs)
 *   4  Set per-option contractMonths on the parent's existing options
 *   5  Set per-option entitlements
 *   6  Repoint live subscriptions onto the parent plan + its new option ids
 *   7  Repoint Member.membershipId for those members
 *   8  Deactivate the commitment plans AND remove them from class pricingOptions
 *   9  (verification only — reports coverage changes, writes nothing)
 *
 * ── Why every step re-reads ─────────────────────────────────────────────────
 *
 * "Jr Frogs Monthly Commitment has zero subscribers" was true when §8.10 was
 * written and false three days later. Every step counts what is there NOW and
 * prints it; nothing is taken from the spec.
 */
import { prisma } from "../lib/prisma";
import {
  makeOption,
  parseOptions,
  serializeOptions,
  withMintedIds,
  findDuplicateOptions,
  type MembershipOption,
} from "../lib/membershipOptions";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const stepIdx = argv.indexOf("--step");
const STEP = stepIdx >= 0 ? Number(argv[stepIdx + 1]) : NaN;

/** The two collapses, named by plan rather than by id so the script is readable. */
const COLLAPSES = [
  {
    parent: "MS/HS",
    commitment: "MS/HS 3 or 12 months Commitment",
    add: [
      { label: "3 Months", price: 160, billingPeriod: "MONTHLY" as const, contractMonths: 3 },
      { label: "12 months", price: 150, billingPeriod: "MONTHLY" as const, contractMonths: 12 },
    ],
  },
  {
    parent: "Jr Frogs",
    commitment: "Jr Frogs Monthly Commitment",
    add: [
      { label: "3 months", price: 90, billingPeriod: "MONTHLY" as const, contractMonths: 3 },
      { label: "12 months", price: 80, billingPeriod: "MONTHLY" as const, contractMonths: 12 },
    ],
  },
];

const CLUB_NAME = "Frog Empire Wrestling Academy";

async function planByName(name: string) {
  const rows = await prisma.membership.findMany({
    where: { name, deletedAt: null, club: { name: CLUB_NAME } },
    select: { id: true, name: true, options: true, active: true, contractMonths: true },
  });
  if (rows.length !== 1) {
    throw new Error(`Expected exactly one active plan named "${name}", found ${rows.length}. Refusing.`);
  }
  return rows[0];
}

async function liveSubsOn(membershipId: string) {
  return prisma.memberSubscription.findMany({
    where: {
      membershipId,
      status: { in: ["active", "pending", "past_due"] },
      member: { deletedAt: null },
    },
    select: {
      id: true, optionId: true, optionLabel: true, price: true, billingPeriod: true,
      member: { select: { id: true, firstName: true, lastName: true, membershipId: true } },
    },
  });
}

// ── Step 3 ──────────────────────────────────────────────────────────────────
async function step3() {
  console.log("STEP 3 — append the commitment options to the parent plan\n");
  console.log("Touches: memberships.options on the PARENT plans only.");
  console.log("Does NOT touch: any subscription, any member, the commitment plans.\n");

  for (const c of COLLAPSES) {
    const parent = await planByName(c.parent);
    const before = parseOptions(parent.options);
    console.log(`── ${parent.name} (${parent.id})`);
    console.log(`   ${before.length} options today:`);
    for (const o of before) {
      const n = await prisma.memberSubscription.count({
        where: { membershipId: parent.id, optionId: o.id, status: { in: ["active", "pending", "past_due"] },
                 member: { deletedAt: null } },
      });
      console.log(`     ${o.id}  ${o.label} · $${o.price} · ${o.billingPeriod}  (${n} live)`);
    }

    // Skip anything already present — the step is idempotent.
    const toAdd = c.add.filter(
      (a) => !before.some((o) => o.label === a.label && o.price === a.price && o.billingPeriod === a.billingPeriod),
    );
    if (toAdd.length === 0) {
      console.log("   Both options are already on this plan — nothing to add.\n");
      continue;
    }

    const merged: MembershipOption[] = withMintedIds([
      ...before,
      ...toAdd.map((a) => makeOption(a)),
    ]);

    const dupes = findDuplicateOptions(merged);
    if (dupes.length > 0) {
      console.error(`   REFUSING: would create two options at the same period AND price:`);
      for (const d of dupes) console.error(`     $${d.price} ${d.billingPeriod}: ${d.labels.join(" / ")}`);
      console.error("   That is the one shape option inference cannot resolve.");
      process.exitCode = 1;
      continue;
    }

    console.log("   would add:");
    for (const o of merged.slice(before.length)) {
      console.log(`     ${o.id}  ${o.label} · $${o.price} · ${o.billingPeriod} · ${o.contractMonths}-month term`);
    }

    if (APPLY) {
      await prisma.membership.update({
        where: { id: parent.id },
        data: { options: serializeOptions(merged) },
      });
      const after = parseOptions((await planByName(c.parent)).options);
      const ok = after.length === merged.length && after.every((o) => !!o.id);
      console.log(`   WROTE. ${after.length} options now, every one carrying an id: ${ok ? "yes" : "NO — INVESTIGATE"}`);
      if (!ok) process.exitCode = 1;
    }
    console.log("");
  }

  if (!APPLY) {
    console.log("── DRY RUN ── nothing written. Re-run with --apply.");
  } else {
    console.log("Step 3 done. The new options are PURCHASABLE from this moment.");
    console.log("Before step 6, re-run with --step 6 (dry run) to confirm nobody has bought one.");
  }
}

async function main() {
  if (!Number.isInteger(STEP)) {
    console.error("Refusing: --step <n> is required. One step per run, approved before it runs.");
    process.exit(1);
  }
  switch (STEP) {
    case 3: await step3(); break;
    default:
      console.error(`Step ${STEP} is not implemented yet. Steps 4-9 land as they are approved.`);
      process.exit(1);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
