/**
 * Stripe cancel_at audit — READ ONLY. Writes NOTHING.
 *
 * Answers one question: for every live Stripe-billed MemberSubscription, does
 * Stripe actually hold a `cancel_at` / `cancel_at_period_end`, and does it
 * agree with the local `endDate`?
 *
 * WHY THIS EXISTS
 * ---------------
 * `/api/members/migration/[id]/approve` passes `cancel_at` to Stripe from
 * `Member.requestedCancellationDate ?? Member.commitmentEndDate`, and writes
 * the same value to `MemberSubscription.endDate`. Twelve live subscriptions
 * carry such an endDate; eleven of them ALSO carry `autoRenew: true`, which
 * is self-contradictory, and `stripeSnapshot` is empty on all but one so the
 * database cannot say which side is true.
 *
 * If Stripe holds those dates, those memberships terminate on their own.
 *
 * SAFETY
 * ------
 *   - Only `stripe.subscriptions.retrieve` is called. No create, no update,
 *     no cancel, no delete. There is no --apply flag because there is nothing
 *     to apply.
 *   - No DB writes. Prisma is used with findMany/select only.
 *   - Runs against the club's CONNECTED account (`{ stripeAccount }`), which
 *     is where member subscriptions live.
 *   - A retrieve failure is reported per row and never aborts the run.
 *
 * Usage (from web/):
 *   npx tsx scripts/audit-stripe-cancel-at.ts
 *   npx tsx scripts/audit-stripe-cancel-at.ts --club <clubId>
 *   npx tsx scripts/audit-stripe-cancel-at.ts --csv
 */
import { prisma } from "../lib/prisma";
import { stripe } from "../lib/stripe";

const CSV = process.argv.includes("--csv");
const clubArgIdx = process.argv.indexOf("--club");
const CLUB_FILTER = clubArgIdx >= 0 ? process.argv[clubArgIdx + 1] : null;

const esc = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Unix seconds → YYYY-MM-DD, or "—". */
const d = (unix: number | null | undefined) =>
  unix ? new Date(unix * 1000).toISOString().slice(0, 10) : "—";

/** Date → YYYY-MM-DD, or "—". */
const dd = (date: Date | null | undefined) =>
  date ? date.toISOString().slice(0, 10) : "—";

const dayjsDiff = (unixOrDate: number | Date | null) => {
  if (unixOrDate == null) return null;
  const ms =
    typeof unixOrDate === "number" ? unixOrDate * 1000 : unixOrDate.getTime();
  return Math.round((ms - Date.now()) / 86_400_000);
};

type Row = {
  club: string;
  member: string;
  plan: string;
  optionLabel: string;
  price: string;
  subId: string;
  /** What our database believes. */
  localEndDate: string;
  localAutoRenew: string;
  /** What Stripe says. */
  stripeStatus: string;
  stripeCancelAt: string;
  stripeCancelAtPeriodEnd: string;
  stripeCurrentPeriodEnd: string;
  daysUntilEnd: string;
  /** The verdict a human reads. */
  verdict: string;
  note: string;
};

