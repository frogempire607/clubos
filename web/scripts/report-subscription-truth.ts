/**
 * Every place a MEMBER-level field is answering a SUBSCRIPTION-level question.
 *
 * REPORT ONLY. No `--apply`, and there will never be one. Four production bugs
 * in one week were all this shape, and every one of them was found by accident
 * — somebody noticed a number looked odd. This is the check that does not need
 * anyone to notice.
 *
 *   npx tsx scripts/report-subscription-truth.ts
 *   npx tsx scripts/report-subscription-truth.ts --all   # include AGREES rows
 *
 * ── What it checks, and which bug each one is ───────────────────────────────
 *
 *   PLAN POINTER      `Member.membershipId` against the subscriptions actually
 *                     held. Girls Only read 0 members with two women on it;
 *                     Girls Jr Frogs read 2 on the strength of pointers left by
 *                     memberships that had ended.
 *
 *   COMMITMENT DATE   `Member.commitmentEndDate` against the subscription it
 *                     would be describing. chase Robertson's new purchase
 *                     inherited a dead date from a membership he had left.
 *
 *   NEXT BILLING      whether a live subscription can say when it next bills
 *                     from its OWN fields. Joseph Bower's profile read "next
 *                     billing 7/31/2026" — a date in the past — because the
 *                     surface fell through to `Member.billingAnchorDate`, a
 *                     one-time migration input that nothing advances.
 *
 *   MONEY PATH        subscriptions whose payer is not the member who holds
 *                     them. Reconciling invoices to payments THROUGH `memberId`
 *                     reported a $545.37 hole that did not exist: the
 *                     subscription had been transferred from Michael Lister to
 *                     Kellan, so the money and the subscription sat on
 *                     different members. Both records were correct.
 *
 * ── Why a finding is not automatically an error ─────────────────────────────
 *
 * `commitmentEndDate` and `billingAnchorDate` are the only record of what the
 * club believed at import time, and that history is worth keeping. A row listed
 * here is a place where a member-level field DISAGREES with the subscription,
 * or where nothing but a member-level field is left to answer with. Which of
 * the two is right is a question about the club's records, not the database's.
 *
 * So this prints what each source says and names the risk. It never proposes a
 * value. Acting on these dates by arithmetic is what expired Riley and Adelynn
 * Bergen; see scripts/fix-commitment-end-dates.ts for the refusal categories a
 * correction script has to carry.
 */
import { prisma } from "../lib/prisma";
import { HOLDS_MEMBERSHIP_STATUSES } from "../lib/membersQuery";

const ALL = process.argv.slice(2).includes("--all");

const DAY = 86_400_000;
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "—");
/**
 * Pad to a column width, NEVER truncate. A long name jogs the column; a sliced
 * one loses information silently, which is exactly what the warning box did
 * before it was fixed.
 */
const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const NOW = new Date();

/** Months a billing period corroborates on its own. MONTHLY corroborates nothing. */
const PERIOD_MONTHS: Record<string, number> = { QUARTERLY: 3, SEMI_ANNUAL: 6, ANNUAL: 12 };

type Finding = { severity: "RISK" | "NOTE" | "OK"; who: string; detail: string[] };

const line = (s = "") => console.log(s);
function section(title: string, blurb: string, findings: Finding[]) {
  const risks = findings.filter((f) => f.severity === "RISK");
  const notes = findings.filter((f) => f.severity === "NOTE");
  const ok = findings.filter((f) => f.severity === "OK");

  line();
  line("━".repeat(78));
  line(title);
  line("━".repeat(78));
  line(blurb);
  line();

  if (risks.length) {
    line(`✗ ${risks.length} row(s) where the member-level field would give a wrong answer:`);
    for (const f of risks) {
      line(`   ${pad(f.who, 24)} ${f.detail[0]}`);
      for (const d of f.detail.slice(1)) line(`   ${" ".repeat(24)} ${d}`);
    }
    line();
  }
  if (notes.length) {
    line(`· ${notes.length} row(s) worth knowing about, not necessarily wrong:`);
    for (const f of notes) {
      line(`   ${pad(f.who, 24)} ${f.detail[0]}`);
      for (const d of f.detail.slice(1)) line(`   ${" ".repeat(24)} ${d}`);
    }
    line();
  }
  if (!risks.length && !notes.length) line("✓ nothing to report");
  if (ALL && ok.length) {
    line(`✓ ${ok.length} agreeing row(s):`);
    for (const f of ok) line(`   ${pad(f.who, 24)} ${f.detail[0]}`);
    line();
  } else if (ok.length) {
    line(`✓ ${ok.length} row(s) agree (--all to list them)`);
  }
  return risks.length;
}

