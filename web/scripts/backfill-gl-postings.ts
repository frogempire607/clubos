// Accounting Phase 2, task 5 — post historical records onto the ledger.
// DRY-RUN by default.
//
//   npx tsx scripts/backfill-gl-postings.ts                       # dry run, every eligible club
//   npx tsx scripts/backfill-gl-postings.ts --clubs <slug>,…      # dry run, just these
//   npx tsx scripts/backfill-gl-postings.ts --apply --clubs <slug>
//
// --apply REFUSES to run without an explicit --clubs allowlist. There is no
// all-clubs apply mode: this writes journal entries, and the blast radius of a
// typo should be one club's books, not the platform's.
//
// JULIAN RUNS THIS FROM HIS OWN TERMINAL. The Claude Code sandbox cannot reach
// the database.
//
// ── WHAT MAKES THIS SAFE TO RE-RUN ─────────────────────────────────────────
// It calls the SAME `postPendingForClub` the app uses — not a parallel
// implementation — and that function is idempotent by construction: it asks the
// ledger which (sourceType, sourceId) pairs are already posted and posts only
// the rest, with the Phase 1 unique index as the backstop. So running it twice
// posts nothing the second time, and a run interrupted half way just resumes.
//
// ── WHAT IT WILL NOT DO ────────────────────────────────────────────────────
//   · it never posts anything dated before the club's books start date;
//   · a club with NO books start date is skipped entirely — that is the
//     setting's whole purpose and the script will not guess one;
//   · it never touches Stripe except to READ payouts (`payouts.list`);
//   · it never charges, refunds, emails or modifies a payment record.
//
// The dry run prints exactly what WOULD post, per club, including every reason
// a row is being held back — so the held-back rows are reviewable before
// anything is written.
import { PrismaClient } from "@prisma/client";
import { postPendingForClub } from "../lib/glPostingServer";
import { SKIP_LABELS, type SkipReason } from "../lib/glPosting";
import { canUseFeature } from "../lib/tier";

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const clubsArg = args.includes("--clubs") ? args[args.indexOf("--clubs") + 1] : null;
const limitArg = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : 2000;
const allow = new Set((clubsArg || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));

if (APPLY && allow.size === 0) {
  console.error(
    "--apply requires an explicit --clubs <id|slug>,… allowlist. There is no all-clubs apply mode.\n" +
      "Run the dry run first: npx tsx scripts/backfill-gl-postings.ts",
  );
  process.exit(1);
}

const ACTOR = { userId: null, name: "backfill-gl-postings script" };
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

