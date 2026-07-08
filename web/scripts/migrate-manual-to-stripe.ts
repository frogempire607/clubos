/**
 * Convert existing MANUAL (offline) member subscriptions into proper recurring
 * Stripe subscriptions — SAFELY — for members who now have a captured card
 * (run backfill-setup-payment-methods first).
 *
 * Safety rails:
 *   - Only touches MANUAL, active subscriptions with price > 0 whose member has
 *     a captured Stripe customer + payment method. Everything else is skipped.
 *   - The FIRST Stripe charge is anchored (via trial_end) to the member's NEXT
 *     due date, preserving their day-of-month cadence. Nobody is charged now, so
 *     a member already paid manually for the current period is never double-billed.
 *   - Pre-flight: if the Stripe customer ALREADY has an active/trialing/past_due
 *     subscription, we skip (never create a duplicate).
 *   - Idempotency key per source subscription, so re-running can't fork duplicates.
 *   - Never cancels/modifies any existing Stripe subscription.
 *   - Dry-run by default; --apply to execute.
 *
 * Usage (from web/):
 *   npx tsx scripts/migrate-manual-to-stripe.ts             # dry run
 *   npx tsx scripts/migrate-manual-to-stripe.ts --apply
 *   npx tsx scripts/migrate-manual-to-stripe.ts --club <clubId> --apply
 */
import { prisma } from "../lib/prisma";
import { stripe, billingPeriodToStripeInterval } from "../lib/stripe";
import { recurringUnitWithFee } from "../lib/fees";
import { ensureMembershipProduct } from "../lib/stripeCatalog";

const APPLY = process.argv.includes("--apply");
const clubArgIdx = process.argv.indexOf("--club");
const CLUB_FILTER = clubArgIdx >= 0 ? process.argv[clubArgIdx + 1] : null;

// Next due date on the member's cadence, strictly in the future. Preserves the
// day-of-month for monthly-family periods by stepping whole periods forward.
function nextDueDate(anchor: Date | null, period: string, now: Date): Date {
  const step = (d: Date) => {
    switch (period) {
      case "WEEKLY": d.setDate(d.getDate() + 7); break;
      case "MONTHLY": d.setMonth(d.getMonth() + 1); break;
      case "QUARTERLY": d.setMonth(d.getMonth() + 3); break;
      case "SEMI_ANNUAL": d.setMonth(d.getMonth() + 6); break;
      case "ANNUAL": d.setFullYear(d.getFullYear() + 1); break;
      default: d.setMonth(d.getMonth() + 1); break;
    }
  };
  if (anchor && anchor.getTime() > now.getTime()) return anchor;
  const d = anchor ? new Date(anchor) : new Date(now);
  // Guard against an unbounded loop on a bad period; cap iterations.
  let i = 0;
  while (d.getTime() <= now.getTime() + 60_000 && i < 240) { step(d); i++; }
  return d;
}

async function customerHasLiveSub(customerId: string, stripeAccount: string): Promise<boolean> {
  const subs = await stripe.subscriptions.list(
    { customer: customerId, status: "all", limit: 100 },
    { stripeAccount },
  );
  return subs.data.some((s) => ["active", "trialing", "past_due", "unpaid"].includes(s.status));
}

