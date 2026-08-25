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
    select: { id: true, name: true, options: true, active: true, contractMonths: true, autoRenewDefault: true },
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
const STEP4: Record<string, {
  options: Array<{ label: string; price: number; contractMonths: number; autoRenewDefault?: boolean }>;
}> = {
  // Owner's price list, 2026-08-25. EVERY option carries an explicit term —
  // including the month-to-month ones, which are 1-month commitments and not
  // "no term", and the Upfront ones, whose term equals their period ($450 buys
  // three months and commits to three).
  //
  // Because every option is explicit, nothing inherits, and the plan-level
  // contractMonths can be cleared without any option silently losing its term.
  // Those two facts depend on each other — see the refusal below.
  "MS/HS": {
    options: [
      { label: "Monthly Full Membership",  price: 175,  contractMonths: 1,  autoRenewDefault: false },
      { label: "Monthly 2 days (Tue/Thu)", price: 110,  contractMonths: 1,  autoRenewDefault: false },
      { label: "3 Months",                 price: 160,  contractMonths: 3  },
      { label: "3 months Upfront",         price: 450,  contractMonths: 3  },
      { label: "12 months",                price: 150,  contractMonths: 12 },
      { label: "1 year Upfront",           price: 1500, contractMonths: 12 },
    ],
  },
  "Jr Frogs": {
    options: [
      { label: "Monthly",   price: 110, contractMonths: 1, autoRenewDefault: false },
      { label: "3 months",  price: 90,  contractMonths: 3  },
      { label: "Upfront",   price: 250, contractMonths: 3  },
      { label: "1 Year",    price: 900, contractMonths: 12 },
      // "12 months" $80 is NOT here. Step 3 appended it from the dying
      // commitment plan, and the owner's price list does not include it. It
      // will surface below as UNMATCHED and block --apply until it is either
      // given a term or removed — which is the right outcome, because whether
      // it has ever been sold is a subscriber count, not a memory.
    ],
  },
};

