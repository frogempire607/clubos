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
 *
 * ── When it REFUSES, and why the refusals are the point ─────────────────────
 *
 * `commitmentEndDate` lives on the MEMBER. A member can hold one membership
 * after another, so the field describes "the commitment", singular, for someone
 * who may have had several. Copying it onto a subscription is therefore only
 * valid when the two provably refer to the same thing, and this script's job is
 * as much to detect when they do NOT.
 *
 *   STALE      the date is at or before the subscription started, so it belongs
 *              to an EARLIER membership. chase Robertson's old membership ended
 *              2026-07-10; he bought a new one 2026-08-17. Applying would have
 *              expired a member who paid last week.
 *
 *   UNCORROBORATED  the date disagrees with what the subscription's own billing
 *              period implies. Kellan Lister is QUARTERLY from 2026-07-07 —
 *              a three-month term ends in October, and the field says
 *              2026-11-15. One of them is wrong and this script cannot tell
 *              which, so it writes neither.
 *
 *   CARD-BILLED  a local endDate does not stop Stripe. Writing one alone
 *              recreates exactly the divergence this script exists to close,
 *              only in the other direction: the app says ended, the card keeps
 *              being charged. Those need `cancel_at` set on the subscription
 *              first; see docs/improvement/stripe-autopay-verification.md.
 *
 * For a refused row where the operator KNOWS the right date, pass it explicitly:
 *
 *   --members "Kellan Lister" --end-date 2026-10-14 --apply
 *
 * which writes that date instead of the member-level one, through the same
 * audited path, and refuses to run against more than one member at a time.
 */
import { prisma } from "../lib/prisma";
import { expireEndedManualSubscriptions, recomputeMemberStatus } from "../lib/memberStatus";
import { writeBillingAudit } from "../lib/billingAudit";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const listIdx = argv.indexOf("--members");
const endIdx = argv.indexOf("--end-date");
const END_OVERRIDE = endIdx >= 0 ? argv[endIdx + 1] : null;
const ALLOW = listIdx >= 0 ? (argv[listIdx + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean) : [];

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "—");

