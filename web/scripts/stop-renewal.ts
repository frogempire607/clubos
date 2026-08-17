/**
 * Stop a membership renewing — one subscription, explicitly named. DRY RUN BY
 * DEFAULT.
 *
 * Built for Titus Hall (plan.md §8.14.3 / decision D13). His row says the
 * membership ends 2027-07-14; Stripe holds no `cancel_at` and will renew him.
 * The local record is the true one, so Stripe has to be told.
 *
 * There is no UI for this yet — §8.6.4's `set_auto_renew` action is Phase 8
 * work — so this script is the interim instrument. It is deliberately
 * single-subscription: no "all eligible" mode, no pattern matching, no bulk.
 *
 * ── Why cancel_at_period_end and not cancel_at ──────────────────────────────
 *
 * An absolute `cancel_at` is a date WE compute and Stripe merely accepts. If it
 * lands mid-period the member loses days they paid for; if it lands after, they
 * get a free stretch. `cancel_at_period_end: true` lets Stripe resolve the
 * boundary from its own billing period, and this script then writes that
 * resolved date back to `endDate` — the same discipline the cancellation
 * approval route now uses. The two sides end up agreeing by construction
 * rather than by coincidence, which is the entire lesson of the 2026-08-16
 * audit.
 *
 * ── What it will NOT do ─────────────────────────────────────────────────────
 *
 *   - It never cancels immediately. The member keeps every day they paid for.
 *   - It never refunds, charges, or emails.
 *   - It never touches a subscription other than the one named.
 *   - It refuses if Stripe already holds a cancellation, rather than
 *     overwriting one somebody set deliberately.
 *
 * Usage (from web/):
 *   npx tsx scripts/stop-renewal.ts --subscription <memberSubscriptionId>
 *   npx tsx scripts/stop-renewal.ts --subscription <id> --apply
 *
 * Optional, both OFF by default — see the DATE MISMATCHES section it prints:
 *   --align-commitment   set Member.commitmentEndDate to the resolved end date
 *   --align-start        set Member.membershipStartDate to the subscription's startDate
 */
import { prisma } from "../lib/prisma";
import { stripe } from "../lib/stripe";
import { writeBillingAudit } from "../lib/billingAudit";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};

const APPLY = flag("apply");
const SUB_ID = value("subscription");
const ALIGN_COMMITMENT = flag("align-commitment");
const ALIGN_START = flag("align-start");

const d = (v: Date | null | undefined) => (v ? v.toISOString().slice(0, 10) : "—");
const dUnix = (v: number | null | undefined) =>
  v ? new Date(v * 1000).toISOString().slice(0, 10) : "—";

