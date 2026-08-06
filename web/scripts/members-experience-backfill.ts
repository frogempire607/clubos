// Phase 4.5 — backfills for 20260804000000_members_experience.
//
// DRY-RUN BY DEFAULT. Prints a per-club report of exactly what it would write.
// `--apply` requires an explicit `--clubs` allowlist unless you also pass
// `--i-really-mean-all-clubs`, the same guard scripts/migrate-manual-to-stripe.ts
// uses. Julian runs this from his own terminal; the sandbox cannot reach the DB.
//
//   npx tsx scripts/members-experience-backfill.ts                        dry-run, all clubs
//   npx tsx scripts/members-experience-backfill.ts --clubs=<id>           dry-run, one club
//   npx tsx scripts/members-experience-backfill.ts --apply --clubs=<id>   write
//
// ── RUN THE MIGRATION FIRST ──────────────────────────────────────────────────
// Every column and table this touches is created by
// 20260804000000_members_experience. Running before `prisma migrate deploy`
// fails on an unknown column, harmlessly, before writing anything.
//
// ── Two passes ───────────────────────────────────────────────────────────────
//
// BF-A  members.reviewedAt / reviewedByUserId
//       Step 2 of the migration meter is "Information reviewed". Until now the
//       roster INFERRED it from a NOTE MemberMigrationEvent — which only ever
//       meant "somebody edited this row", not "somebody checked it". The
//       inference is the best evidence that exists for historical rows, so we
//       promote it once, explicitly, with the actor it recorded, and everything
//       after this point records the fact directly.
//
//       Deliberately conservative: only members who are actually mid-migration,
//       and only where a NOTE event carries an actor. A NOTE with no actorUserId
//       tells us an edit happened but not who made it, and a review with no
//       reviewer is not a fact worth asserting.
//
// BF-B  member_subscription_events
//       Synthesizes the history Reports needs to stop saying ESTIMATED. For
//       every existing subscription: one CREATED at createdAt, then whichever
//       of ACTIVATED / CANCELED / EXPIRED / PAUSED its timestamps support.
//
//       Every synthesized row is stamped source='SYSTEM' with
//       detail.backfill=true so Reports can exclude reconstructed history from
//       "what changed this month" — a synthesized CREATED event is not a signup
//       that happened today, and counting it as one would put a spike in the
//       chart on the day this script runs.
//
//       Idempotent: it skips any subscription that already has events, so a
//       re-run after a partial failure cannot double-count.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const APPLY = process.argv.includes("--apply");
const ALL_CLUBS = process.argv.includes("--i-really-mean-all-clubs");
const clubArg = process.argv.find((a) => a.startsWith("--clubs="));
const clubAllow = clubArg ? clubArg.slice("--clubs=".length).split(",").filter(Boolean) : null;

type Counts = { reviewed: number; subs: number; events: number; skipped: number };

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

