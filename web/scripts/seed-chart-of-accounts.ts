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
import { ensureSystemAccounts } from "../lib/ledgerServer";
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

type Plan = {
  clubId: string; name: string; slug: string; tier: string;
  existing: number; willCreate: number; skip: string | null;
  /// System accounts the template has gained since this club was seeded. These
  /// are topped up even on a club that is otherwise left alone — Phase 2 posts
  /// to them by systemKey, so a club missing one fails to post.
  missingSystem: { number: string; name: string; systemKey: string }[];
};

async function collect(): Promise<Plan[]> {
  const clubs = await prisma.club.findMany({ select: { id: true, name: true, slug: true, tier: true } });
  const plans: Plan[] = [];

  for (const club of clubs) {
    if (allow.size > 0 && !allow.has(club.id.toLowerCase()) && !allow.has(club.slug.toLowerCase())) continue;

    const rows = await prisma.glAccount.findMany({
      where: { clubId: club.id },
      select: { number: true, systemKey: true },
    });
    const existing = rows.length;
    const haveKeys = new Set(rows.map((r) => r.systemKey).filter((k): k is string => !!k));
    const missingSystem =
      existing > 0
        ? CHART_TEMPLATE.filter((r) => r.isSystem && r.systemKey && !haveKeys.has(r.systemKey)).map((r) => ({
            number: r.number,
            name: r.name,
            systemKey: r.systemKey!,
          }))
        : [];

    let skip: string | null = null;
    // Eligibility is the same flag the routes gate on — one definition.
    if (!canUseFeature(club.tier, "fullFinancials")) {
      skip = `tier is ${club.tier} — the ledger is on Pro and Enterprise`;
    } else if (existing > 0) {
      skip =
        missingSystem.length > 0
          ? `already has ${existing} accounts — will TOP UP ${missingSystem.map((m) => `${m.number} ${m.name}`).join(", ")}`
          : `already has ${existing} account${existing === 1 ? "" : "s"}`;
    }
    plans.push({
      clubId: club.id,
      name: club.name,
      slug: club.slug,
      tier: club.tier,
      existing,
      willCreate: skip ? 0 : CHART_TEMPLATE.length,
      skip,
      missingSystem: canUseFeature(club.tier, "fullFinancials") ? missingSystem : [],
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
  const topUps = plans.filter((p) => p.missingSystem.length > 0);
  console.log(`\n${APPLY ? "APPLYING" : "DRY RUN"} — chart of accounts (${CHART_TEMPLATE.length} accounts per club)\n`);
  for (const p of plans) {
    const label = `${p.name} (${p.slug}, ${p.tier})`;
    if (p.skip) console.log(`  ·  skip   ${label} — ${p.skip}`);
    else console.log(`  →  seed   ${label} — would create ${p.willCreate} accounts`);
  }

  if (!APPLY) {
    const targets = [...new Set([...eligible, ...topUps].map((p) => p.slug))];
    console.log(
      `\n${eligible.length} club${eligible.length === 1 ? "" : "s"} would be seeded from scratch; ` +
        `${topUps.length} already seeded would get a system account topped up.` +
        (targets.length > 0
          ? `\nTo apply:  npx tsx scripts/seed-chart-of-accounts.ts --apply --clubs ${targets.join(",")}`
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
  // Top up already-seeded clubs with any system account the template gained
  // after they were set up (1020 Undeposited Funds, 2026-10-20). Additive only
  // — lib/ledgerServer.ensureSystemAccounts never touches an existing row.
  let topped = 0;
  for (const p of topUps) {
    const { added } = await ensureSystemAccounts(p.clubId, {
      userId: null,
      name: "seed-chart-of-accounts script",
    });
    topped += added.length;
    for (const a of added) console.log(`  +  ${p.name}: added ${a.number} ${a.name}`);
    const stillMissing = p.missingSystem.filter((m) => !added.some((a) => a.systemKey === m.systemKey));
    for (const m of stillMissing) console.log(`  ✗  ${p.name}: could NOT add ${m.number} ${m.name} — inspect by hand`);
  }

  console.log(
    `\n✓ ${total} accounts created across ${eligible.length} club${eligible.length === 1 ? "" : "s"}` +
      (topped > 0 ? `; ${topped} system account${topped === 1 ? "" : "s"} topped up on already-seeded clubs` : "") +
      ".",
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