async function main() {
  const clubs = await prisma.club.findMany({
    where: { ...(CLUB_FILTER ? { id: CLUB_FILTER } : {}), deletedAt: null },
    select: { id: true, name: true, stripeAccountId: true, stripeChargesEnabled: true },
  });

  const rows: Row[] = [];
  let confirmedEnding = 0;
  let localOnly = 0;
  let stripeOnly = 0;
  let clean = 0;
  let unreadable = 0;

  for (const club of clubs) {
    const subs = await prisma.memberSubscription.findMany({
      where: {
        stripeSubscriptionId: { not: null },
        status: { in: ["active", "pending", "past_due"] },
        member: { clubId: club.id, deletedAt: null },
      },
      select: {
        id: true,
        optionLabel: true,
        price: true,
        billingPeriod: true,
        status: true,
        autoRenew: true,
        endDate: true,
        currentPeriodEnd: true,
        stripeSubscriptionId: true,
        membership: { select: { name: true } },
        member: { select: { firstName: true, lastName: true } },
      },
      orderBy: { endDate: "asc" },
    });

    if (subs.length === 0) continue;

    if (!club.stripeAccountId) {
      for (const s of subs) {
        unreadable++;
        rows.push({
          club: club.name,
          member: `${s.member.firstName} ${s.member.lastName}`.trim(),
          plan: s.membership.name,
          optionLabel: s.optionLabel,
          price: String(s.price),
          subId: s.stripeSubscriptionId!,
          localEndDate: dd(s.endDate),
          localAutoRenew: String(s.autoRenew),
          stripeStatus: "—",
          stripeCancelAt: "—",
          stripeCancelAtPeriodEnd: "—",
          stripeCurrentPeriodEnd: "—",
          daysUntilEnd: "—",
          verdict: "UNREADABLE",
          note: "Club has no stripeAccountId — cannot retrieve.",
        });
      }
      continue;
    }

    for (const s of subs) {
      const name = `${s.member.firstName} ${s.member.lastName}`.trim();
      const base = {
        club: club.name,
        member: name,
        plan: s.membership.name,
        optionLabel: s.optionLabel,
        price: String(s.price),
        subId: s.stripeSubscriptionId!,
        localEndDate: dd(s.endDate),
        localAutoRenew: String(s.autoRenew),
      };

      let sub: Awaited<ReturnType<typeof stripe.subscriptions.retrieve>>;
      try {
        sub = await stripe.subscriptions.retrieve(s.stripeSubscriptionId!, {
          stripeAccount: club.stripeAccountId,
        });
      } catch (e) {
        unreadable++;
        rows.push({
          ...base,
          stripeStatus: "—",
          stripeCancelAt: "—",
          stripeCancelAtPeriodEnd: "—",
          stripeCurrentPeriodEnd: "—",
          daysUntilEnd: "—",
          verdict: "UNREADABLE",
          note: `retrieve failed: ${String(e).slice(0, 120)}`,
        });
        continue;
      }

      const cancelAt = (sub as unknown as { cancel_at: number | null }).cancel_at ?? null;
      const capE = !!(sub as unknown as { cancel_at_period_end: boolean }).cancel_at_period_end;
      const cpe =
        (sub as unknown as { current_period_end: number | null }).current_period_end ?? null;

      // Effective termination date Stripe will act on, if any.
      const stripeEndsAt = cancelAt ?? (capE ? cpe : null);
      const localEnds = s.endDate ?? null;

      let verdict: string;
      let note = "";

      if (stripeEndsAt && localEnds) {
        const drift = Math.abs(
          Math.round((stripeEndsAt * 1000 - localEnds.getTime()) / 86_400_000),
        );
        verdict = "ENDING — STRIPE CONFIRMS";
        note =
          drift === 0
            ? "Stripe and local agree."
            : `Stripe and local differ by ${drift} day(s).`;
        confirmedEnding++;
      } else if (stripeEndsAt && !localEnds) {
        verdict = "ENDING — LOCAL DOES NOT KNOW";
        note = "Stripe will terminate this; nothing local records it.";
        stripeOnly++;
        confirmedEnding++;
      } else if (!stripeEndsAt && localEnds) {
        verdict = "LOCAL ONLY — STRIPE WILL KEEP BILLING";
        note = "endDate is stale; Stripe holds no cancel_at.";
        localOnly++;
      } else {
        verdict = "OPEN-ENDED";
        note = "No end date on either side.";
        clean++;
      }

      if (s.autoRenew && stripeEndsAt) {
        note += " autoRenew=true contradicts Stripe.";
      }

      rows.push({
        ...base,
        stripeStatus: sub.status,
        stripeCancelAt: d(cancelAt),
        stripeCancelAtPeriodEnd: String(capE),
        stripeCurrentPeriodEnd: d(cpe),
        daysUntilEnd: stripeEndsAt ? String(dayjsDiff(stripeEndsAt)) : "—",
        verdict,
        note,
      });
    }
  }

  const headers = [
    "club", "member", "plan", "optionLabel", "price", "subId",
    "localEndDate", "localAutoRenew",
    "stripeStatus", "stripeCancelAt", "stripeCancelAtPeriodEnd",
    "stripeCurrentPeriodEnd", "daysUntilEnd", "verdict", "note",
  ] as const;

  if (CSV) {
    console.log(headers.join(","));
    for (const r of rows) console.log(headers.map((h) => esc(r[h])).join(","));
  } else {
    // Sort the report the way it will be read: soonest terminations first.
    const ordered = [...rows].sort((a, b) => {
      const av = a.daysUntilEnd === "—" ? Number.MAX_SAFE_INTEGER : Number(a.daysUntilEnd);
      const bv = b.daysUntilEnd === "—" ? Number.MAX_SAFE_INTEGER : Number(b.daysUntilEnd);
      return av - bv;
    });
    for (const r of ordered) {
      console.log(
        `${r.verdict.padEnd(34)} ${r.member.padEnd(22)} ${r.plan.padEnd(34)} ` +
          `$${r.price.padEnd(9)} local=${r.localEndDate} autoRenew=${r.localAutoRenew}  ` +
          `stripe: status=${r.stripeStatus} cancel_at=${r.stripeCancelAt} ` +
          `cancel_at_period_end=${r.stripeCancelAtPeriodEnd} ` +
          `current_period_end=${r.stripeCurrentPeriodEnd} in=${r.daysUntilEnd}d`,
      );
      if (r.note) console.log(`${" ".repeat(34)} ${r.note}`);
    }
    console.log("");
    console.log("─".repeat(78));
    console.log(`Subscriptions checked:            ${rows.length}`);
    console.log(`ENDING (Stripe confirms):         ${confirmedEnding}`);
    console.log(`  …of which Stripe-only:          ${stripeOnly}`);
    console.log(`LOCAL ONLY (Stripe keeps going):  ${localOnly}`);
    console.log(`OPEN-ENDED:                       ${clean}`);
    console.log(`UNREADABLE:                       ${unreadable}`);
    console.log("");
    console.log("Nothing was written. This script has no --apply.");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
