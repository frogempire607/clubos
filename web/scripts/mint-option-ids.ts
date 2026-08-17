/**
 * Give every membership option a stable id. DRY RUN BY DEFAULT.
 *
 * Step 1 of plan.md §8.10. Must run BEFORE
 * scripts/backfill-subscription-option-id.ts, which stamps ids that have to
 * exist first.
 *
 * ── What it writes ──────────────────────────────────────────────────────────
 *
 * `memberships.options` only. It adds an `id` key to any option that lacks one
 * and rewrites the JSON. It never changes a label, a price, a billing period,
 * or any other column, and it never touches a subscription.
 *
 * ── Idempotent by construction ──────────────────────────────────────────────
 *
 * An option that already carries an id is skipped and its id is never
 * regenerated — re-running is a no-op. That matters because the id is about to
 * become the thing subscriptions point at; reassigning one would silently
 * repoint every member on that option.
 *
 * ── Soft-deleted plans are included, deliberately ───────────────────────────
 *
 * Frog Empire has seven soft-deleted "Continued membership" plans and two
 * "Elite National Champ" plans, and canceled/expired subscriptions still point
 * at them. Skipping those plans would leave historical rows permanently
 * unresolvable in any surface that reads option identity. They are reported
 * separately so the count is legible.
 *
 * Usage (from web/):
 *   npx tsx scripts/mint-option-ids.ts
 *   npx tsx scripts/mint-option-ids.ts --apply
 *   npx tsx scripts/mint-option-ids.ts --club <clubId>
 */
import { prisma } from "../lib/prisma";
import { parseOptions, serializeOptions, withMintedIds } from "../lib/membershipOptions";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const clubIdx = argv.indexOf("--club");
const CLUB = clubIdx >= 0 ? argv[clubIdx + 1] : null;

async function main() {
  const plans = await prisma.membership.findMany({
    where: { ...(CLUB ? { clubId: CLUB } : {}) },
    select: { id: true, clubId: true, name: true, options: true, deletedAt: true },
    orderBy: [{ deletedAt: "asc" }, { name: "asc" }],
  });

  let planned = 0;
  let alreadyDone = 0;
  let unreadable = 0;
  const writes: Array<{ id: string; options: string; name: string; deleted: boolean }> = [];

  for (const plan of plans) {
    const options = parseOptions(plan.options);
    if (options.length === 0) {
      // Either genuinely empty or unparseable. Either way there is nothing to
      // mint, and rewriting the column would risk turning bad JSON into
      // confidently-wrong JSON.
      unreadable++;
      console.log(`  ~ ${plan.name}${plan.deletedAt ? " (deleted)" : ""} — no readable options, skipped`);
      continue;
    }

    const missing = options.filter((o) => !o.id).length;
    if (missing === 0) {
      alreadyDone++;
      continue;
    }

    const minted = withMintedIds(options);
    planned += missing;
    writes.push({
      id: plan.id,
      options: serializeOptions(minted),
      name: plan.name,
      deleted: !!plan.deletedAt,
    });

    console.log(`  ${plan.name}${plan.deletedAt ? " (deleted)" : ""}`);
    for (let i = 0; i < options.length; i++) {
      const before = options[i];
      const after = minted[i];
      const mark = before.id ? "kept" : " new";
      console.log(`      [${mark}] ${after.id}  ${after.label} · $${after.price} · ${after.billingPeriod}`);
    }
  }

  console.log("");
  console.log("─".repeat(72));
  console.log(`Plans scanned:                 ${plans.length}`);
  console.log(`  already fully identified:    ${alreadyDone}`);
  console.log(`  with no readable options:    ${unreadable}`);
  console.log(`  to be written:               ${writes.length}`);
  console.log(`Option ids to mint:            ${planned}`);

  if (!APPLY) {
    console.log("\n── DRY RUN ── nothing was written.");
    console.log("Re-run with --apply to mint. Then run backfill-subscription-option-id.ts.");
    return;
  }

  let written = 0;
  for (const w of writes) {
    await prisma.membership.update({ where: { id: w.id }, data: { options: w.options } });
    written++;
  }
  console.log(`\nWrote ${written} plan${written === 1 ? "" : "s"}.`);

  // Read back and prove it, rather than trusting the write. Every option on
  // every plan we touched must now carry an id.
  const recheck = await prisma.membership.findMany({
    where: { id: { in: writes.map((w) => w.id) } },
    select: { id: true, name: true, options: true },
  });
  const stillMissing = recheck.filter((p) => parseOptions(p.options).some((o) => !o.id));
  if (stillMissing.length > 0) {
    console.error("\nVERIFY FAILED — these plans still have options without an id:");
    for (const p of stillMissing) console.error(`  - ${p.name} (${p.id})`);
    process.exit(1);
  }
  console.log("Verified: every option on every written plan now carries an id.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