async function main() {
  const clubs = await prisma.club.findMany({
    select: { id: true, name: true, slug: true, tier: true, booksStartDate: true },
  });

  const targets = clubs.filter((c) => {
    if (allow.size > 0 && !allow.has(c.id.toLowerCase()) && !allow.has(c.slug.toLowerCase())) return false;
    return true;
  });

  if (targets.length === 0) {
    console.log(allow.size > 0 ? "No club matched that --clubs list." : "No clubs found.");
    return;
  }

  console.log(`\n${APPLY ? "APPLYING" : "DRY RUN"} — posting historical records to the ledger\n`);

  let totalPosted = 0;
  const eligible: string[] = [];

  for (const club of targets) {
    const label = `${club.name} (${club.slug}, ${club.tier})`;

    if (!canUseFeature(club.tier, "fullFinancials")) {
      console.log(`  ·  skip   ${label} — the ledger is on Pro and Enterprise`);
      continue;
    }
    if (!club.booksStartDate) {
      console.log(`  ·  skip   ${label} — NO BOOKS START DATE. Set one in Financials → Books first; nothing posts without it.`);
      continue;
    }
    const start = club.booksStartDate.toISOString().slice(0, 10);

    if (!APPLY) {
      // A dry run must not write, and postPendingForClub always writes — so it
      // is NOT called here. Instead count what is on each side of the line,
      // which is the honest preview: "this many records exist on or after the
      // start date, this many are already posted."
      const from = new Date(`${start}T00:00:00.000Z`);
      const [txTotal, txPosted, expTotal, expPosted, bankTotal, bankPosted, payouts] = await Promise.all([
        prisma.transaction.count({
          where: {
            clubId: club.id,
            status: { in: ["SUCCEEDED", "REFUNDED"] },
            NOT: { reconciliationStatus: "VOID" },
            OR: [{ txDate: { gte: from } }, { txDate: null, createdAt: { gte: from } }],
          },
        }),
        prisma.glJournalEntry.count({ where: { clubId: club.id, sourceType: "STRIPE_CHARGE" } }),
        // Expense.category is NON-nullable (it defaults to "OTHER"), so every
        // expense is categorized and every one posts — "OTHER" maps to 6900
        // Miscellaneous. The uncategorized gate only bites on bank rows, whose
        // categoryOverride really is nullable.
        prisma.expense.count({ where: { clubId: club.id, date: { gte: from } } }),
        prisma.glJournalEntry.count({ where: { clubId: club.id, sourceType: "EXPENSE" } }),
        prisma.plaidTransaction.count({
          where: { clubId: club.id, date: { gte: from }, pending: false, categoryOverride: { not: null } },
        }),
        prisma.glJournalEntry.count({ where: { clubId: club.id, sourceType: "BANK_ROW" } }),
        prisma.payoutMatch.count({ where: { clubId: club.id, arrivalDate: { gte: from } } }),
      ]);
      const accounts = await prisma.glAccount.count({ where: { clubId: club.id } });
      console.log(`  →  ${label}`);
      console.log(`         books start ${start} · ${accounts} accounts in the chart`);
      console.log(`         payments      ${txTotal} on/after the start date · ${txPosted} already posted`);
      console.log(`         expenses      ${expTotal} on/after the start date · ${expPosted} already posted`);
      console.log(`         bank rows     ${bankTotal} categorized · ${bankPosted} already posted`);
      console.log(`         payouts       ${payouts} recorded (Stripe payouts are synced on apply)`);
      eligible.push(club.slug);
      continue;
    }

    console.log(`  →  ${label} — posting from ${start}…`);
    const report = await postPendingForClub(club.id, ACTOR, { limit: limitArg });
    totalPosted += report.posted;
    console.log(`     ✓ posted ${report.posted} entr${report.posted === 1 ? "y" : "ies"}`);

    const skips = Object.entries(report.skipped).sort((a, b) => b[1] - a[1]);
    for (const [reason, count] of skips) {
      const label2 = SKIP_LABELS[reason as SkipReason] ?? reason;
      console.log(`       · ${String(count).padStart(5)} ${label2}`);
    }
    // Examples make a held-back row actionable instead of just a number.
    for (const ex of report.examples.slice(0, 10)) {
      console.log(`         e.g. ${ex.sourceType} ${ex.sourceId}${ex.detail ? ` — ${ex.detail}` : ""}`);
    }
    for (const e of report.errors.slice(0, 10)) {
      console.log(`       ✗ ${e.sourceType} ${e.sourceId}: ${e.error}`);
    }

    // Re-read and verify, rather than trusting the write — the house pattern.
    const entries = await prisma.glJournalEntry.count({ where: { clubId: club.id, status: "POSTED" } });
    const lines = await prisma.glJournalLine.aggregate({
      where: { clubId: club.id, entry: { clubId: club.id, status: "POSTED" } },
      _sum: { debitCents: true, creditCents: true },
    });
    const d = lines._sum.debitCents ?? 0;
    const c = lines._sum.creditCents ?? 0;
    const balanced = d === c;
    console.log(
      `     ${balanced ? "✓" : "✗"} the whole ledger ${balanced ? "balances" : "DOES NOT BALANCE"}: ` +
        `${entries} entries, debits ${money(d)}, credits ${money(c)}`,
    );
    if (!balanced) {
      console.log("       ↑ stop and investigate before posting anything else for this club.");
    }
  }

  if (!APPLY) {
    console.log(
      `\n${eligible.length} club${eligible.length === 1 ? "" : "s"} ready to post.` +
        (eligible.length > 0
          ? `\nTo apply:  npx tsx scripts/backfill-gl-postings.ts --apply --clubs ${eligible.join(",")}`
          : ""),
    );
    return;
  }
  console.log(`\n✓ ${totalPosted} entr${totalPosted === 1 ? "y" : "ies"} posted.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