async function main() {
  if (APPLY && !clubAllow && !ALL_CLUBS) {
    console.error(
      "\nRefusing to --apply without --clubs=<id[,id]>.\n" +
        "Pass --i-really-mean-all-clubs to override.\n",
    );
    process.exit(1);
  }

  const clubs = await prisma.club.findMany({
    where: clubAllow ? { id: { in: clubAllow } } : {},
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  console.log(`\n${APPLY ? "APPLY" : "DRY RUN"} · ${clubs.length} club(s)\n${"═".repeat(64)}`);

  const total: Counts = { reviewed: 0, subs: 0, events: 0, skipped: 0 };

  for (const club of clubs) {
    const c: Counts = { reviewed: 0, subs: 0, events: 0, skipped: 0 };
    console.log(`\n${club.name} (${club.id})`);

    // ── BF-A ────────────────────────────────────────────────────────────────
    const candidates = await prisma.member.findMany({
      where: {
        clubId: club.id,
        deletedAt: null,
        reviewedAt: null,
        migrationStatus: { not: null },
      },
      select: { id: true, firstName: true, lastName: true },
    });

    for (const m of candidates) {
      // The most recent NOTE with an actor is the best available evidence that
      // a human looked at this row.
      const note = await prisma.memberMigrationEvent.findFirst({
        where: { memberId: m.id, type: "NOTE", actorUserId: { not: null } },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true, actorUserId: true },
      });
      if (!note) {
        c.skipped++;
        continue;
      }
      c.reviewed++;
      if (APPLY) {
        await prisma.member.update({
          where: { id: m.id },
          data: { reviewedAt: note.createdAt, reviewedByUserId: note.actorUserId },
        });
      }
    }
    console.log(
      `  BF-A reviewedAt      ${fmt(c.reviewed)} of ${fmt(candidates.length)} mid-migration members` +
        (c.skipped ? ` · ${fmt(c.skipped)} left null (no attributable NOTE)` : ""),
    );

    // ── BF-B ────────────────────────────────────────────────────────────────
    const subs = await prisma.memberSubscription.findMany({
      where: { member: { clubId: club.id } },
      select: {
        id: true,
        memberId: true,
        status: true,
        optionLabel: true,
        price: true,
        createdAt: true,
        startedAt: true,
        canceledAt: true,
        expiredAt: true,
        pausedAt: true,
        membership: { select: { name: true } },
      },
    });

    for (const s of subs) {
      const existing = await prisma.memberSubscriptionEvent.count({
        where: { memberSubscriptionId: s.id },
      });
      if (existing > 0) {
        c.skipped++;
        continue;
      }
      c.subs++;

      const planName = s.membership?.name ?? s.optionLabel ?? null;
      const rows: { kind: string; at: Date }[] = [{ kind: "CREATED", at: s.createdAt }];

      if (s.startedAt) rows.push({ kind: "ACTIVATED", at: s.startedAt });
      else if (s.status === "active") rows.push({ kind: "ACTIVATED", at: s.createdAt });

      if (s.pausedAt) rows.push({ kind: "PAUSED", at: s.pausedAt });
      if (s.canceledAt) rows.push({ kind: "CANCELED", at: s.canceledAt });
      if (s.expiredAt) rows.push({ kind: "EXPIRED", at: s.expiredAt });

      c.events += rows.length;

      if (APPLY) {
        await prisma.memberSubscriptionEvent.createMany({
          data: rows.map((r) => ({
            clubId: club.id,
            memberSubscriptionId: s.id,
            memberId: s.memberId,
            kind: r.kind,
            // Only the "to" side is knowable for a synthesized CREATED /
            // ACTIVATED; there is no record of what came before. Leaving
            // fromPlan/fromAmount null is honest — a guessed previous plan
            // would show up in Reports as a plan change that never happened.
            toPlan: r.kind === "CREATED" || r.kind === "ACTIVATED" ? planName : null,
            toAmount: r.kind === "CREATED" || r.kind === "ACTIVATED" ? s.price : null,
            fromPlan: r.kind === "CANCELED" || r.kind === "EXPIRED" ? planName : null,
            fromAmount: r.kind === "CANCELED" || r.kind === "EXPIRED" ? s.price : null,
            at: r.at,
            source: "SYSTEM",
            detail: {
              backfill: true,
              script: "members-experience-backfill",
              inferredFrom: r.kind === "CREATED" ? "createdAt" : r.kind.toLowerCase() + "At",
            },
          })),
        });
      }
    }
    console.log(
      `  BF-B subscription events  ${fmt(c.events)} row(s) across ${fmt(c.subs)} subscription(s)` +
        (subs.length - c.subs ? ` · ${fmt(subs.length - c.subs)} already had history` : ""),
    );

    total.reviewed += c.reviewed;
    total.subs += c.subs;
    total.events += c.events;
    total.skipped += c.skipped;
  }

  console.log(`\n${"═".repeat(64)}`);
  console.log(
    `TOTAL  reviewedAt ${fmt(total.reviewed)} · subscription events ${fmt(total.events)} across ${fmt(total.subs)} subs`,
  );
  if (!APPLY) {
    console.log("\nDRY RUN — nothing was written. Re-run with --apply --clubs=<id> to commit.\n");
  } else {
    console.log(
      "\nApplied. Reports' Membership tab flips ESTIMATED → COMPLETE only after this\n" +
        "has run for the club being reported on.\n",
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