async function main() {
  console.log(`\n=== Migrate MANUAL → Stripe recurring (${APPLY ? "APPLY" : "DRY RUN"}) ===`);
  const now = new Date();

  const clubs = await prisma.club.findMany({
    where: {
      ...(CLUB_FILTER ? { id: CLUB_FILTER } : {}),
      stripeAccountId: { not: null },
      stripeChargesEnabled: true,
    },
    select: { id: true, name: true, stripeAccountId: true, passProcessingFees: true },
  });

  let converted = 0;
  const skipped: string[] = [];

  for (const club of clubs) {
    const acct = club.stripeAccountId!;
    const subs = await prisma.memberSubscription.findMany({
      where: {
        billingType: "MANUAL",
        status: "active",
        stripeSubscriptionId: null,
        member: { clubId: club.id, deletedAt: null },
      },
      select: {
        id: true, price: true, billingPeriod: true, optionLabel: true, billingAnchorDate: true, endDate: true,
        member: { select: { id: true, stripeSetupCustomerId: true, stripeSetupPaymentMethodId: true } },
        membership: { select: { id: true, clubId: true, name: true, description: true, stripeProductId: true, stripePriceIds: true } },
      },
    });
    if (subs.length === 0) continue;
    console.log(`\nClub: ${club.name} (${club.id}) — ${subs.length} MANUAL active sub(s)`);

    for (const s of subs) {
      const price = Number(s.price);
      const customer = s.member.stripeSetupCustomerId;
      const pm = s.member.stripeSetupPaymentMethodId;
      const period = s.billingPeriod || "MONTHLY";
      const interval = billingPeriodToStripeInterval(period);

      if (price <= 0) { skipped.push(`${s.id} — free/$0 (stays manual)`); continue; }
      if (!interval) { skipped.push(`${s.id} — non-recurring period ${period}`); continue; }
      if (!customer || !pm) { skipped.push(`${s.id} — no captured card (run backfill first)`); continue; }

      // Pre-flight: don't create a second live subscription for this customer.
      if (await customerHasLiveSub(customer, acct)) {
        skipped.push(`${s.id} — customer ${customer} already has a live Stripe subscription`);
        continue;
      }

      const trialEnd = nextDueDate(s.billingAnchorDate ?? null, period, now);
      const amountCents = recurringUnitWithFee(Math.round(price * 100), club.passProcessingFees);

      console.log(
        `  ✓ ${s.id} — $${price}/${period} → first charge ${trialEnd.toISOString().slice(0, 10)} (cadence preserved)${APPLY ? "" : " (dry run)"}`,
      );

      // Everything below writes to Stripe/DB — only in APPLY mode. (Resolving the
      // catalog product can create a Stripe Product, so it stays behind this gate.)
      if (!APPLY) { converted++; continue; }

      const productId =
        (await ensureMembershipProduct(s.membership, { id: club.id, stripeAccountId: acct, stripeChargesEnabled: true })) ??
        (await stripe.products.create(
          { name: s.membership.name, metadata: { athletixMembershipId: s.membership.id, clubId: club.id, kind: "membership" } },
          { stripeAccount: acct },
        )).id;

      const sub = await stripe.subscriptions.create(
        {
          customer,
          default_payment_method: pm,
          items: [{ price_data: { currency: "usd", product: productId, unit_amount: amountCents, recurring: interval } }],
          trial_end: Math.floor(trialEnd.getTime() / 1000),
          proration_behavior: "none",
          application_fee_percent: 0,
          metadata: { memberSubscriptionId: s.id, memberId: s.member.id, clubId: club.id, migratedFromManual: "1" },
        },
        { stripeAccount: acct, idempotencyKey: `aox-manual-to-stripe-${s.id}` },
      );

      await prisma.memberSubscription.update({
        where: { id: s.id },
        data: {
          billingType: "RECURRING",
          autoRenew: true,
          stripeSubscriptionId: sub.id,
          stripePriceId: sub.items?.data?.[0]?.price?.id ?? null,
          stripeProductId: productId,
          stripeStatus: sub.status,
          currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : trialEnd,
          billingAnchorDate: trialEnd,
          notes: `${s.optionLabel} — converted from manual to Stripe recurring (first charge ${trialEnd.toISOString().slice(0, 10)})`,
        },
      });
      converted++;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Converted: ${converted}${APPLY ? "" : " (dry run)"}`);
  if (skipped.length) {
    console.log(`\nSkipped (${skipped.length}):`);
    skipped.forEach((x) => console.log("  " + x));
  }
  if (!APPLY) console.log(`\nDry run only — re-run with --apply to create the Stripe subscriptions above.`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
