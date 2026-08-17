/**
 * Stamp `MemberSubscription.optionId` on rows that can be identified without
 * guessing. DRY RUN BY DEFAULT.
 *
 * Step 2 of plan.md §8.10. Run scripts/mint-option-ids.ts --apply first; this
 * stamps ids, so they have to exist.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * A subscription is stamped only when exactly ONE option on its plan matches
 * its (billingPeriod, price). Zero matches or two matches means the row is
 * reported and left null.
 *
 * It deliberately does NOT match on `optionLabel`. The migration/approve path
 * writes the PLAN name there, so production carries rows labelled "MS/HS" and
 * "Jr Frogs" beside rows labelled "Monthly" — same plan, same price, same
 * period. Kellan Lister's row says "Upfront" for an option since renamed
 * "3 months Upfront". A label is what the member saw; it is not identity, and
 * a backfill that trusted it would stamp the wrong option on real members.
 *
 * ── Why leaving rows null is the correct outcome ────────────────────────────
 *
 * Null means "not identified", and every reader already handles it:
 * `resolveSubscriptionOption` returns `unresolved`, the price tool excludes the
 * row from bulk selection rather than repricing it, and the coverage resolver
 * fails OPEN so nobody is turned away at the door over a row we cannot read.
 * A wrong id would be worse than no id in all three places.
 *
 * Expected against production as of 2026-08-17: 28 live subscriptions →
 * 19 stamped, 9 unresolved, 0 ambiguous.
 *
 * (The earlier plan.md §8.1 figure of 27/18 excluded subscriptions whose PLAN
 * is soft-deleted. This script does NOT exclude them — a live subscription on
 * a retired plan still has to resolve its option, or it is permanently
 * unreadable in every surface. John Doe's $1 row on the soft-deleted "Test"
 * plan is the difference.)
 *
 * The nine that stay null are the known-open billing corrections (Barrett
 * David, Paul Ortega, Wyatt Eastman, Colton Waite) plus four legacy rates
 * (Adelynn Bergen, Riley Bergen, Aylen Grubusic, Clint Dwyer).
 *
 * Usage (from web/):
 *   npx tsx scripts/backfill-subscription-option-id.ts
 *   npx tsx scripts/backfill-subscription-option-id.ts --apply
 *   npx tsx scripts/backfill-subscription-option-id.ts --all-statuses
 */
import { prisma } from "../lib/prisma";
import { parseOptions, resolveSubscriptionOption } from "../lib/membershipOptions";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
// Default scope is the rows that can still be acted on. Canceled/expired
// history is stamped only on request — it changes no behaviour and a wrong
// stamp on a historical row is harder to notice.
const ALL_STATUSES = argv.includes("--all-statuses");
const LIVE_STATUSES = ["active", "pending", "past_due"];

const money = (v: unknown) => Number(v ?? 0).toFixed(2);

async function main() {
  const subs = await prisma.memberSubscription.findMany({
    where: {
      ...(ALL_STATUSES ? {} : { status: { in: LIVE_STATUSES } }),
      optionId: null,
      member: { deletedAt: null },
    },
    select: {
      id: true,
      optionId: true,
      optionLabel: true,
      billingPeriod: true,
      price: true,
      status: true,
      member: { select: { firstName: true, lastName: true } },
      membership: { select: { id: true, name: true, options: true, deletedAt: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const stamp: Array<{ id: string; optionId: string }> = [];
  const unresolved: Array<{ who: string; plan: string; label: string; period: string; price: string; why: string }> = [];
  let inferred = 0;
  let ambiguous = 0;

  for (const s of subs) {
    const options = parseOptions(s.membership.options);
    const who = `${s.member.firstName} ${s.member.lastName}`.trim();
    const row = {
      who,
      plan: s.membership.name,
      label: s.optionLabel,
      period: s.billingPeriod ?? "—",
      price: money(s.price),
      why: "",
    };

    if (options.length === 0) {
      unresolved.push({ ...row, why: "plan has no readable options" });
      continue;
    }
    if (options.some((o) => !o.id)) {
      unresolved.push({ ...row, why: "plan has un-minted options — run mint-option-ids.ts first" });
      continue;
    }

    const res = resolveSubscriptionOption(
      { optionId: null, billingPeriod: s.billingPeriod, price: s.price },
      options,
    );

    if (res.resolution === "inferred" && res.option.id) {
      inferred++;
      stamp.push({ id: s.id, optionId: res.option.id });
      console.log(
        `  ✓ ${who.padEnd(22)} ${s.membership.name.padEnd(34)} ` +
          `${row.period.padEnd(10)} $${row.price.padStart(8)} → ${res.option.label}`,
      );
    } else {
      if (res.resolution === "unresolved" && res.reason === "AMBIGUOUS") ambiguous++;
      unresolved.push({
        ...row,
        why:
          res.resolution === "unresolved" && res.reason === "AMBIGUOUS"
            ? "two options share this period AND price"
            : "no option on this plan matches this period + price",
      });
    }
  }

  if (unresolved.length > 0) {
    console.log("\nNOT STAMPED — reported, never guessed:");
    for (const u of unresolved) {
      console.log(`  · ${u.who.padEnd(22)} ${u.plan.padEnd(34)} ${u.period.padEnd(10)} $${u.price.padStart(8)}`);
      console.log(`      stored label "${u.label}" — ${u.why}`);
    }
  }

  console.log("");
  console.log("─".repeat(72));
  console.log(`Subscriptions considered:      ${subs.length}  (${ALL_STATUSES ? "all statuses" : LIVE_STATUSES.join("/")})`);
  console.log(`  stamped (unique match):      ${inferred}`);
  console.log(`  left null:                   ${unresolved.length}`);
  console.log(`    of which ambiguous:        ${ambiguous}`);

  if (ambiguous > 0) {
    console.log("\nAmbiguous rows mean a plan has two options at the same period AND price.");
    console.log("Rename or reprice one of them in the membership editor, then re-run.");
  }

  if (!APPLY) {
    console.log("\n── DRY RUN ── nothing was written.");
    console.log("Re-run with --apply to stamp the unique matches.");
    return;
  }

  let written = 0;
  for (const s of stamp) {
    await prisma.memberSubscription.update({ where: { id: s.id }, data: { optionId: s.optionId } });
    written++;
  }
  console.log(`\nStamped ${written} subscription${written === 1 ? "" : "s"}.`);

  // Read back rather than trusting the write.
  const recheck = await prisma.memberSubscription.findMany({
    where: { id: { in: stamp.map((s) => s.id) } },
    select: { id: true, optionId: true },
  });
  const missed = recheck.filter((r) => !r.optionId);
  if (missed.length > 0) {
    console.error(`\nVERIFY FAILED — ${missed.length} row(s) still have a null optionId.`);
    process.exit(1);
  }
  console.log("Verified: every stamped row now carries its optionId.");
  console.log(`${unresolved.length} row(s) remain null by design — see the report above.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