async function main() {
  const members = await prisma.member.findMany({
    where: { deletedAt: null, isHistoricalOnly: false },
    select: {
      id: true, firstName: true, lastName: true,
      membershipId: true, commitmentEndDate: true, billingAnchorDate: true,
      userId: true,
      membership: { select: { name: true } },
      subscriptions: {
        select: {
          id: true, membershipId: true, status: true, optionLabel: true,
          startDate: true, endDate: true, billingPeriod: true, billingType: true,
          minimumTermEndsAt: true, currentPeriodEnd: true, paidThroughDate: true,
          payerUserId: true, stripeSubscriptionId: true, autoRenew: true,
          membership: { select: { name: true } },
        },
      },
    },
  });

  const HOLDS: string[] = [...HOLDS_MEMBERSHIP_STATUSES];
  const nameOf = (m: (typeof members)[number]) => `${m.firstName} ${m.lastName}`.trim();
  let totalRisks = 0;

  // ══════════════════════════════════════════════════════════════════════════
  // 1. PLAN POINTER — Member.membershipId vs the subscriptions actually held
  // ══════════════════════════════════════════════════════════════════════════
  const pointer: Finding[] = [];
  for (const m of members) {
    const live = m.subscriptions.filter((s) => HOLDS.includes(s.status));
    const plans = new Set(live.map((s) => s.membershipId));
    const planNames = live.map((s) => s.membership?.name ?? s.membershipId).join(", ");

    if (!m.membershipId && live.length === 0) continue;

    if (m.membershipId && live.length === 0) {
      pointer.push({
        severity: "RISK", who: nameOf(m),
        detail: [
          `points at "${m.membership?.name ?? m.membershipId}" — holds NO live subscription`,
          "counted as a plan member by anything reading the pointer",
        ],
      });
    } else if (!m.membershipId && live.length > 0) {
      pointer.push({
        severity: "RISK", who: nameOf(m),
        detail: [
          `holds ${planNames} — pointer is NULL`,
          "invisible to anything reading the pointer instead of subscriptions",
        ],
      });
    } else if (m.membershipId && !plans.has(m.membershipId)) {
      pointer.push({
        severity: "RISK", who: nameOf(m),
        detail: [
          `points at "${m.membership?.name ?? m.membershipId}" — actually holds ${planNames}`,
          "counted on the wrong plan, and missing from the right one",
        ],
      });
    } else {
      pointer.push({ severity: "OK", who: nameOf(m), detail: [`pointer agrees (${planNames})`] });
    }
  }
  totalRisks += section(
    "1. PLAN POINTER — Member.membershipId",
    "Who is on this plan? lib/membersQuery.onPlanWhere() is the one definition and\n" +
      "reads subscriptions. Anything reading the pointer instead gets these rows wrong.",
    pointer,
  );

  // ══════════════════════════════════════════════════════════════════════════
  // 2. COMMITMENT DATE — Member.commitmentEndDate vs the subscription
  // ══════════════════════════════════════════════════════════════════════════
  const commitment: Finding[] = [];
  for (const m of members) {
    if (!m.commitmentEndDate) continue;
    const field = m.commitmentEndDate;
    const live = m.subscriptions.filter((s) => HOLDS.includes(s.status));

    if (live.length === 0) {
      commitment.push({
        severity: "NOTE", who: nameOf(m),
        detail: [`field says ${day(field)} — member holds no live subscription`,
                 "the date describes nothing current; history only"],
      });
      continue;
    }

    // The shape a single member-level date structurally cannot express.
    if (live.length > 1) {
      commitment.push({
        severity: "RISK", who: nameOf(m),
        detail: [
          `ONE field (${day(field)}) for ${live.length} live subscriptions`,
          ...live.map((s) => `  · ${s.membership?.name ?? "?"} "${s.optionLabel}" ` +
            `${s.billingPeriod ?? "?"} started ${day(s.startDate)} ends ${day(s.endDate)}`),
          "no single member-level date can describe all of them",
        ],
      });
      continue;
    }

    const s = live[0];
    const start = s.startDate;
    if (start && field.getTime() <= start.getTime()) {
      commitment.push({
        severity: "RISK", who: nameOf(m),
        detail: [
          `field ${day(field)} is at or before this subscription started (${day(start)})`,
          "describes a membership that is already over — chase Robertson's shape",
        ],
      });
      continue;
    }

    // Does the subscription's own record corroborate the date?
    if (s.endDate && Math.abs(s.endDate.getTime() - field.getTime()) > 2 * DAY) {
      const off = Math.round((field.getTime() - s.endDate.getTime()) / DAY);
      commitment.push({
        severity: "RISK", who: nameOf(m),
        detail: [
          `field ${day(field)} vs this subscription's own endDate ${day(s.endDate)} ` +
            `(${off > 0 ? "+" : ""}${off} days)`,
          "two records of the same fact that disagree; the subscription's is per-purchase",
        ],
      });
      continue;
    }

    if (!s.endDate && !s.minimumTermEndsAt) {
      const months = PERIOD_MONTHS[(s.billingPeriod ?? "").toUpperCase()];
      const implied = months && start ? new Date(Date.UTC(
        start.getUTCFullYear(), start.getUTCMonth() + months, start.getUTCDate(),
      )) : null;
      commitment.push({
        severity: "NOTE", who: nameOf(m),
        detail: [
          `field ${day(field)} is the only term on record — subscription carries neither ` +
            `endDate nor minimumTermEndsAt`,
          implied
            ? `its ${s.billingPeriod} period from ${day(start)} would imply ${day(implied)}`
            : `its ${s.billingPeriod ?? "unknown"} period implies nothing on its own`,
        ],
      });
      continue;
    }

    commitment.push({ severity: "OK", who: nameOf(m), detail: [`field ${day(field)} matches the subscription`] });
  }
  totalRisks += section(
    "2. COMMITMENT DATE — Member.commitmentEndDate",
    "A member can end one membership and buy another, or hold two at once. A single\n" +
      "member-level date cannot say which one it meant. Since 2026-09-03 nothing writes\n" +
      "this to Stripe — planNonRenewal reads the subscription's own endDate — so these\n" +
      "are reporting risk, not live exposure.",
    commitment,
  );

  // ══════════════════════════════════════════════════════════════════════════
  // 3. NEXT BILLING — can a live subscription answer from its own fields?
  // ══════════════════════════════════════════════════════════════════════════
  const billing: Finding[] = [];
  let silentCount = 0;
  for (const m of members) {
    for (const s of m.subscriptions.filter((x) => HOLDS.includes(x.status))) {
      const who = `${nameOf(m)}`;
      const canAnswer = s.currentPeriodEnd ?? s.paidThroughDate ?? null;
      if (canAnswer) {
        const stale = canAnswer.getTime() < NOW.getTime();
        if (stale) {
          billing.push({
            severity: "RISK", who,
            detail: [
              `subscription's own period end ${day(canAnswer)} is in the PAST`,
              s.stripeSubscriptionId
                ? "linked to Stripe — the reconciler has not refreshed this row"
                : "offline row — paidThroughDate was never advanced after a payment",
            ],
          });
        } else {
          billing.push({ severity: "OK", who, detail: [`answers from its own fields (${day(canAnswer)})`] });
        }
        continue;
      }
      silentCount++;
      billing.push({
        severity: "NOTE", who,
        detail: [
          `cannot say when it next bills — currentPeriodEnd and paidThroughDate both null`,
          m.billingAnchorDate
            ? `Member.billingAnchorDate says ${day(m.billingAnchorDate)}` +
              `${m.billingAnchorDate.getTime() < NOW.getTime() ? " — IN THE PAST" : ""}, ` +
              `and it is NOT the answer (see the warning below)`
            : "no member-level anchor either — genuinely unknown",
        ],
      });
    }
  }
  totalRisks += section(
    "3. NEXT BILLING — can the subscription answer for itself?",
    "A subscription answers this from currentPeriodEnd (Stripe rows, mirrored by\n" +
      "lib/stripeSync) or paidThroughDate (offline rows, advanced on payment).",
    billing,
  );

  // ── The warning that has to be impossible to miss ────────────────────────
  if (silentCount > 0) {
    // Word-wrapped, not sliced. An earlier cut of this box padded each line to a
    // fixed width with a truncating pad(), which chopped the warning off
    // mid-sentence — "…falling back to Member.billingAnchorDate — IS THE". A
    // warning that cannot be read is worse than no warning, because the box
    // still looks like it said something.
    const W = 74;
    const wrap = (text: string): string[] => {
      if (!text) return [""];
      const out: string[] = [];
      let cur = "";
      for (const word of text.split(" ")) {
        if (cur && (cur + " " + word).length > W) { out.push(cur); cur = word; }
        else cur = cur ? cur + " " + word : word;
      }
      if (cur) out.push(cur);
      return out;
    };
    const boxed = (text: string) =>
      wrap(text).forEach((l) => line("│ " + l + " ".repeat(W - l.length) + " │"));

    line();
    line("┌" + "─".repeat(W + 2) + "┐");
    boxed("READ THIS BEFORE 'FIXING' THE BLANK NEXT-BILLING DATES");
    line("├" + "─".repeat(W + 2) + "┤");
    const paragraphs = [
      `${silentCount} live subscription(s) above cannot say when they next bill. On a ` +
        "member's profile that renders as a blank where a date belongs, and the " +
        "obvious-looking repair — falling back to Member.billingAnchorDate — IS THE BUG.",
      "",
      "billingAnchorDate is a ONE-TIME MIGRATION INPUT. It was the date the club said " +
        "billing should resume at import, it is written once, and NOTHING ADVANCES IT. " +
        "Joseph Bower was charged on 2026-07-30 and his profile kept saying \"next " +
        "billing 7/31/2026\" — a date in the past — because a surface reached for it. " +
        "Max Hall's card read \"Next billing July 15, 2026\" in late August and his " +
        "mother reasonably concluded the membership had lapsed.",
      "",
      "app/api/member/billing/route.ts already made this mistake and was fixed. It now " +
        "shows NOTHING rather than a wrong date, which is why the blank exists. The " +
        "blank is the honest answer and it is deliberate. Do not close it by reading " +
        "the member row.",
      "",
      "The real repair is to populate the SUBSCRIPTION's own fields:",
      "· Stripe rows: lib/stripeSync.ts mirrors currentPeriodEnd from Stripe",
      "· Offline rows: paidThroughDate advances when a payment is recorded",
      "",
      "Until then a blank is correct. A wrong date is not.",
    ];
    for (const para of paragraphs) boxed(para);
    line("└" + "─".repeat(W + 2) + "┘");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 4. MONEY PATH — where money and subscription sit on different members
  // ══════════════════════════════════════════════════════════════════════════
  const money: Finding[] = [];
  const transfers = await prisma.membershipTransfer.count();
  const dupInvoices = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM (
      SELECT "stripeInvoiceId" FROM transactions
      WHERE "stripeInvoiceId" IS NOT NULL
      GROUP BY "stripeInvoiceId" HAVING count(*) > 1
    ) d`;

  for (const m of members) {
    for (const s of m.subscriptions.filter((x) => HOLDS.includes(x.status))) {
      if (!s.payerUserId) continue;
      if (m.userId && s.payerUserId === m.userId) continue;
      money.push({
        severity: "NOTE", who: nameOf(m),
        detail: [
          `holds "${s.membership?.name ?? "?"}" but the payer is a DIFFERENT user`,
          "reconciling this member's money through Transaction.memberId will find a hole",
          "that is not there — match on Transaction.stripeInvoiceId instead",
        ],
      });
    }
  }
  totalRisks += section(
    "4. MONEY PATH — payer vs beneficiary",
    `${transfers} membership transfer(s) on record. A transfer moves the subscription's\n` +
      "memberId and stamps payerUserId so the payer stays put — by design. The money\n" +
      "stays on whoever actually paid it, which is also correct, and the two then sit on\n" +
      "different members. Reconcile on Transaction.stripeInvoiceId, never through a\n" +
      "member, which is deliberately movable.",
    money,
  );

  const dupes = Number(dupInvoices[0]?.n ?? 0);
  line(dupes === 0
    ? "   ✓ every stripeInvoiceId appears on exactly one transaction — the immutable key holds"
    : `   ✗ ${dupes} stripeInvoiceId(s) appear on more than one transaction — dedupe is app-side ` +
      "and something got through");
  if (dupes > 0) totalRisks++;

  // ══════════════════════════════════════════════════════════════════════════
  line();
  line("━".repeat(78));
  line(totalRisks === 0
    ? "✓ no member-level field is currently giving a wrong subscription-level answer."
    : `✗ ${totalRisks} row(s) where a member-level field disagrees with the subscription.`);
  line();
  line("REPORT ONLY — nothing was written, and this script has no --apply. Corrections");
  line("go in their own dry-run script that refuses rather than guesses; see");
  line("scripts/fix-commitment-end-dates.ts for the STALE / UNCORROBORATED / CARD-BILLED");
  line("refusals a script touching these dates has to carry.");
  line();
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
