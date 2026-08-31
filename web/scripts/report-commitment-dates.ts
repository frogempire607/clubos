/**
 * What every commitmentEndDate claims, versus what the member actually bought.
 *
 * REPORT ONLY. This script has no --apply and never will; it exists because
 * acting on these dates by arithmetic is what expired Riley and Adelynn Bergen.
 *
 *   npx tsx scripts/report-commitment-dates.ts
 *   npx tsx scripts/report-commitment-dates.ts --all     # include anchor−1 rows
 *
 * ── Why "disagrees with the option term" is NOT the finding ─────────────────
 *
 * An option's `contractMonths` is a MINIMUM TERM — the floor a purchase commits
 * to. `Member.commitmentEndDate` is something else: the date a specific deal was
 * agreed to run until. A member on a 1-month option can genuinely have a
 * 4-month commitment, and Joseph Bower and Orson Chorba both do.
 *
 * So arithmetic disagreement is not evidence of error, and a report that
 * presented it as such would invite exactly the overwrite that caused this.
 * What IS evidence:
 *
 *   STALE               the date is at or before this subscription STARTED, so
 *                       it describes a membership that is already over. Max
 *                       Hall carries 2026-08-15 from a plan he left; his
 *                       current one started 2026-08-27.
 *
 *   SHORT_OF_PAID_TERM  the date falls INSIDE a term the billing period itself
 *                       corroborates. An ANNUAL subscription from 2026-04-15
 *                       runs to 2027-04-15; a field saying 2026-08-14 claims
 *                       the membership ended eight months before the year they
 *                       paid for. This is the Bergen shape, and it is the only
 *                       category that can strand a paid-up member.
 *
 *   LONGER_THAN_TERM    the date runs PAST the option's minimum term. Usually a
 *                       real arrangement — a 3- or 4-month deal on a monthly
 *                       plan. Listed so it can be recognised, never corrected.
 *
 *   AGREES / UNKNOWABLE  within a week of the implied term, or no term can be
 *                       derived (a MONTHLY option states a 1-month floor that
 *                       says nothing about the deal; ONE_TIME says nothing at
 *                       all). Unknowable is reported as unknowable.
 */
import { prisma } from "../lib/prisma";
import { parseOptions } from "../lib/membershipOptions";
import { addUTCMonths } from "../lib/billingAdmin";

const ALL = process.argv.slice(2).includes("--all");

/** Months a billing period corroborates on its own. MONTHLY corroborates nothing. */
const PERIOD_MONTHS: Record<string, number> = { QUARTERLY: 3, SEMI_ANNUAL: 6, ANNUAL: 12 };
const DAY = 86_400_000;
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "—");
const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));

type Verdict =
  | "STALE" | "SHORT_OF_PAID_TERM" | "LONGER_THAN_TERM" | "AGREES" | "UNKNOWABLE" | "NO_SUBSCRIPTION";

