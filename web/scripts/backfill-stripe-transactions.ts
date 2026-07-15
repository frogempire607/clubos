// Backfill missing Financials Transactions from PAID Stripe invoices.
//
// Recovers subscription payments that the pre-2026-07-15 webhook dropped
// (clover API shape — see lib/stripeTruth.ts). READ-ONLY by default.
//
//   npx tsx scripts/backfill-stripe-transactions.ts                       # dry run, all clubs
//   npx tsx scripts/backfill-stripe-transactions.ts --club <clubId>       # dry run, one club
//   npx tsx scripts/backfill-stripe-transactions.ts --apply --invoices in_x,in_y
//
// --apply REFUSES to run without an explicit --invoices allowlist. Every
// created row: dedup by stripeInvoiceId (re-runs and webhook races are no-ops),
// exact gross/fee/net from Stripe, paymentSource STRIPE + VERIFIED, txDate =
// the Stripe paid_at (so Financials reports the month the money actually
// moved), plus a BillingAuditLog row. Never touches Stripe. Never modifies
// existing rows.
import { PrismaClient } from "@prisma/client";
import Stripe from "stripe";
import {
  invoiceSubscriptionId,
  invoiceSubscriptionMetadata,
  invoicePaymentIntentId,
} from "../lib/stripeTruth";