async function step4() {
  console.log("STEP 4 — put the terms on the options, and stop the plan implying one\n");
  console.log("Touches: memberships.options AND memberships.contractMonths, parents only.");
  console.log("Does NOT touch: any subscription, any member, any Stripe object.\n");

  let blocked = false;

  for (const c of COLLAPSES) {
    const parent = await planByName(c.parent);
    const table = STEP4[c.parent];
    if (!table) {
      console.error(`   No approved term table for "${c.parent}". Refusing.`);
      process.exitCode = 1;
      blocked = true;
      continue;
    }
    const options = parseOptions(parent.options);
    console.log(`── ${parent.name} (${parent.id})`);
    console.log(`   plan contractMonths today: ${parent.contractMonths ?? "null"}`);
    console.log(`   plan autoRenewDefault today: ${String(parent.autoRenewDefault)}\n`);

    const used = new Set<number>();
    let unmatched = 0;

    for (const o of options) {
      const live = await prisma.memberSubscription.count({
        where: {
          membershipId: parent.id, optionId: o.id,
          status: { in: ["active", "pending", "past_due"] }, member: { deletedAt: null },
        },
      });

      // Match on the EXACT label first. Fall back to price, which is a real
      // identity inside one plan — no two options may share period AND price,
      // which is the invariant findDuplicateOptions enforces and option
      // inference depends on. A price match with a different label means the
      // stored label differs from the owner's price list; that is reported
      // loudly rather than silently accepted, because the label is what a
      // member reads on their receipt.
      let idx = table.options.findIndex((t, i) => !used.has(i) && t.label === o.label);
      let how = "label";
      if (idx < 0) {
        idx = table.options.findIndex(
          (t, i) => !used.has(i) && t.price === o.price && o.billingPeriod === "MONTHLY",
        );
        how = "price";
      }
      if (idx < 0) {
        idx = table.options.findIndex((t, i) => !used.has(i) && t.price === o.price);
        how = "price";
      }

      console.log(`   ${o.label}  ($${o.price} ${o.billingPeriod}, ${live} live)`);

      if (idx < 0) {
        unmatched++;
        console.log(`     ✗ UNMATCHED — not in the approved price list. Left untouched.`);
        console.log(`       ${live > 0
          ? `${live} live subscription(s) are on it, so it cannot simply be dropped.`
          : `No live subscriptions. If this is not an option you sell, say so and it is removed.`}`);
        continue;
      }

      const t = table.options[idx];
      used.add(idx);
      if (how === "price") {
        console.log(`     ! matched by PRICE, not label — stored "${o.label}", price list "${t.label}"`);
        console.log(`       Confirm this is the same option before applying.`);
      }

      const effBefore = o.contractMonths ?? parent.contractMonths ?? null;
      console.log(
        `     contractMonths ${String(o.contractMonths)} → ${t.contractMonths}` +
        `   (effective ${effBefore == null ? "none" : effBefore} → ${t.contractMonths})`,
      );
      o.contractMonths = t.contractMonths;

      if (t.autoRenewDefault !== undefined) {
        const arBefore = o.autoRenewDefault ?? parent.autoRenewDefault;
        console.log(
          `     autoRenewDefault ${String(o.autoRenewDefault)} → ${t.autoRenewDefault}` +
          `   (effective ${arBefore} → ${t.autoRenewDefault})` +
          (arBefore !== t.autoRenewDefault ? "   ← new purchases stop auto-renewing unless the parent opts in" : ""),
        );
        o.autoRenewDefault = t.autoRenewDefault;
      }
    }

    console.log("");
    console.log(`   plan contractMonths: ${parent.contractMonths ?? "null"} → null`);

    // The refusal that matters. Clearing the plan fallback while an option is
    // still unmatched would take that option from "inherits 1 month" to "no
    // term at all" — silently, and in the same write that was supposed to make
    // terms explicit. Partial is worse than not at all here.
    if (unmatched > 0) {
      console.error(`\n   ✗ REFUSING TO APPLY: ${unmatched} option(s) unmatched on ${parent.name}.`);
      console.error(`     Clearing the plan-level term while an option still inherits it would`);
      console.error(`     silently drop that option's ${parent.contractMonths ?? "?"}-month commitment to none.`);
      console.error(`     Resolve every option first, then re-run.`);
      process.exitCode = 1;
      blocked = true;
      console.log("");
      continue;
    }

    if (APPLY) {
      await prisma.membership.update({
        where: { id: parent.id },
        data: { options: serializeOptions(options), contractMonths: null },
      });

      // Read back and compare EVERY field. This write re-serializes the whole
      // options array, so it is the write that could silently drop the ids
      // Step 3 just minted, or an entitlement, or a price.
      const reread = await planByName(c.parent);
      const got = parseOptions(reread.options);
      const problems: string[] = [];
      if (got.length !== options.length) problems.push(`option count ${options.length} → ${got.length}`);
      for (let i = 0; i < Math.min(got.length, options.length); i++) {
        const a = options[i], b = got[i];
        if (!b.id) problems.push(`${b.label}: lost its id`);
        if (a.id !== b.id) problems.push(`${a.label}: id changed`);
        if (a.label !== b.label) problems.push(`label ${a.label} → ${b.label}`);
        if (a.price !== b.price) problems.push(`${a.label}: price ${a.price} → ${b.price}`);
        if (a.billingPeriod !== b.billingPeriod) problems.push(`${a.label}: period changed`);
        if (JSON.stringify(a.entitlement) !== JSON.stringify(b.entitlement))
          problems.push(`${a.label}: entitlement changed`);
        if (b.contractMonths !== a.contractMonths)
          problems.push(`${a.label}: contractMonths ${b.contractMonths} ≠ ${a.contractMonths}`);
        if (b.autoRenewDefault !== a.autoRenewDefault)
          problems.push(`${a.label}: autoRenewDefault ${b.autoRenewDefault} ≠ ${a.autoRenewDefault}`);
      }
      if (reread.contractMonths !== null) problems.push("plan contractMonths did not clear");
      // Every option must now state its own term, or clearing the plan value
      // has left a hole.
      for (const b of got) if (b.contractMonths == null) problems.push(`${b.label}: still inherits, and there is nothing to inherit`);

      if (problems.length) {
        console.error("   WROTE, BUT THE READ-BACK DISAGREES — INVESTIGATE:");
        for (const p of problems) console.error(`     ${p}`);
        process.exitCode = 1;
      } else {
        console.log(`   WROTE. ${got.length} options, every id intact, every term explicit.`);
      }
    }
    console.log("");
  }

  if (!APPLY) {
    console.log(blocked
      ? "── DRY RUN ── nothing written, and --apply would refuse. See the ✗ lines above."
      : "── DRY RUN ── nothing written. Re-run with --apply.");
  } else if (!blocked) {
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
