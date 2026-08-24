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
 *   4  Set per-option contractMonths, and clear the plan-level fallback
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
/** Step 4 only — keep the plan-level contractMonths instead of clearing it. */
const KEEP_PLAN_TERM = argv.includes("--keep-plan-term");
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

// ── Step 4 ──────────────────────────────────────────────────────────────────
//
// Terms move ONTO the option. Two writes per plan, and the second is the one
// that matters more than it looks.
//
// ── Why the plan-level contractMonths is cleared ────────────────────────────
//
// §8.10 Step 4 says "`Membership.contractMonths` stays 1 as the fallback for
// anything unset. Nothing reads it today, so this changes no behaviour until
// §8.8.1 ships."
//
// §8.8.1 HAS now shipped. `resolveTerms` falls back to the plan value, so an
// option left unset no longer means "no commitment" — it means "inherit 1
// month". Leaving MS/HS at 1 would stamp a one-month `minimumTermEndsAt` on
// every new $175 Monthly Full and $110 Tue/Thu purchase, and the cancellation
// queue would then flag an early termination for anyone leaving a
// month-to-month membership inside their first month. That is a new behaviour
// nobody asked for, arriving through a sentence that was true when it was
// written.
//
// So the plan-level value is cleared in the same step that sets the real ones:
// after this, "unset" genuinely means no term, and the only terms that exist
// are the ones stated on an option. `--keep-plan-term` opts out.
//
// ── Why unlisted labels are left alone ──────────────────────────────────────
//
// The table below is the APPROVED set from §8.10, keyed by exact label. An
// option whose label is not in it is printed and skipped — never guessed from
// the wording. "3 months Upfront" happening to contain "3 months" is not
// evidence of anything, and inventing a minimum term binds a real family to a
// commitment nobody sold them.
const STEP4: Record<string, { options: Record<string, number | null> }> = {
  // §8.10 Step 4, verbatim. The last two were appended by Step 3 and already
  // carry these values; they are listed so the read-back can assert all six.
  "MS/HS": {
    options: {
      "Monthly Full Membership": null,
      "Monthly 2 days (Tue/Thu)": null,
      "3 months Upfront": 3,
      "1 year": 12,
      "3 Months": 3,
      "12 months": 12,
    },
  },
  // §8.10 Step 10 says "same shape" but never enumerates Jr Frogs' three
  // pre-existing options, so only the two Step 3 added are listed. The rest
  // will print as UNLISTED and change nothing until their terms are stated.
  "Jr Frogs": {
    options: {
      "3 months": 3,
      "12 months": 12,
    },
  },
};

