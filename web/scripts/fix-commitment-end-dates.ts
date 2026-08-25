/**
 * Give a subscription the end date the club already recorded on the member.
 *
 * DRY RUN BY DEFAULT. `--apply` requires an explicit `--members` allowlist.
 *
 *   npx tsx scripts/fix-commitment-end-dates.ts
 *   npx tsx scripts/fix-commitment-end-dates.ts --members "Max Hall"
 *   npx tsx scripts/fix-commitment-end-dates.ts --apply --members "Max Hall"
 *   npx tsx scripts/fix-commitment-end-dates.ts --apply --members "Max Hall,Riley Bergen"
 *
 * `--members` accepts member ids, emails, or "First Last" (case-insensitive).
 *
 * ── What went wrong ─────────────────────────────────────────────────────────
 *
 * `Member.commitmentEndDate` says when a commitment ends.
 * `MemberSubscription.endDate` is what actually stops the membership —
 * `expireEndedManualSubscriptions` filters on `endDate: { lt: now }`, so a NULL
 * endDate is invisible to it and the row stays active forever.
 *
 * The offline branch of migration-approve never copied one to the other (fixed
 * 2026-08-25, same batch as this script). A member whose plan defaulted to
 * auto-renew got no endDate at all, so four families are being carried as
 * active months past a commitment the club itself recorded as ended — and the
 * portal tells them they still have a live membership, which is how Shannan
 * Hall was blocked from buying Max a new one.
 *
 * ── What this writes ────────────────────────────────────────────────────────
 *
 * `endDate = Member.commitmentEndDate`, and NOTHING else — only where endDate
 * is currently null. It never overwrites an existing end date, never invents
 * one for a member who has no commitment recorded, and never touches Stripe.
 *
 * When the date has already passed it then expires the row and recomputes the
 * member, because stamping a past end date and leaving the row "active" would
 * fix the data and none of the symptoms.
 */
import { prisma } from "../lib/prisma";
import { expireEndedManualSubscriptions, recomputeMemberStatus } from "../lib/memberStatus";
import { writeBillingAudit } from "../lib/billingAudit";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const listIdx = argv.indexOf("--members");
const ALLOW = listIdx >= 0 ? (argv[listIdx + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean) : [];

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "—");

async function main() {
  if (APPLY && ALLOW.length === 0) {
    console.error("Refusing: --apply requires --members <id|email|\"First Last\">,…");
    console.error("There is no all-mode. Name who you mean.");
    process.exit(1);
  }

  const candidates = await prisma.memberSubscription.findMany({
    where: {
      status: { in: ["active", "past_due"] },
      endDate: null,
      member: { deletedAt: null, commitmentEndDate: { not: null } },
    },
    select: {
      id: true, memberId: true, optionLabel: true, price: true, billingPeriod: true,
      billingType: true, status: true, startDate: true, autoRenew: true,
      stripeSubscriptionId: true,
      member: {
        select: {
          id: true, firstName: true, lastName: true, email: true, clubId: true,
          commitmentEndDate: true, status: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  if (candidates.length === 0) {
    console.log("Nothing to correct: no active subscription has a null endDate beside a recorded commitment.");
    return;
  }

  const matches = (m: (typeof candidates)[number]["member"]) => {
    if (ALLOW.length === 0) return true;
    const name = `${m.firstName} ${m.lastName}`.trim().toLowerCase();
    return ALLOW.some((a) => {
      const t = a.toLowerCase();
      return t === m.id || t === (m.email ?? "").toLowerCase() || t === name;
    });
  };

  const now = new Date();
  console.log(`${candidates.length} subscription(s) with a recorded commitment and no end date.\n`);

  let selected = 0;
  for (const s of candidates) {
    const m = s.member;
    const inScope = matches(m);
    const end = m.commitmentEndDate!;
    const past = end.getTime() < now.getTime();

    console.log(`${inScope ? "▶" : " "} ${m.firstName} ${m.lastName}  (${m.id})`);
    console.log(`    ${s.optionLabel} · $${s.price} ${s.billingPeriod} · ${s.billingType} · sub ${s.status}`);
    console.log(`    started ${day(s.startDate)} · commitmentEndDate ${day(end)}${past ? "  ← ALREADY PASSED" : ""}`);
    console.log(`    endDate  null → ${day(end)}`);
    if (s.stripeSubscriptionId) {
      // Loud, because it changes what the correction means: Stripe keeps
      // billing on its own schedule regardless of a local end date.
      console.log(`    ! CARD-BILLED (${s.stripeSubscriptionId}) — this writes the LOCAL date only.`);
      console.log(`      Stripe will keep charging until someone sets cancel_at. Handle that separately.`);
    }
    if (past) {
      console.log(`    then: expire the row and recompute the member (currently ${m.status})`);
    }
    if (!inScope) console.log(`    (not in --members, skipped)`);
    console.log("");
    if (inScope) selected++;
  }

  if (!APPLY) {
    console.log(`── DRY RUN ── nothing written. ${selected} in scope.`);
    console.log("Re-run with --apply --members \"…\" to write.");
    return;
  }

  for (const s of candidates) {
    if (!matches(s.member)) continue;
    const m = s.member;
    const end = m.commitmentEndDate!;

    await prisma.memberSubscription.update({
      where: { id: s.id },
      data: { endDate: end },
    });
    await writeBillingAudit({
      clubId: m.clubId,
      memberId: m.id,
      actorUserId: null,
      action: "SUBSCRIPTION_END_DATE_BACKFILLED",
      before: { subscriptionId: s.id, endDate: null },
      after: { subscriptionId: s.id, endDate: end.toISOString() },
      note:
        "endDate copied from Member.commitmentEndDate by scripts/fix-commitment-end-dates.ts — " +
        "the offline approve branch never recorded it, so nothing could expire the row.",
    });

    // Stamping a past date and leaving the row active fixes the column and none
    // of the symptoms, so finish the job.
    let expired = 0;
    if (end.getTime() < now.getTime()) {
      expired = await expireEndedManualSubscriptions(m.clubId, [m.id]);
      await recomputeMemberStatus(m.id, m.clubId);
    }

    const after = await prisma.memberSubscription.findUnique({
      where: { id: s.id },
      select: { endDate: true, status: true, expiredAt: true },
    });
    const memberAfter = await prisma.member.findUnique({
      where: { id: m.id }, select: { status: true },
    });

    const ok = after?.endDate?.getTime() === end.getTime();
    console.log(`${m.firstName} ${m.lastName}: endDate ${day(after?.endDate ?? null)} ${ok ? "✓" : "✗ DID NOT TAKE"}` +
      ` · sub ${after?.status} · member ${m.status} → ${memberAfter?.status}` +
      (expired ? ` · expired ${expired}` : ""));
    if (!ok) process.exitCode = 1;
  }
  console.log("\nDone. No Stripe object was touched.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
