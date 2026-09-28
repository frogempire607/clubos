/**
 * Cancel MANUAL (cash) memberships that duplicate a card membership on the
 * SAME plan for the SAME member. DRY RUN BY DEFAULT.
 *
 *   npx tsx scripts/cancel-duplicate-cash-memberships.ts                    # dry run, every row printed
 *   npx tsx scripts/cancel-duplicate-cash-memberships.ts --apply            # cancel the duplicates
 *   npx tsx scripts/cancel-duplicate-cash-memberships.ts --apply --void-invoices
 *                                                                           # …and void their unpaid cash invoices
 *
 * ── Why these rows exist ────────────────────────────────────────────────────
 * 2026-09-23: staff approved three pending in-portal cash purchase requests
 * (within 4 seconds, notes "In-portal cash purchase approved by staff.") for
 * kids whose families had meanwhile paid for the same plan by card. Expected:
 * exactly Hudson R., Wenhuan W., Wenxuan W. The approve route now refuses this
 * (app/api/approvals/membership-purchase).
 *
 * ── What it selects (lib/billingDataRules.findDuplicateCashSubscriptions) ───
 * An `active` MANUAL subscription with NO stripeSubscriptionId, where the same
 * member holds another live subscription WITH a stripeSubscriptionId on the
 * same membershipId.
 *
 * ── What --apply writes ─────────────────────────────────────────────────────
 *   · the MANUAL row: status "canceled", canceledAt now, autoRenew false,
 *     cancelReason "Duplicate of card membership — approved in error Sep 23"
 *   · a BillingAuditLog row per cancel (DUPLICATE_CASH_MEMBERSHIP_CANCELED),
 *     naming both subscriptions
 *   · recomputeMemberStatus for the member (the card membership keeps them ACTIVE)
 *   · with --void-invoices only: the unpaid cash INVOICE the approval created
 *     (PENDING, manual, same member + amount, written within 2 minutes of the
 *     duplicate) → status FAILED, reconciliationStatus VOID — the same shape
 *     the app uses for a superseded offline invoice. Without the flag they are
 *     listed and left alone.
 *
 * No MemberSubscriptionEvent CANCELED row is written on purpose: that kind is
 * churn in Reports, and a membership approved in error was never a member
 * leaving (the approve route never recorded its CREATED either). The audit
 * log is the record.
 *
 * ── What it will NEVER do ───────────────────────────────────────────────────
 * It never calls Stripe (no Stripe import) and never writes a row that has a
 * stripeSubscriptionId — the update is guarded on `stripeSubscriptionId: null`
 * in the WHERE clause itself, so even a wrong selection cannot touch one.
 */
import { prisma } from "../lib/prisma";
import { recomputeMemberStatus } from "../lib/memberStatus";
import { findDuplicateCashSubscriptions, LIVE_SUBSCRIPTION_STATUSES } from "../lib/billingDataRules";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const VOID_INVOICES = argv.includes("--void-invoices");
const CANCEL_REASON = "Duplicate of card membership — approved in error Sep 23";
const EXPECTED = ["Hudson R.", "Wenhuan W.", "Wenxuan W."];

const fmt = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 19).replace("T", " ") : "—");