const prisma = new PrismaClient();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2023-10-16" as Stripe.LatestApiVersion,
});

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const clubArg = args.includes("--club") ? args[args.indexOf("--club") + 1] : null;
const invoicesArg = args.includes("--invoices") ? args[args.indexOf("--invoices") + 1] : null;
const allow = new Set(
  (invoicesArg || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

if (APPLY && allow.size === 0) {
  console.error(
    "--apply requires an explicit --invoices <in_...,in_...> allowlist. Run the dry run first.",
  );
  process.exit(1);
}

type Proposal = {
  clubId: string;
  clubName: string;
  invoiceId: string;
  memberId: string;
  memberName: string;
  gross: number;
  fee: number | null;
  net: number | null;
  paymentIntentId: string | null;
  chargeId: string | null;
  subscriptionId: string;
  paidAt: Date;
  label: string;
  billingReason: string | null;
};

async function main() {
  const clubs = await prisma.club.findMany({
    where: {
      stripeAccountId: { not: null },
      ...(clubArg ? { id: clubArg } : {}),
    },
    select: { id: true, name: true, stripeAccountId: true },
  });

  const proposals: Proposal[] = [];
  const skipped: string[] = [];

  for (const club of clubs) {
    const acct = club.stripeAccountId!;
    // Page all PAID invoices on the connected account.
    let startingAfter: string | undefined;
    for (let page = 0; page < 50; page++) {
      const res = await stripe.invoices.list(
        { status: "paid", limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) },
        { stripeAccount: acct },
      );
      for (const inv of res.data) {
        if (!inv.amount_paid || inv.amount_paid <= 0) continue; // $0 trial invoices
        const subscriptionId = invoiceSubscriptionId(inv);
        if (!subscriptionId) {
          skipped.push(`${inv.id}: no subscription (standalone invoice) — out of scope`);
          continue;
        }
        const existing = await prisma.transaction.findFirst({
          where: { stripeInvoiceId: inv.id },
          select: { id: true },
        });
        if (existing) continue; // already recorded — the whole point of the dedup key

        // Resolve member: local sub row → invoice-embedded metadata → sub metadata.
        const memberSub = await prisma.memberSubscription.findFirst({
          where: { stripeSubscriptionId: subscriptionId },
          select: { memberId: true, optionLabel: true, member: { select: { clubId: true } } },
        });
        let memberId = memberSub?.memberId ?? null;
        let label = memberSub?.optionLabel ?? null;
        if (!memberId) {
          const meta = invoiceSubscriptionMetadata(inv);
          memberId = meta.memberId || meta.migrationMemberId || null;
        }
        if (!memberId) {
          try {
            const sub = await stripe.subscriptions.retrieve(subscriptionId, { stripeAccount: acct });
            memberId = sub.metadata?.memberId || sub.metadata?.migrationMemberId || null;
          } catch {
            /* fall through */
          }
        }
        if (!memberId) {
          skipped.push(`${inv.id}: paid ${(inv.amount_paid / 100).toFixed(2)} but NO resolvable member — needs manual reconciliation`);
          continue;
        }
        const member = await prisma.member.findUnique({
          where: { id: memberId },
          select: { id: true, clubId: true, firstName: true, lastName: true },
        });
        if (!member || member.clubId !== club.id) {
          skipped.push(`${inv.id}: member ${memberId} not found in club ${club.id}`);
          continue;
        }

        // Exact fee/net from the charge's balance transaction.
        let fee: number | null = null;
        let net: number | null = null;
        let chargeId: string | null = null;
        let piId = invoicePaymentIntentId(inv);
        if (!piId) {
          try {
            const fresh = await stripe.invoices.retrieve(
              inv.id,
              { expand: ["payments"] } as never,
              { stripeAccount: acct },
            );
            piId = invoicePaymentIntentId(fresh);
          } catch {
            /* keep null */
          }
        }
        if (piId) {
          try {
            const pi = await stripe.paymentIntents.retrieve(
              piId,
              { expand: ["latest_charge.balance_transaction"] },
              { stripeAccount: acct },
            );
            const charge = pi.latest_charge as Stripe.Charge | null;
            if (charge && typeof charge === "object") {
              chargeId = charge.id;
              const bt = charge.balance_transaction;
              if (bt && typeof bt === "object") {
                fee = bt.fee / 100;
                net = bt.net / 100;
              }
            }
          } catch {
            /* fee stays null; reconciliation can fill later */
          }
        }

        proposals.push({
          clubId: club.id,
          clubName: club.name,
          invoiceId: inv.id,
          memberId: member.id,
          memberName: `${member.firstName} ${member.lastName ?? ""}`.trim(),
          gross: inv.amount_paid / 100,
          fee,
          net,
          paymentIntentId: piId,
          chargeId,
          subscriptionId,
          paidAt: new Date((inv.status_transitions?.paid_at ?? inv.created) * 1000),
          label: label ?? "membership",
          billingReason: inv.billing_reason ?? null,
        });
      }
      if (!res.has_more) break;
      startingAfter = res.data[res.data.length - 1]?.id;
    }
  }

  console.log(`\n=== ${APPLY ? "APPLY" : "DRY RUN"} — ${proposals.length} missing Transaction(s) ===\n`);
  for (const p of proposals) {
    const inAllow = allow.size === 0 || allow.has(p.invoiceId);
    console.log(
      `${inAllow ? "→" : "✗ (not in allowlist)"} ${p.invoiceId}  ${p.paidAt.toISOString().slice(0, 10)}  ` +
        `${p.memberName}  gross $${p.gross.toFixed(2)}  fee ${p.fee != null ? `$${p.fee.toFixed(2)}` : "?"}  ` +
        `net ${p.net != null ? `$${p.net.toFixed(2)}` : "?"}  sub ${p.subscriptionId}  (${p.billingReason})`,
    );
  }
  if (skipped.length) {
    console.log(`\nSkipped (${skipped.length}):`);
    for (const s of skipped) console.log(`  - ${s}`);
  }

  if (!APPLY) {
    console.log("\nDry run only — nothing written. Re-run with --apply --invoices <ids> after owner approval.");
    return;
  }

  let created = 0;
  for (const p of proposals) {
    if (!allow.has(p.invoiceId)) continue;
    // Re-check dedup inside apply (idempotent under races/re-runs).
    const dupe = await prisma.transaction.findFirst({ where: { stripeInvoiceId: p.invoiceId }, select: { id: true } });
    if (dupe) {
      console.log(`skip ${p.invoiceId} — Transaction appeared since dry run (${dupe.id})`);
      continue;
    }
    const tx = await prisma.transaction.create({
      data: {
        clubId: p.clubId,
        memberId: p.memberId,
        amount: p.gross,
        status: "SUCCEEDED",
        stripePaymentIntentId: p.paymentIntentId,
        stripeChargeId: p.chargeId,
        stripeInvoiceId: p.invoiceId,
        stripeSubscriptionId: p.subscriptionId,
        description: `Membership ${p.billingReason === "subscription_create" ? "payment" : "renewal"}: ${p.label} (backfilled from Stripe)`,
        type: "MEMBERSHIP",
        category: "memberships",
        paymentMethod: "STRIPE",
        paymentSource: "STRIPE",
        reconciliationStatus: "VERIFIED",
        ...(p.fee != null ? { stripeFeeAmount: p.fee } : {}),
        ...(p.net != null ? { netAmount: p.net } : {}),
        txDate: p.paidAt,
      },
    });
    await prisma.billingAuditLog.create({
      data: {
        clubId: p.clubId,
        memberId: p.memberId,
        actorUserId: null,
        action: "TRANSACTION_BACKFILLED",
        before: { invoiceId: p.invoiceId, localTransaction: null },
        after: { transactionId: tx.id, gross: p.gross, fee: p.fee, net: p.net },
        note: "Backfilled from Stripe paid invoice (pre-2026-07-15 webhook dropped clover-shape subscription invoices). Owner-approved allowlist run.",
      },
    });
    created++;
    console.log(`created ${tx.id} for ${p.invoiceId}`);
  }

  // Verify: re-read everything we just wrote.
  console.log(`\n${created} Transaction(s) created. Verifying…`);
  for (const p of proposals) {
    if (!allow.has(p.invoiceId)) continue;
    const row = await prisma.transaction.findFirst({ where: { stripeInvoiceId: p.invoiceId } });
    console.log(`  ${p.invoiceId} → ${row ? `${row.id} $${row.amount} ${row.reconciliationStatus}` : "MISSING (!)"}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
