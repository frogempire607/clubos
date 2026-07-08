/**
 * Backfill `Member.stripeSetupPaymentMethodId` (and `stripeSetupCustomerId`) for
 * members who saved a card but whose payment method was never captured — because
 * the connected-account `checkout.session.completed` webhook wasn't being
 * delivered/verified. Those members were billed MANUAL (offline) at approval
 * instead of on a real Stripe subscription.
 *
 * CUSTOMER-DRIVEN: it scans every customer on the club's connected account,
 * finds the ones that actually have a saved card, and matches each back to a
 * member via customer metadata (`migrationMemberId` from activation or
 * `memberId` from the portal add-card flow; email as a last resort). This
 * catches cards saved on customers we never recorded locally (activation
 * retries, legacy `stripeCustomerId`, family-reuse) — not just members whose
 * `stripeSetupCustomerId` is already stored.
 *
 * SAFE: reads Stripe and writes ONLY the two member card fields. It never
 * creates/modifies/cancels a subscription and never mutates the Stripe customer.
 * Ambiguous cases (multiple cards with no default; multiple customers for one
 * member; no member match) are SKIPPED and reported — we never guess.
 *
 * Usage (from web/):
 *   npx tsx scripts/backfill-setup-payment-methods.ts            # dry run
 *   npx tsx scripts/backfill-setup-payment-methods.ts --apply
 *   npx tsx scripts/backfill-setup-payment-methods.ts --club <clubId> --apply
 */
import type Stripe from "stripe";
import { prisma } from "../lib/prisma";
import { stripe } from "../lib/stripe";
import { PAYMENT_SETUP } from "../lib/migration";

const APPLY = process.argv.includes("--apply");
const clubArgIdx = process.argv.indexOf("--club");
const CLUB_FILTER = clubArgIdx >= 0 ? process.argv[clubArgIdx + 1] : null;

// Pick the payment method to record for a customer, or null if we shouldn't guess.
async function pickCard(
  customer: Stripe.Customer,
  stripeAccount: string,
): Promise<{ pmId: string | null; detail: string }> {
  const defaultPm = (customer.invoice_settings?.default_payment_method as string | null) || null;
  const pms = await stripe.paymentMethods.list(
    { customer: customer.id, type: "card", limit: 10 },
    { stripeAccount },
  );
  const cards = pms.data;
  if (cards.length === 0) return { pmId: null, detail: "no cards" };
  if (defaultPm && cards.some((c) => c.id === defaultPm)) return { pmId: defaultPm, detail: "default" };
  if (cards.length === 1) return { pmId: cards[0].id, detail: "single" };
  return { pmId: null, detail: `${cards.length} cards, no default (ambiguous)` };
}

type Candidate = { customerId: string; pmId: string; created: number; detail: string };

async function main() {
  console.log(`\n=== Backfill setup payment methods — customer-driven (${APPLY ? "APPLY" : "DRY RUN"}) ===`);

  const clubs = await prisma.club.findMany({
    where: { ...(CLUB_FILTER ? { id: CLUB_FILTER } : {}), stripeAccountId: { not: null } },
    select: { id: true, name: true, stripeAccountId: true },
  });

  let applied = 0;
  const unmatchedCustomers: string[] = [];
  const ambiguousMembers: string[] = [];
  const skippedCustomers: string[] = [];

  for (const club of clubs) {
    const acct = club.stripeAccountId!;
    // memberId -> list of card-bearing customer candidates
    const byMember = new Map<string, Candidate[]>();

    let scanned = 0;
    for await (const customer of stripe.customers.list({ limit: 100 }, { stripeAccount: acct })) {
      scanned++;
      const { pmId, detail } = await pickCard(customer, acct);
      if (!pmId) {
        if (detail.includes("ambiguous")) skippedCustomers.push(`${customer.id} (${detail})`);
        continue;
      }
      // Match customer -> member via metadata, then email.
      const metaId =
        (customer.metadata?.migrationMemberId as string) ||
        (customer.metadata?.memberId as string) ||
        null;
      let memberId: string | null = null;
      if (metaId) {
        const m = await prisma.member.findFirst({ where: { id: metaId, clubId: club.id }, select: { id: true } });
        if (m) memberId = m.id;
      }
      if (!memberId && customer.email) {
        const matches = await prisma.member.findMany({
          where: { clubId: club.id, deletedAt: null, OR: [{ email: customer.email }, { guardianEmail: customer.email }] },
          select: { id: true },
          take: 2,
        });
        if (matches.length === 1) memberId = matches[0].id;
      }
      if (!memberId) {
        unmatchedCustomers.push(`${customer.id} (${customer.email ?? "no email"})`);
        continue;
      }
      const list = byMember.get(memberId) ?? [];
      list.push({ customerId: customer.id, pmId, created: customer.created, detail });
      byMember.set(memberId, list);
    }

    console.log(`\nClub: ${club.name} (${club.id}) — scanned ${scanned} customer(s); ${byMember.size} member(s) with a saved card`);

    for (const [memberId, cands] of byMember) {
      const member = await prisma.member.findFirst({
        where: { id: memberId, clubId: club.id },
        select: { id: true, stripeSetupPaymentMethodId: true },
      });
      if (!member) continue;
      if (member.stripeSetupPaymentMethodId) {
        console.log(`  = ${memberId} — already has a captured PM, leaving as-is`);
        continue;
      }
      // Prefer the newest customer if a member somehow has more than one.
      const chosen = cands.sort((a, b) => b.created - a.created)[0];
      const ambiguous = cands.length > 1;
      if (ambiguous) ambiguousMembers.push(`${memberId} (${cands.length} card-customers → chose ${chosen.customerId})`);

      console.log(
        `  ✓ ${memberId} — ${chosen.detail}${ambiguous ? " [MULTIPLE customers, chose newest]" : ""} → ${chosen.customerId} / ${chosen.pmId}${APPLY ? "" : " (dry run)"}`,
      );
      if (APPLY) {
        await prisma.member.update({
          where: { id: memberId },
          data: {
            stripeSetupCustomerId: chosen.customerId,
            stripeSetupPaymentMethodId: chosen.pmId,
            paymentSetupStatus: PAYMENT_SETUP.COMPLETE,
          },
        });
        applied++;
      }
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Applied: ${APPLY ? applied : 0}${APPLY ? "" : " (dry run)"}`);
  if (ambiguousMembers.length) {
    console.log(`\nMembers with MULTIPLE card-customers (review):`);
    ambiguousMembers.forEach((s) => console.log("  " + s));
  }
  if (skippedCustomers.length) {
    console.log(`\nCustomers skipped — multiple cards, no default (review):`);
    skippedCustomers.forEach((s) => console.log("  " + s));
  }
  if (unmatchedCustomers.length) {
    console.log(`\nCard-bearing customers with NO member match (review):`);
    unmatchedCustomers.forEach((s) => console.log("  " + s));
  }
  if (!APPLY) console.log(`\nDry run only — re-run with --apply to write the changes above.`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
