/**
 * Undo an expiry that should not have happened. DRY RUN BY DEFAULT.
 *
 *   npx tsx scripts/restore-expired-subscriptions.ts
 *   npx tsx scripts/restore-expired-subscriptions.ts --apply --members "Riley Bergen"
 *   npx tsx scripts/restore-expired-subscriptions.ts --apply --members "Riley Bergen,Adelynn Bergen"
 *
 * ── What happened ───────────────────────────────────────────────────────────
 *
 * scripts/fix-commitment-end-dates.ts copied `Member.commitmentEndDate` onto
 * `MemberSubscription.endDate` and expired anything already past. For Riley and
 * Adelynn Bergen that date was 2026-08-14 — and they had each paid $750 CASH
 * for a YEAR. The run turned two paid-up annual members INACTIVE.
 *
 * The date was never theirs. `commitmentEndDate` on these rows is
 * `billingAnchorDate + 30 days`: a ONE-MONTH commitment length chosen during
 * migration setup, applied regardless of what the member actually bought. Both
 * sisters carry 2026-08-14 because both carry the migration anchor 2026-07-15 —
 * not because anything about their purchases matched. Riley started 2026-04-15
 * and Adelynn 2026-07-15, three months apart.
 *
 * The guards added to fix-commitment-end-dates AFTER that run would have
 * refused three of the four rows it touched (UNCORROBORATED: an ANNUAL
 * subscription from 2026-04-15 implies 2027-04-15, not 2026-08-14). They were
 * added in response to chase Robertson, one correction too late for the
 * Bergens. This script exists because of that ordering.
 *
 * ── What it writes ──────────────────────────────────────────────────────────
 *
 * status → active, expiredAt → null, endDate → the date the purchase actually
 * bought, then recomputes the member. Nothing else. It does not touch money,
 * does not create subscriptions, and never invents a date: every restore below
 * is an explicit, owner-confirmed pair.
 */
import { prisma } from "../lib/prisma";
import { recomputeMemberStatus } from "../lib/memberStatus";
import { writeBillingAudit } from "../lib/billingAudit";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const li = argv.indexOf("--members");
const ALLOW = li >= 0 ? (argv[li + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean) : [];

/**
 * Owner-confirmed, 2026-08-25. Each entry names the subscription explicitly and
 * states WHY the date is right, so the next reader does not have to reconstruct
 * it. Nothing is derived here — a derived date is what caused this.
 */
const RESTORE: Array<{
  memberId: string;
  name: string;
  subscriptionId: string;
  expectStart: string;
  endDate: string;
  because: string;
}> = [
  {
    memberId: "cmr7b5zpl00v29il7cl8nafnd",
    name: "Riley Bergen",
    subscriptionId: "cmrmlnjtj0001fzzs6t2auac2",
    expectStart: "2026-04-15",
    endDate: "2027-04-15",
    because: "$750 cash for a YEAR (sibling discount), ANNUAL row starting 2026-04-15.",
  },
  {
    memberId: "cmr7b5zpm00v69il79cojz5g0",
    name: "Adelynn Bergen",
    subscriptionId: "cmrmll6sm00019f28x7hg5onh",
    expectStart: "2026-07-15",
    endDate: "2027-07-15",
    because: "$750 cash for a YEAR (sibling discount), ANNUAL row starting 2026-07-15.",
  },
];

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "—");