async function main() {
  const members = await prisma.member.findMany({
    where: { deletedAt: null, commitmentEndDate: { not: null } },
    select: {
      id: true, firstName: true, lastName: true, status: true,
      commitmentEndDate: true, billingAnchorDate: true,
      subscriptions: {
        orderBy: { createdAt: "desc" },
        take: 1,
        where: { status: { in: ["active", "past_due", "pending", "expired"] } },
        select: {
          id: true, status: true, optionId: true, optionLabel: true, price: true,
          billingPeriod: true, billingType: true, startDate: true, endDate: true,
          membership: { select: { name: true, options: true, contractMonths: true } },
        },
      },
    },
  });

  const rows: Array<{
    who: string; verdict: Verdict; detail: string;
    field: string; implied: string; offset: string; plan: string;
  }> = [];

  for (const m of members) {
    const who = `${m.firstName} ${m.lastName}`.trim();
    const field = m.commitmentEndDate!;
    const anchorOffset = m.billingAnchorDate
      ? Math.round((field.getTime() - m.billingAnchorDate.getTime()) / DAY)
      : null;

    // anchor − 1 is the end of the CURRENT period, a different and coherent
    // meaning. Skipped unless --all, so the list stays the ones worth reading.
    if (!ALL && anchorOffset === -1) continue;

    const sub = m.subscriptions[0];
    if (!sub) {
      rows.push({
        who, verdict: "NO_SUBSCRIPTION",
        detail: "no live or expired subscription — the date describes nothing",
        field: day(field), implied: "—",
        offset: anchorOffset == null ? "—" : `anchor${anchorOffset >= 0 ? "+" : ""}${anchorOffset}`,
        plan: "—",
      });
      continue;
    }

    const opts = parseOptions(sub.membership.options);
    const optTerm = opts.find((o) => o.id === sub.optionId)?.contractMonths
      ?? sub.membership.contractMonths ?? null;
    const periodTerm = PERIOD_MONTHS[(sub.billingPeriod ?? "").toUpperCase()] ?? null;
    const start = sub.startDate;

    const plan = `${sub.membership.name} · ${sub.optionLabel} $${sub.price} ${sub.billingPeriod}`;
    const offset = anchorOffset == null ? "—" : `anchor${anchorOffset >= 0 ? "+" : ""}${anchorOffset}`;

    if (!start) {
      rows.push({ who, verdict: "UNKNOWABLE", detail: "subscription has no start date",
                  field: day(field), implied: "—", offset, plan });
      continue;
    }

    // STALE first: a date at or before the start describes an earlier membership
    // no matter what any term says.
    if (field.getTime() <= start.getTime()) {
      rows.push({
        who, verdict: "STALE",
        detail: `subscription started ${day(start)} — the date predates it`,
        field: day(field), implied: "—", offset, plan,
      });
      continue;
    }

    // The period is the only self-corroborating term. An option's contractMonths
    // is a floor and cannot show the field too SHORT.
    if (periodTerm) {
      const paidTo = addUTCMonths(start, periodTerm);
      if (field.getTime() < paidTo.getTime() - 7 * DAY) {
        rows.push({
          who, verdict: "SHORT_OF_PAID_TERM",
          detail: `${sub.billingPeriod} from ${day(start)} runs to ${day(paidTo)} — the field ends it ` +
                  `${Math.round((paidTo.getTime() - field.getTime()) / DAY)} days early`,
          field: day(field), implied: day(paidTo), offset, plan,
        });
        continue;
      }
      const off = Math.round((field.getTime() - paidTo.getTime()) / DAY);
      rows.push({
        who, verdict: Math.abs(off) <= 7 ? "AGREES" : "LONGER_THAN_TERM",
        detail: Math.abs(off) <= 7 ? "matches the period the money bought"
          : `runs ${off} days past the ${periodTerm}-month period — likely an agreed deal`,
        field: day(field), implied: day(paidTo), offset, plan,
      });
      continue;
    }

    if (optTerm == null) {
      rows.push({ who, verdict: "UNKNOWABLE",
                  detail: "monthly billing and no stated term — nothing to compare against",
                  field: day(field), implied: "—", offset, plan });
      continue;
    }

    const floor = addUTCMonths(start, optTerm);
    const off = Math.round((field.getTime() - floor.getTime()) / DAY);
    rows.push({
      who,
      verdict: Math.abs(off) <= 7 ? "AGREES" : off > 0 ? "LONGER_THAN_TERM" : "UNKNOWABLE",
      detail: Math.abs(off) <= 7
        ? `matches the option's ${optTerm}-month minimum`
        : off > 0
          ? `runs ${off} days past the option's ${optTerm}-month minimum — likely an agreed deal`
          : `shorter than the option's ${optTerm}-month minimum, but a minimum cannot prove this wrong`,
      field: day(field), implied: day(floor), offset, plan,
    });
  }

  const ORDER: Verdict[] = ["SHORT_OF_PAID_TERM", "STALE", "NO_SUBSCRIPTION", "LONGER_THAN_TERM", "UNKNOWABLE", "AGREES"];
  const HEAD: Record<Verdict, string> = {
    SHORT_OF_PAID_TERM: "✗ ENDS INSIDE A TERM THEY PAID FOR — these can strand a paid-up member",
    STALE:              "✗ DESCRIBES AN EARLIER MEMBERSHIP — the date predates the current subscription",
    NO_SUBSCRIPTION:    "· NO SUBSCRIPTION — the date describes nothing",
    LONGER_THAN_TERM:   "· LONGER THAN THE TERM — probably a real deal. Do not correct from this report.",
    UNKNOWABLE:         "· UNKNOWABLE — no term can be derived. Your records, not the database.",
    AGREES:             "✓ AGREES",
  };

  console.log(`${rows.length} member(s) whose commitmentEndDate is worth reading` +
              (ALL ? "" : " (anchor−1 rows excluded; --all to include)") + "\n");
  for (const v of ORDER) {
    const set = rows.filter((r) => r.verdict === v);
    if (!set.length) continue;
    console.log(HEAD[v]);
    for (const r of set) {
      console.log(`   ${pad(r.who, 22)} field ${r.field}  implies ${pad(r.implied, 12)} ${pad(r.offset, 12)}`);
      console.log(`   ${" ".repeat(22)} ${r.plan}`);
      console.log(`   ${" ".repeat(22)} ${r.detail}`);
    }
    console.log("");
  }
  console.log("REPORT ONLY — nothing was written, and this script has no --apply.");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