async function main() {
  if (!SUB_ID) {
    console.error("Refusing to run: --subscription <memberSubscriptionId> is required.");
    console.error("This script acts on exactly one subscription, named explicitly.");
    process.exit(1);
  }

  const sub = await prisma.memberSubscription.findUnique({
    where: { id: SUB_ID },
    select: {
      id: true,
      status: true,
      price: true,
      billingPeriod: true,
      billingType: true,
      autoRenew: true,
      endDate: true,
      startDate: true,
      currentPeriodEnd: true,
      paidThroughDate: true,
      optionLabel: true,
      stripeSubscriptionId: true,
      membership: { select: { name: true } },
      member: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          clubId: true,
          commitmentEndDate: true,
          membershipStartDate: true,
          club: { select: { name: true, stripeAccountId: true } },
        },
      },
    },
  });

  if (!sub) {
    console.error(`No MemberSubscription with id ${SUB_ID}.`);
    process.exit(1);
  }

  const who = `${sub.member.firstName} ${sub.member.lastName}`;
  console.log(`\n${who} — ${sub.membership.name} · ${sub.optionLabel} · $${sub.price}`);
  console.log(`Club: ${sub.member.club.name}`);
  console.log(`Subscription: ${sub.id}`);
  console.log(`  status=${sub.status} billingType=${sub.billingType} autoRenew=${sub.autoRenew}`);
  console.log(`  local endDate=${d(sub.endDate)} startDate=${d(sub.startDate)}`);

  if (!sub.stripeSubscriptionId) {
    console.error("\nThis subscription has no stripeSubscriptionId — nothing to tell Stripe.");
    console.error("An offline/MANUAL membership stops by its endDate; set that instead.");
    process.exit(1);
  }
  const acct = sub.member.club.stripeAccountId;
  if (!acct) {
    console.error("\nThe club has no stripeAccountId. Cannot reach the connected account.");
    process.exit(1);
  }

  // ── Read Stripe first. Never write against an assumption. ─────────────────
  const live = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId, {
    stripeAccount: acct,
  });
  const cancelAt = (live as unknown as { cancel_at: number | null }).cancel_at ?? null;
  const capE = !!(live as unknown as { cancel_at_period_end: boolean }).cancel_at_period_end;
  const cpe = (live as unknown as { current_period_end: number | null }).current_period_end ?? null;

  console.log(`\nStripe ${sub.stripeSubscriptionId}:`);
  console.log(`  status=${live.status} cancel_at=${dUnix(cancelAt)} cancel_at_period_end=${capE}`);
  console.log(`  current_period_end=${dUnix(cpe)}`);

  if (cancelAt || capE) {
    console.log(
      "\nStripe ALREADY holds a cancellation for this subscription. Refusing — " +
        "somebody set that deliberately and this script will not overwrite it.",
    );
    console.log("If the date is wrong, change it in Stripe or in the billing centre.");
    await prisma.$disconnect();
    return;
  }
  if (live.status !== "active" && live.status !== "trialing") {
    console.log(`\nStripe reports status "${live.status}" — not active or trialing. Refusing.`);
    await prisma.$disconnect();
    return;
  }
  if (!cpe) {
    console.log("\nStripe returned no current_period_end, so the resolved end date is unknown.");
    console.log("Refusing: writing an endDate we cannot stand behind is the bug being fixed.");
    await prisma.$disconnect();
    return;
  }

  const resolvedEnd = new Date(cpe * 1000);

  // ── Date mismatches. Reported always, corrected only on explicit request. ──
  console.log("\nDATE MISMATCHES");
  const rows: Array<[string, string, string]> = [
    ["MemberSubscription.endDate", d(sub.endDate), d(resolvedEnd)],
    ["Member.commitmentEndDate", d(sub.member.commitmentEndDate), d(resolvedEnd)],
    ["Member.membershipStartDate", d(sub.member.membershipStartDate), d(sub.startDate)],
  ];
  for (const [field, current, proposed] of rows) {
    const same = current === proposed;
    console.log(`  ${field.padEnd(30)} ${current.padEnd(12)} → ${same ? "(unchanged)" : proposed}`);
  }
  if (d(sub.member.commitmentEndDate) !== d(resolvedEnd) && !ALIGN_COMMITMENT) {
    console.log("    commitmentEndDate differs — pass --align-commitment to bring it in line.");
  }
  if (d(sub.member.membershipStartDate) !== d(sub.startDate) && !ALIGN_START) {
    console.log("    membershipStartDate differs from the subscription's start.");
    console.log("    These are legitimately different things (agreed start vs billing start),");
    console.log("    so this is NOT corrected unless you pass --align-start.");
  }

  if (!APPLY) {
    console.log("\n── DRY RUN ── nothing was written to Stripe or the database.");
    console.log(`Re-run with --apply to set cancel_at_period_end and stamp ${d(resolvedEnd)}.`);
    await prisma.$disconnect();
    return;
  }

  // ── Apply: Stripe first, verified, then local. ────────────────────────────
  const updated = await stripe.subscriptions.update(
    sub.stripeSubscriptionId,
    { cancel_at_period_end: true },
    { stripeAccount: acct },
  );
  const confirmedCapE = !!(updated as unknown as { cancel_at_period_end: boolean })
    .cancel_at_period_end;
  const confirmedEnd =
    (updated as unknown as { current_period_end: number | null }).current_period_end ?? null;

  if (!confirmedCapE || !confirmedEnd) {
    console.error("\nStripe did not confirm the cancellation. NOTHING was written locally.");
    process.exit(1);
  }
  const finalEnd = new Date(confirmedEnd * 1000);
  console.log(`\nStripe confirmed: cancel_at_period_end=true, ends ${d(finalEnd)}`);

  await prisma.memberSubscription.update({
    where: { id: sub.id },
    data: { autoRenew: false, endDate: finalEnd },
  });
  console.log(`  MemberSubscription.autoRenew=false, endDate=${d(finalEnd)}`);

  const memberData: Record<string, Date> = {};
  if (ALIGN_COMMITMENT) memberData.commitmentEndDate = finalEnd;
  if (ALIGN_START && sub.startDate) memberData.membershipStartDate = sub.startDate;
  if (Object.keys(memberData).length > 0) {
    await prisma.member.update({ where: { id: sub.member.id }, data: memberData });
    for (const k of Object.keys(memberData)) console.log(`  Member.${k} aligned`);
  }

  // Same append-only writer every other billing mutation uses, so this shows up
  // in the member's billing history beside the owner-initiated actions rather
  // than in a private script log.
  await writeBillingAudit({
    clubId: sub.member.clubId,
    memberId: sub.member.id,
    actorUserId: null, // a script, not a portal user — the note says which
    action: "SCRIPT_RENEWAL_STOPPED",
    before: {
      endDate: sub.endDate ? sub.endDate.toISOString() : null,
      autoRenew: sub.autoRenew,
      commitmentEndDate: sub.member.commitmentEndDate
        ? sub.member.commitmentEndDate.toISOString()
        : null,
      membershipStartDate: sub.member.membershipStartDate
        ? sub.member.membershipStartDate.toISOString()
        : null,
      stripeCancelAtPeriodEnd: false,
    },
    after: {
      endDate: finalEnd.toISOString(),
      autoRenew: false,
      alignedCommitment: ALIGN_COMMITMENT,
      alignedStart: ALIGN_START,
      stripeCancelAtPeriodEnd: true,
    },
    note:
      `scripts/stop-renewal.ts — plan.md D13. Stripe cancel_at_period_end set on ` +
      `${sub.stripeSubscriptionId}; end date resolved by Stripe, not computed here.`,
  });
  console.log("  BillingAuditLog written.");
  console.log("\nDone. The membership now ends on the date Stripe resolved, and both sides agree.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