async function main() {
  if (APPLY && ALLOW.length === 0) {
    console.error("Refusing: --apply requires --members <id|email|\"First Last\">,…");
    console.error("There is no all-mode. Name who you mean.");
    process.exit(1);
  }
  if (END_OVERRIDE && ALLOW.length !== 1) {
    console.error("Refusing: --end-date applies to exactly one member. Name them with --members.");
    process.exit(1);
  }
  if (END_OVERRIDE && Number.isNaN(Date.parse(`${END_OVERRIDE}T00:00:00.000Z`))) {
    console.error(`Refusing: --end-date "${END_OVERRIDE}" is not a YYYY-MM-DD date.`);
    process.exit(1);
  }
  const override = END_OVERRIDE ? new Date(`${END_OVERRIDE}T00:00:00.000Z`) : null;

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

  /**
   * Months a billing period covers, when the period IS the term. Only the
   * periods where that is unambiguous — a MONTHLY row's term depends on which
   * option was sold, which this script cannot see, so it corroborates nothing
   * and the check is skipped rather than guessed at.
   */
  const PERIOD_MONTHS: Record<string, number> = { QUARTERLY: 3, SEMI_ANNUAL: 6, ANNUAL: 12 };
  const addMonths = (d: Date, n: number) => {
    const out = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
    const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
    out.setUTCDate(Math.min(d.getUTCDate(), last));
    return out;
  };
  const DAY = 86_400_000;

  /** Every reason this row must not be written from the member-level field. */
  function refusalsFor(s: (typeof candidates)[number]): string[] {
    const out: string[] = [];
    const end = s.member.commitmentEndDate!;

    // STALE — the date predates the subscription, so it describes an EARLIER
    // membership. A member-level field cannot say WHICH membership it meant.
    if (s.startDate && end.getTime() <= s.startDate.getTime()) {
      out.push(
        `STALE — commitmentEndDate ${day(end)} is at or before this subscription started ` +
        `(${day(s.startDate)}), so it belongs to a membership that is already over. ` +
        `Writing it would expire a membership they are currently paying for.`,
      );
    }

    // UNCORROBORATED — the subscription's own period implies a different end.
    const months = PERIOD_MONTHS[(s.billingPeriod ?? "").toUpperCase()];
    if (months && s.startDate) {
      const implied = addMonths(s.startDate, months);
      const off = Math.round((end.getTime() - implied.getTime()) / DAY);
      if (Math.abs(off) > 7) {
        out.push(
          `UNCORROBORATED — ${s.billingPeriod} from ${day(s.startDate)} implies a term ending ` +
          `${day(implied)}, but commitmentEndDate says ${day(end)} (${off > 0 ? "+" : ""}${off} days). ` +
          `One of them is wrong and this script cannot tell which.`,
        );
      }
    }

    // CARD-BILLED — a local endDate does not stop Stripe.
    if (s.stripeSubscriptionId) {
      out.push(
        `CARD-BILLED (${s.stripeSubscriptionId}) — a local endDate does not stop Stripe. ` +
        `Writing one alone recreates the divergence in the other direction: the app says ended, ` +
        `the card keeps being charged. Set cancel_at on the subscription first.`,
      );
    }
    return out;
  }

  let selected = 0;
  let refusedInScope = 0;
  for (const s of candidates) {
    const m = s.member;
    const inScope = matches(m);
    const end = override && inScope ? override : m.commitmentEndDate!;
    const past = end.getTime() < now.getTime();
    // An explicit --end-date IS the operator overriding these judgements, which
    // is the point of the flag — but the reasons are still printed, so nobody
    // overrides one they had not read.
    const refusals = override && inScope ? [] : refusalsFor(s);

    console.log(`${inScope ? (refusals.length ? "✗" : "▶") : " "} ${m.firstName} ${m.lastName}  (${m.id})`);
    console.log(`    ${s.optionLabel} · $${s.price} ${s.billingPeriod} · ${s.billingType} · sub ${s.status}`);
    console.log(`    started ${day(s.startDate)} · commitmentEndDate ${day(m.commitmentEndDate!)}`);
    if (override && inScope) {
      console.log(`    endDate  null → ${day(end)}   ← FROM --end-date, not from the member row`);
      for (const r of refusalsFor(s)) console.log(`    (overridden) ${r}`);
    } else if (refusals.length) {
      for (const r of refusals) console.log(`    ✗ ${r}`);
      console.log(`    → NOT written.`);
    } else {
      console.log(`    endDate  null → ${day(end)}${past ? "  (already passed)" : ""}`);
      if (past) console.log(`    then: expire the row and recompute the member (currently ${m.status})`);
    }
    if (!inScope) console.log(`    (not in --members, skipped)`);
    console.log("");
    if (inScope && refusals.length) refusedInScope++;
    else if (inScope) selected++;
  }

  if (refusedInScope > 0) {
    console.log(`${refusedInScope} row(s) you named were refused — see the ✗ lines. ` +
      `Fix the cause, or pass --end-date for one member at a time.\n`);
  }

  if (!APPLY) {
    console.log(`── DRY RUN ── nothing written. ${selected} in scope.`);
    console.log("Re-run with --apply --members \"…\" to write.");
    return;
  }

  for (const s of candidates) {
    if (!matches(s.member)) continue;
    if (!override && refusalsFor(s).length) continue;   // already explained above
    const m = s.member;
    const end = override ?? m.commitmentEndDate!;

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
      note: override
        ? `endDate set to ${day(end)} explicitly via --end-date (the member-level ` +
          `commitmentEndDate ${day(m.commitmentEndDate!)} did not describe this subscription).`
        : "endDate copied from Member.commitmentEndDate by scripts/fix-commitment-end-dates.ts — " +
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