async function main() {
  if (APPLY && ALLOW.length === 0) {
    console.error('Refusing: --apply requires --members "Name"[,"Name"]. No all-mode.');
    process.exit(1);
  }

  let selected = 0;
  for (const r of RESTORE) {
    const inScope = ALLOW.length === 0 || ALLOW.some((a) => a.toLowerCase() === r.name.toLowerCase());

    const sub = await prisma.memberSubscription.findFirst({
      where: { id: r.subscriptionId, memberId: r.memberId },
      select: {
        id: true, status: true, expiredAt: true, canceledAt: true, endDate: true,
        startDate: true, price: true, billingPeriod: true, optionLabel: true,
        member: { select: { firstName: true, lastName: true, status: true, clubId: true } },
      },
    });

    console.log(`${inScope ? "▶" : " "} ${r.name}  (${r.memberId})`);
    if (!sub) {
      console.error(`    ✗ subscription ${r.subscriptionId} not found. Refusing.`);
      process.exitCode = 1; console.log(""); continue;
    }

    console.log(`    ${sub.optionLabel} · $${sub.price} ${sub.billingPeriod} · sub ${sub.status} · member ${sub.member.status}`);
    console.log(`    started ${day(sub.startDate)} · endDate ${day(sub.endDate)} · expiredAt ${day(sub.expiredAt)}`);
    console.log(`    → status active · endDate ${r.endDate} · expiredAt cleared`);
    console.log(`    because: ${r.because}`);

    // Refuse if the row is not the one described. A start date that disagrees
    // means the purchase is not what this entry assumes, and restoring to a
    // year from the wrong start would repeat the original mistake in reverse.
    const problems: string[] = [];
    if (day(sub.startDate) !== r.expectStart) {
      problems.push(`startDate is ${day(sub.startDate)}, expected ${r.expectStart}`);
    }
    if (sub.status !== "expired") {
      problems.push(`status is "${sub.status}", not "expired" — this may already have been handled`);
    }
    if (sub.canceledAt) {
      problems.push(`canceledAt is set (${day(sub.canceledAt)}) — this was CANCELED, not expired by the sweep`);
    }
    if (problems.length) {
      for (const p of problems) console.error(`    ✗ ${p}`);
      console.error(`    → NOT restored.`);
      process.exitCode = 1; console.log(""); continue;
    }

    if (inScope) selected++;
    if (!inScope) { console.log(`    (not in --members, skipped)`); console.log(""); continue; }
    if (!APPLY) { console.log(""); continue; }

    const endDate = new Date(`${r.endDate}T00:00:00.000Z`);
    await prisma.memberSubscription.update({
      where: { id: sub.id },
      data: { status: "active", expiredAt: null, endDate },
    });
    await recomputeMemberStatus(r.memberId, sub.member.clubId);

    await writeBillingAudit({
      clubId: sub.member.clubId,
      memberId: r.memberId,
      actorUserId: null,
      action: "SUBSCRIPTION_EXPIRY_REVERSED",
      before: { subscriptionId: sub.id, status: sub.status, endDate: day(sub.endDate), expiredAt: sub.expiredAt?.toISOString() ?? null },
      after: { subscriptionId: sub.id, status: "active", endDate: r.endDate, expiredAt: null },
      note:
        `Expiry reversed. scripts/fix-commitment-end-dates.ts copied ` +
        `Member.commitmentEndDate (${day(sub.endDate)}) onto endDate and expired this row, but that ` +
        `date was billingAnchorDate + 30 days — a one-month commitment length from migration setup, ` +
        `not what was bought. ${r.because}`,
    });

    const after = await prisma.memberSubscription.findUnique({
      where: { id: sub.id },
      select: { status: true, endDate: true, expiredAt: true },
    });
    const mAfter = await prisma.member.findUnique({
      where: { id: r.memberId }, select: { status: true },
    });
    const ok = after?.status === "active" && after?.expiredAt === null &&
               day(after?.endDate ?? null) === r.endDate;
    console.log(`    ${ok ? "RESTORED" : "✗ DID NOT TAKE"} — sub ${after?.status}, ends ${day(after?.endDate ?? null)}, member ${sub.member.status} → ${mAfter?.status}`);
    if (!ok) process.exitCode = 1;
    console.log("");
  }

  if (!APPLY) {
    console.log(`── DRY RUN ── nothing written. ${selected} in scope.`);
    console.log('Re-run with --apply --members "…".');
  } else {
    console.log("Done. No money row was touched.");
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