async function step4() {
  console.log("STEP 4 — put the terms on the options, and stop the plan implying one\n");
  console.log("Touches: memberships.options AND memberships.contractMonths, parents only.");
  console.log("Does NOT touch: any subscription, any member, any Stripe object.\n");

  let needsDecision = 0;

  for (const c of COLLAPSES) {
    const parent = await planByName(c.parent);
    const table = STEP4[c.parent];
    if (!table) {
      console.error(`   No approved term table for "${c.parent}". Refusing.`);
      process.exitCode = 1;
      continue;
    }
    const before = parseOptions(parent.options);
    console.log(`── ${parent.name} (${parent.id})`);
    console.log(`   plan contractMonths today: ${parent.contractMonths ?? "null"}`);
    console.log("");

    const after = before.map((o) => o);
    for (const o of after) {
      const live = await prisma.memberSubscription.count({
        where: {
          membershipId: parent.id, optionId: o.id,
          status: { in: ["active", "pending", "past_due"] }, member: { deletedAt: null },
        },
      });
      const listed = Object.prototype.hasOwnProperty.call(table.options, o.label);
      const proposed = listed ? table.options[o.label] : o.contractMonths;

      // What each option ACTUALLY resolves to, before and after — which is the
      // number that reaches minimumTermEnd, not the stored one.
      const effBefore = o.contractMonths ?? parent.contractMonths ?? null;
      const effAfter = proposed ?? (KEEP_PLAN_TERM ? parent.contractMonths ?? null : null);

      const mark = !listed ? "UNLISTED" : proposed === o.contractMonths ? "unchanged" : "SET";
      console.log(`   ${o.label}  ($${o.price} ${o.billingPeriod}, ${live} live)`);
      console.log(`     stored ${String(o.contractMonths)} → ${String(proposed)}   [${mark}]`);
      console.log(
        `     effective term ${effBefore == null ? "none" : effBefore + " month(s)"}` +
        ` → ${effAfter == null ? "none" : effAfter + " month(s)"}` +
        (effBefore !== effAfter ? "   ← CHANGES what a new purchase commits to" : ""),
      );
      if (!listed) {
        needsDecision++;
        console.log("     ↑ not in the approved table — left exactly as it is. Tell me its term.");
      }
      if (listed) o.contractMonths = proposed;
    }

    const planTermAfter = KEEP_PLAN_TERM ? parent.contractMonths : null;
    console.log("");
    console.log(`   plan contractMonths: ${parent.contractMonths ?? "null"} → ${planTermAfter ?? "null"}`);
    if (!KEEP_PLAN_TERM && parent.contractMonths != null) {
      console.log("     Clearing it is the point: with §8.8.1 shipped, leaving it set");
      console.log(`     gives every unset option a ${parent.contractMonths}-month minimum term.`);
      console.log("     It also removes the \"" + parent.contractMonths + "-month minimum commitment\" line");
      console.log("     members currently see on this plan's card.");
    }

    if (APPLY) {
      await prisma.membership.update({
        where: { id: parent.id },
        data: { options: serializeOptions(after), contractMonths: planTermAfter },
      });

      // Read back and compare EVERY field. This write re-serializes the whole
      // options array, so it is the write that could silently drop the ids
      // Step 3 just minted, or an entitlement, or a price.
      const reread = await planByName(c.parent);
      const got = parseOptions(reread.options);
      const problems: string[] = [];
      if (got.length !== before.length) problems.push(`option count ${before.length} → ${got.length}`);
      for (let i = 0; i < Math.min(got.length, before.length); i++) {
        const a = before[i], b = got[i];
        if (a.id !== b.id) problems.push(`${a.label}: id changed`);
        if (!b.id) problems.push(`${b.label}: lost its id`);
        if (a.label !== b.label) problems.push(`label ${a.label} → ${b.label}`);
        if (a.price !== b.price) problems.push(`${a.label}: price ${a.price} → ${b.price}`);
        if (a.billingPeriod !== b.billingPeriod) problems.push(`${a.label}: period changed`);
        if (JSON.stringify(a.entitlement) !== JSON.stringify(b.entitlement))
          problems.push(`${a.label}: entitlement changed`);
        const want = Object.prototype.hasOwnProperty.call(table.options, a.label)
          ? table.options[a.label] : a.contractMonths;
        if (b.contractMonths !== want) problems.push(`${a.label}: contractMonths ${b.contractMonths} ≠ ${want}`);
      }
      if (reread.contractMonths !== planTermAfter) problems.push("plan contractMonths did not take");

      if (problems.length) {
        console.error("   WROTE, BUT THE READ-BACK DISAGREES — INVESTIGATE:");
        for (const p of problems) console.error(`     ${p}`);
        process.exitCode = 1;
      } else {
        console.log(`   WROTE. ${got.length} options, every id intact, only the terms moved.`);
      }
    }
    console.log("");
  }

  if (needsDecision > 0) {
    console.log(`${needsDecision} option(s) had no approved term and were left untouched.`);
    console.log("Step 4 is not finished for those until their terms are stated.\n");
  }
  if (!APPLY) {
    console.log("── DRY RUN ── nothing written. Re-run with --apply.");
  } else {
    console.log("Step 4 done. No subscription or member row was touched.");
  }
}

async function main() {
  if (!Number.isInteger(STEP)) {
    console.error("Refusing: --step <n> is required. One step per run, approved before it runs.");
    process.exit(1);
  }
  switch (STEP) {
    case 3: await step3(); break;
    case 4: await step4(); break;
    default:
      console.error(`Step ${STEP} is not implemented yet. Steps 5-9 land as they are approved.`);
      process.exit(1);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
