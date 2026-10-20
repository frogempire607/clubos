// Seed the sports-club chart of accounts into eligible clubs. DRY-RUN by default.
//
//   npx tsx scripts/seed-chart-of-accounts.ts                       # dry run, every eligible club
//   npx tsx scripts/seed-chart-of-accounts.ts --clubs <id|slug>,…   # dry run, just these
//   npx tsx scripts/seed-chart-of-accounts.ts --apply --clubs <id|slug>,…
//
// --apply REFUSES to run without an explicit --clubs allowlist. There is no
// all-clubs apply mode, deliberately: this writes ~60 rows per club and the
// blast radius of a typo should be one club, not the platform.
//
// JULIAN RUNS THIS FROM HIS OWN TERMINAL. The Claude Code sandbox cannot reach
// the database.
//
// What it does, per club:
//   · skips the club unless its tier includes fullFinancials (Pro/Enterprise)
//   · skips the club if it already has ANY gl_account — so a renamed account is
//     never overwritten and a deactivated one is never resurrected
//   · creates the template with skipDuplicates, matched on (clubId, number),
//     which is a unique index — a second run cannot duplicate anything
//   · writes a GlAuditLog row recording what was seeded
//
// Most clubs never need this script: the Chart of Accounts tab seeds on first
// read (lib/ledgerServer ensureChartOfAccounts). It exists for seeding ahead of
// time, and for seeing exactly what a club would get before they look.
import { PrismaClient } from "@prisma/client";
import { CHART_TEMPLATE, templateSortOrder } from "../lib/ledger";
import { canUseFeature } from "../lib/tier";

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const clubsArg = args.includes("--clubs") ? args[args.indexOf("--clubs") + 1] : null;
const allow = new Set((clubsArg || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));

if (APPLY && allow.size === 0) {
  console.error(
    "--apply requires an explicit --clubs <id|slug>,… allowlist. There is no all-clubs apply mode.\n" +
      "Run the dry run first: npx tsx scripts/seed-chart-of-accounts.ts",
  );
  process.exit(1);
}

type Plan = { clubId: string; name: string; slug: string; tier: string; existing: number; willCreate: number; skip: string | null };

async function collect(): Promise<Plan[]> {
  const clubs = await prisma.club.findMany({ select: { id: true, name: true, slug: true, tier: true } });
  const plans: Plan[] = [];

  for (const club of clubs) {
    if (allow.size > 0 && !allow.has(club.id.toLowerCase()) && !allow.has(club.slug.toLowerCase())) continue;

    const existing = await prisma.glAccount.count({ where: { clubId: club.id } });
    let skip: string | null = null;
    // Eligibility is the same flag the routes gate on — one definition.
    if (!canUseFeature(club.tier, "fullFinancials")) {
      skip = `tier is ${club.tier} — the ledger is on Pro and Enterprise`;
    } else if (existing > 0) {
      skip = `already has ${existing} account${existing === 1 ? "" : "s"}`;
    }
    plans.push({
      clubId: club.id,
      name: club.name,
      slug: club.slug,
      tier: club.tier,
      existing,
      willCreate: skip ? 0 : CHART_TEMPLATE.length,
      skip,
    });
  }
  return plans;
}

async function seed(plan: Plan): Promise<number> {
  const order = templateSortOrder();
  const result = await prisma.glAccount.createMany({
    data: CHART_TEMPLATE.map((row) => ({
      clubId: plan.clubId,
      number: row.number,
      name: row.name,
      type: row.type,
      subtype: row.subtype ?? null,
      normalBalance: row.normalBalance,
      isContra: row.isContra ?? false,
      isSystem: row.isSystem ?? false,
      systemKey: row.systemKey ?? null,
      description: row.description ?? null,
      sortOrder: order.get(row.number) ?? 0,
      createdByUserId: null,
    })),
    skipDuplicates: true,
  });

  if (result.count > 0) {
    await prisma.glAuditLog.create({
      data: {
        clubId: plan.clubId,
        objectType: "ACCOUNT",
        objectId: "chart",
        action: "CREATE",
        actorUserId: null,
        actorName: "seed-chart-of-accounts script",
        after: { seeded: result.count, template: "sports-club" },
        note: `Seeded the sports-club chart of accounts (${result.count} accounts) via scripts/seed-chart-of-accounts.ts.`,
      },
    });
  }
  return result.count;
}

async function main() {
  const plans = await collect();
  if (plans.length === 0) {
    console.log(allow.size > 0 ? "No club matched that --clubs list." : "No clubs found.");
    return;
  }

  const eligible = plans.filter((p) => !p.skip);
  console.log(`\n${APPLY ? "APPLYING" : "DRY RUN"} — chart of accounts (${CHART_TEMPLATE.length} accounts per club)\n`);
  for (const p of plans) {
    const label = `${p.name} (${p.slug}, ${p.tier})`;
    if (p.skip) console.log(`  ·  skip   ${label} — ${p.skip}`);
    else console.log(`  →  seed   ${label} — would create ${p.willCreate} accounts`);
  }

  if (!APPLY) {
    console.log(
      `\n${eligible.length} club${eligible.length === 1 ? "" : "s"} would be seeded.` +
        (eligible.length > 0
          ? `\nTo apply:  npx tsx scripts/seed-chart-of-accounts.ts --apply --clubs ${eligible.map((p) => p.slug).join(",")}`
          : ""),
    );
    return;
  }

  let total = 0;
  for (const p of eligible) {
    const n = await seed(p);
    total += n;
    // Re-read and verify, rather than trusting the write — the house pattern
    // from scripts/migrate-manual-to-stripe.ts.
    const after = await prisma.glAccount.count({ where: { clubId: p.clubId } });
    const systemAfter = await prisma.glAccount.count({ where: { clubId: p.clubId, isSystem: true } });
    const expectedSystem = CHART_TEMPLATE.filter((r) => r.isSystem).length;
    const ok = after === CHART_TEMPLATE.length && systemAfter === expectedSystem;
    console.log(
      `  ${ok ? "✓" : "✗"}  ${p.name}: created ${n}, now ${after} accounts (${systemAfter}/${expectedSystem} system)`,
    );
    if (!ok) console.log(`      ↑ unexpected count — inspect before seeding anything else.`);
  }
  console.log(`\n✓ ${total} accounts created across ${eligible.length} club${eligible.length === 1 ? "" : "s"}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