async function main() {
  // Every member holding an active MANUAL row with no Stripe id — then all of
  // their live subscriptions, so the pure rule sees both halves of a pair.
  const manualHolders = await prisma.memberSubscription.findMany({
    where: { billingType: "MANUAL", status: "active", stripeSubscriptionId: null, member: { deletedAt: null } },
    select: { memberId: true },
    distinct: ["memberId"],
  });
  const memberIds = manualHolders.map((r) => r.memberId);
  const subs = memberIds.length
    ? await prisma.memberSubscription.findMany({
        where: { memberId: { in: memberIds }, status: { in: [...LIVE_SUBSCRIPTION_STATUSES] } },
        orderBy: { createdAt: "asc" },
        select: {
          id: true, memberId: true, membershipId: true, status: true, billingType: true, stripeSubscriptionId: true,
          stripeStatus: true, startedAt: true, startDate: true, createdAt: true, optionLabel: true, price: true, notes: true,
          membership: { select: { name: true } },
          member: { select: { firstName: true, lastName: true, clubId: true } },
        },
      })
    : [];
  const byId = new Map(subs.map((s) => [s.id, s]));
  const pairs = findDuplicateCashSubscriptions(subs);

  console.log(`\n=== ${APPLY ? "APPLY" : "DRY RUN"} — ${pairs.length} duplicate cash membership(s) ===`);
  console.log(`Expected (2026-09-28): ${EXPECTED.join(", ")}\n`);

  type Plan = { manualId: string; cardId: string; clubId: string; memberId: string; name: string; invoiceIds: string[] };
  const plans: Plan[] = [];
  for (const p of pairs) {
    const manual = byId.get(p.manual.id)!;
    const card = byId.get(p.card.id)!;
    const name = `${manual.member.firstName} ${manual.member.lastName ?? ""}`.trim();
    // The unpaid cash invoice the approval wrote alongside the duplicate.
    const windowMs = 2 * 60 * 1000;
    const invoices = await prisma.transaction.findMany({
      where: {
        clubId: manual.member.clubId,
        memberId: manual.memberId,
        manual: true,
        status: "PENDING",
        type: "INVOICE",
        stripeInvoiceId: null,
        stripeSubscriptionId: null,
        amount: manual.price,
        createdAt: {
          gte: new Date(manual.createdAt.getTime() - windowMs),
          lte: new Date(manual.createdAt.getTime() + windowMs),
        },
      },
      select: { id: true, amount: true, description: true, createdAt: true },
    });
    console.log(`→ ${name} (${manual.memberId}) — ${manual.membership?.name ?? "?"}`);
    console.log(`    CANCEL  cash  ${manual.id} · ${manual.optionLabel} · $${Number(manual.price).toFixed(2)} · MANUAL · created ${fmt(manual.createdAt)} · notes "${manual.notes ?? ""}"`);
    console.log(`    KEEP    card  ${card.id} · ${card.optionLabel} · $${Number(card.price).toFixed(2)} · ${card.stripeSubscriptionId} (${card.stripeStatus ?? card.status}) · created ${fmt(card.createdAt)}`);
    if (invoices.length === 0) console.log("    unpaid cash invoice: none found");
    for (const t of invoices) {
      console.log(
        `    ${VOID_INVOICES ? "VOID   " : "LEAVE  "} unpaid cash invoice ${t.id} · $${Number(t.amount).toFixed(2)} · "${t.description ?? ""}" · ${fmt(t.createdAt)}` +
          (VOID_INVOICES ? "" : "  (pass --void-invoices to void)"),
      );
    }
    plans.push({ manualId: manual.id, cardId: card.id, clubId: manual.member.clubId, memberId: manual.memberId, name, invoiceIds: invoices.map((t) => t.id) });
  }

  if (!APPLY) {
    console.log(`\nDry run only — nothing written. Re-run with --apply${VOID_INVOICES ? " --void-invoices" : ""} to write.`);
    return;
  }

  let canceled = 0;
  let voided = 0;
  for (const p of plans) {
    const now = new Date();
    // Guarded WHERE: still active, still MANUAL, still no Stripe id.
    const res = await prisma.memberSubscription.updateMany({
      where: { id: p.manualId, status: "active", billingType: "MANUAL", stripeSubscriptionId: null },
      data: { status: "canceled", canceledAt: now, autoRenew: false, cancelReason: CANCEL_REASON },
    });
    if (res.count === 0) {
      console.log(`  skip ${p.name} — ${p.manualId} is no longer an active, Stripe-free MANUAL row`);
      continue;
    }
    canceled++;
    let voidedHere: string[] = [];
    if (VOID_INVOICES && p.invoiceIds.length) {
      const v = await prisma.transaction.updateMany({
        where: { id: { in: p.invoiceIds }, status: "PENDING", manual: true, stripeInvoiceId: null },
        data: { status: "FAILED", reconciliationStatus: "VOID", notes: `Voided — ${CANCEL_REASON}.` },
      });
      voided += v.count;
      voidedHere = v.count ? p.invoiceIds : [];
    }
    await prisma.billingAuditLog.create({
      data: {
        clubId: p.clubId,
        memberId: p.memberId,
        actorUserId: null,
        action: "DUPLICATE_CASH_MEMBERSHIP_CANCELED",
        before: { subscriptionId: p.manualId, status: "active", duplicateOf: p.cardId },
        after: { subscriptionId: p.manualId, status: "canceled", canceledAt: now.toISOString(), cancelReason: CANCEL_REASON, voidedInvoiceIds: voidedHere },
        note:
          `SCRIPT cancel-duplicate-cash-memberships (2026-09-28): cash membership ${p.manualId} duplicated card ` +
          `membership ${p.cardId} on the same plan (approved in error 2026-09-23). Local row only — Stripe untouched.`,
      },
    });
    await recomputeMemberStatus(p.memberId, p.clubId);
    const after = await prisma.memberSubscription.findUnique({ where: { id: p.manualId }, select: { status: true, canceledAt: true } });
    const card = await prisma.memberSubscription.findUnique({ where: { id: p.cardId }, select: { status: true } });
    const member = await prisma.member.findUnique({ where: { id: p.memberId }, select: { status: true } });
    console.log(`  ✓ ${p.name} — cash ${p.manualId} → ${after?.status} @ ${fmt(after?.canceledAt)}; card ${p.cardId} still ${card?.status}; member ${member?.status}`);
  }
  console.log(`\n${canceled} duplicate(s) canceled${VOID_INVOICES ? `, ${voided} unpaid cash invoice(s) voided` : ""}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
