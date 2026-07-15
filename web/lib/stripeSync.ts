import type Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { recomputeMemberStatus } from "@/lib/memberStatus";

/**
 * Stripe → AthletixOS reconciliation (Phase B of the payments loop).
 *
 * Reads the club's CONNECTED-account subscriptions and brings AthletixOS in
 * line with what Stripe actually shows, SAFELY:
 *
 *   - Stripe is the billing source of truth. This module NEVER cancels,
 *     recreates, restarts, or reschedules a live subscription.
 *   - For a subscription already linked to a member (by our own metadata or a
 *     stored stripeSubscriptionId), it caches the live facts — status, next
 *     billing date, price/product, card brand+last4, last invoice — onto the
 *     member's MemberSubscription so the owner/member sees the real state.
 *   - For a subscription it CAN'T confidently link (exists in Stripe but no
 *     local subscription row), it writes a review row to `stripe_reconciliations`
 *     with a best-guess member match. The owner confirms; we never auto-create
 *     billing from a guess.
 */

const MAX_PAGES = 25; // 25 * 100 = 2500 subs/club — logs if it caps.

export type ReconcileSummary = {
  ok: boolean;
  error?: string;
  scanned: number;
  linkedUpdated: number; // already-linked subs whose snapshot we refreshed
  flagged: number; // review rows upserted (unmatched)
  capped: boolean;
};

type SubSnapshot = {
  stripeSubscriptionId: string;
  stripeCustomerId: string | null;
  customerEmail: string | null;
  customerName: string | null;
  stripeStatus: string;
  currentPeriodEnd: Date | null;
  priceId: string | null;
  productId: string | null;
  amountCents: number | null;
  interval: string | null;
  snapshot: Record<string, unknown>;
};

function asStr(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function unixToDate(v: number | null | undefined): Date | null {
  return typeof v === "number" && v > 0 ? new Date(v * 1000) : null;
}

// Raw Stripe status → the local MemberSubscription.status vocabulary. Only maps
// unambiguous states; anything else leaves the local status untouched (we still
// store the raw status separately for display).
function localStatusFor(stripeStatus: string): "active" | "past_due" | "canceled" | null {
  switch (stripeStatus) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
      return "canceled";
    default:
      return null;
  }
}

function buildSnapshot(sub: Stripe.Subscription): SubSnapshot {
  const price = sub.items?.data?.[0]?.price ?? null;
  const productId =
    price && typeof price.product === "string"
      ? price.product
      : price && price.product && typeof price.product === "object"
        ? (price.product as { id?: string }).id ?? null
        : null;
  const pm =
    sub.default_payment_method && typeof sub.default_payment_method === "object"
      ? (sub.default_payment_method as Stripe.PaymentMethod)
      : null;
  const inv =
    sub.latest_invoice && typeof sub.latest_invoice === "object"
      ? (sub.latest_invoice as Stripe.Invoice)
      : null;
  const cust =
    sub.customer && typeof sub.customer === "object" ? (sub.customer as Stripe.Customer) : null;

  return {
    stripeSubscriptionId: sub.id,
    stripeCustomerId: typeof sub.customer === "string" ? sub.customer : cust?.id ?? null,
    customerEmail: cust?.email ?? null,
    customerName: cust?.name ?? null,
    stripeStatus: sub.status,
    currentPeriodEnd: unixToDate(sub.current_period_end),
    priceId: price?.id ?? null,
    productId,
    amountCents: price?.unit_amount ?? null,
    interval: price?.recurring?.interval ?? null,
    snapshot: {
      cancelAt: unixToDate(sub.cancel_at)?.toISOString() ?? null,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      trialEnd: unixToDate(sub.trial_end)?.toISOString() ?? null,
      unitAmount: price?.unit_amount ?? null,
      interval: price?.recurring?.interval ?? null,
      intervalCount: price?.recurring?.interval_count ?? null,
      defaultPaymentMethod: pm?.card ? { brand: pm.card.brand, last4: pm.card.last4 } : null,
      latestInvoice: inv
        ? {
            amountPaid: inv.amount_paid,
            paidAt: unixToDate(inv.status_transitions?.paid_at ?? null)?.toISOString() ?? null,
            status: inv.status,
          }
        : null,
      syncedAt: new Date().toISOString(),
    },
  };
}

export async function reconcileClubBilling(clubId: string): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { ok: false, scanned: 0, linkedUpdated: 0, flagged: 0, capped: false };

  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { id: true, stripeAccountId: true, stripeChargesEnabled: true },
  });
  if (!club?.stripeAccountId) {
    return { ...summary, error: "This club hasn't connected Stripe yet." };
  }
  const acct = { stripeAccount: club.stripeAccountId };

  try {
    let startingAfter: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res: Stripe.ApiList<Stripe.Subscription> = await stripe.subscriptions.list(
        {
          limit: 100,
          status: "all",
          ...(startingAfter ? { starting_after: startingAfter } : {}),
          expand: [
            "data.default_payment_method",
            "data.latest_invoice",
            "data.items.data.price",
            "data.customer",
          ],
        },
        acct,
      );

      for (const sub of res.data) {
        summary.scanned++;
        const snap = buildSnapshot(sub);
        const handled = await applySubscription(clubId, sub, snap);
        if (handled === "linked") summary.linkedUpdated++;
        else if (handled === "flagged") summary.flagged++;
      }

      if (!res.has_more) break;
      startingAfter = res.data[res.data.length - 1]?.id;
      if (page === MAX_PAGES - 1 && res.has_more) {
        summary.capped = true;
        console.warn(`[stripeSync] reconcile capped at ${MAX_PAGES} pages for club ${clubId}`);
      }
    }
    summary.ok = true;
    return summary;
  } catch (e) {
    console.error(`[stripeSync] reconcile failed for club ${clubId}:`, e);
    return { ...summary, error: String(e) };
  }
}

// Returns "linked" if we updated a matched member subscription, "flagged" if we
// queued it for owner review, "skipped" otherwise.
async function applySubscription(
  clubId: string,
  sub: Stripe.Subscription,
  snap: SubSnapshot,
): Promise<"linked" | "flagged" | "skipped"> {
  // 1) Confident match: our own metadata points at a MemberSubscription row, or
  //    the subscription id is already stored locally.
  const metaSubId = asStr(sub.metadata?.memberSubscriptionId);
  let memberSub =
    (metaSubId
      ? await prisma.memberSubscription.findFirst({
          where: { id: metaSubId, member: { clubId } },
          select: { id: true, memberId: true, stripePriceId: true },
        })
      : null) ??
    (await prisma.memberSubscription.findFirst({
      where: { stripeSubscriptionId: sub.id, member: { clubId } },
      select: { id: true, memberId: true, stripePriceId: true },
    }));

  if (memberSub) {
    const local = localStatusFor(snap.stripeStatus);
    await prisma.memberSubscription.update({
      where: { id: memberSub.id },
      data: {
        stripeSubscriptionId: sub.id,
        stripeStatus: snap.stripeStatus,
        currentPeriodEnd: snap.currentPeriodEnd,
        stripeSnapshot: snap.snapshot as object,
        ...(snap.priceId ? { stripePriceId: snap.priceId } : {}),
        ...(snap.productId ? { stripeProductId: snap.productId } : {}),
        ...(local ? { status: local } : {}),
      },
    });
    // Keep the member's own stored customer id populated for the billing portal.
    if (snap.stripeCustomerId) {
      await prisma.member.updateMany({
        where: { id: memberSub.memberId, clubId, stripeCustomerId: null },
        data: { stripeCustomerId: snap.stripeCustomerId },
      });
    }
    await recomputeMemberStatus(memberSub.memberId, clubId);
    // If a review row existed for this sub, it's resolved now.
    await prisma.stripeReconciliation.updateMany({
      where: { stripeSubscriptionId: sub.id, clubId, status: "OPEN" },
      data: { status: "LINKED", resolvedMemberId: memberSub.memberId, resolvedAt: new Date() },
    });
    return "linked";
  }

  // 2) No local subscription row → suggest a member match but DO NOT mutate.
  const metaMemberId = asStr(sub.metadata?.memberId) ?? asStr(sub.metadata?.migrationMemberId);
  let suggestedMemberId: string | null = null;
  let confidence: "EXACT" | "CUSTOMER" | "EMAIL" | "NONE" = "NONE";

  if (metaMemberId) {
    const m = await prisma.member.findFirst({ where: { id: metaMemberId, clubId }, select: { id: true } });
    if (m) {
      suggestedMemberId = m.id;
      confidence = "EXACT";
    }
  }
  if (!suggestedMemberId && snap.stripeCustomerId) {
    const m = await prisma.member.findFirst({
      where: {
        clubId,
        OR: [{ stripeCustomerId: snap.stripeCustomerId }, { stripeSetupCustomerId: snap.stripeCustomerId }],
      },
      select: { id: true },
    });
    if (m) {
      suggestedMemberId = m.id;
      confidence = "CUSTOMER";
    }
  }
  if (!suggestedMemberId && snap.customerEmail) {
    const m = await prisma.member.findFirst({
      where: {
        clubId,
        deletedAt: null,
        OR: [{ email: snap.customerEmail }, { guardianEmail: snap.customerEmail }],
      },
      select: { id: true },
    });
    if (m) {
      suggestedMemberId = m.id;
      confidence = "EMAIL";
    }
  }

  const data = {
    clubId,
    stripeCustomerId: snap.stripeCustomerId,
    customerEmail: snap.customerEmail,
    customerName: snap.customerName,
    stripeStatus: snap.stripeStatus,
    amountCents: snap.amountCents,
    interval: snap.interval,
    priceId: snap.priceId,
    productId: snap.productId,
    currentPeriodEnd: snap.currentPeriodEnd,
    suggestedMemberId,
    matchConfidence: confidence,
    snapshot: snap.snapshot as object,
  };
  // Upsert by subscription id; don't clobber an owner's LINKED/IGNORED decision.
  const existing = await prisma.stripeReconciliation.findUnique({
    where: { stripeSubscriptionId: sub.id },
    select: { id: true, status: true },
  });
  if (existing) {
    if (existing.status === "OPEN") {
      await prisma.stripeReconciliation.update({ where: { id: existing.id }, data });
    }
  } else {
    await prisma.stripeReconciliation.create({ data: { ...data, stripeSubscriptionId: sub.id } });
  }
  return "flagged";
}

// ── Charge-level reconciliation (2026-07-15, billing-truth batch) ───────────
// Compares EVERY Stripe charge on the connected account against local
// Transactions. READ-ONLY: it reports; it never creates revenue rows (missing
// Transactions are backfilled only via the allowlisted owner-approved script,
// scripts/backfill-stripe-transactions.ts). The single write path here is
// fillChargeFees(), which only fills null Stripe-derived fee/net/charge-id
// columns on rows ALREADY matched to a Stripe charge.

export type ChargeComparison = {
  ok: boolean;
  error?: string;
  scannedCharges: number;
  matched: number;
  /** Stripe charges with NO local Transaction — missing revenue. */
  missingLocal: Array<{
    chargeId: string;
    paymentIntentId: string | null;
    invoiceId: string | null;
    amount: number;
    fee: number | null;
    net: number | null;
    customerEmail: string | null;
    description: string | null;
    created: string;
    refunded: boolean;
  }>;
  /** Local rows claiming Stripe money that match NO Stripe charge. */
  unmatchedLocal: Array<{ transactionId: string; amount: number; description: string | null; createdAt: string }>;
  /** Matched rows still missing exact fee/net (backfillable safely). */
  feeGaps: Array<{ transactionId: string; chargeId: string; fee: number; net: number }>;
  /** Multiple local rows sharing one Stripe payment — double-counted revenue. */
  duplicates: Array<{ key: string; transactionIds: string[] }>;
  /** Stripe refunds with no local REFUNDED row. */
  unrecordedRefunds: Array<{ chargeId: string; amountRefunded: number }>;
  capped: boolean;
};

export async function compareClubCharges(clubId: string): Promise<ChargeComparison> {
  const empty: Omit<ChargeComparison, "ok" | "error"> = {
    scannedCharges: 0,
    matched: 0,
    missingLocal: [],
    unmatchedLocal: [],
    feeGaps: [],
    duplicates: [],
    unrecordedRefunds: [],
    capped: false,
  };
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { stripeAccountId: true },
  });
  if (!club?.stripeAccountId) return { ok: false, error: "Stripe is not connected", ...empty };
  const acct = club.stripeAccountId;

  const result: ChargeComparison = { ok: true, ...empty };

  // Local Stripe-claimed rows, indexed by every Stripe id they carry.
  const localRows = await prisma.transaction.findMany({
    where: {
      clubId,
      OR: [{ paymentSource: "STRIPE" }, { paymentMethod: "STRIPE" }],
      NOT: { reconciliationStatus: "VOID" },
    },
    select: {
      id: true,
      amount: true,
      description: true,
      createdAt: true,
      status: true,
      stripeChargeId: true,
      stripePaymentIntentId: true,
      stripeInvoiceId: true,
      stripeFeeAmount: true,
    },
  });
  const byId = new Map<string, typeof localRows>();
  const claimed = new Set<string>();
  for (const t of localRows) {
    for (const id of [t.stripeChargeId, t.stripePaymentIntentId, t.stripeInvoiceId]) {
      if (!id) continue;
      const arr = byId.get(id) ?? [];
      arr.push(t);
      byId.set(id, arr);
      if (arr.length > 1) {
        const ids = arr.map((r) => r.id);
        if (!result.duplicates.some((d) => d.key === id)) {
          result.duplicates.push({ key: id, transactionIds: ids });
        }
      }
    }
  }

  try {
    let startingAfter: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res: Stripe.ApiList<Stripe.Charge> = await stripe.charges.list(
        {
          limit: 100,
          expand: ["data.balance_transaction"],
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        },
        { stripeAccount: acct },
      );
      for (const ch of res.data) {
        if (ch.status !== "succeeded") continue;
        result.scannedCharges++;
        const piId = typeof ch.payment_intent === "string" ? ch.payment_intent : ch.payment_intent?.id ?? null;
        const invId =
          typeof (ch as unknown as { invoice?: unknown }).invoice === "string"
            ? ((ch as unknown as { invoice: string }).invoice)
            : ((ch as unknown as { invoice?: { id?: string } }).invoice?.id ?? null);
        const bt = ch.balance_transaction;
        const fee = bt && typeof bt === "object" ? bt.fee / 100 : null;
        const net = bt && typeof bt === "object" ? bt.net / 100 : null;

        const local =
          byId.get(ch.id)?.[0] ?? (piId ? byId.get(piId)?.[0] : undefined) ?? (invId ? byId.get(invId)?.[0] : undefined);
        if (local) {
          result.matched++;
          claimed.add(local.id);
          if (local.stripeFeeAmount == null && fee != null && net != null) {
            result.feeGaps.push({ transactionId: local.id, chargeId: ch.id, fee, net });
          }
        } else {
          result.missingLocal.push({
            chargeId: ch.id,
            paymentIntentId: piId,
            invoiceId: invId,
            amount: ch.amount / 100,
            fee,
            net,
            customerEmail: ch.billing_details?.email ?? ch.receipt_email ?? null,
            description: ch.description,
            created: new Date(ch.created * 1000).toISOString(),
            refunded: ch.refunded,
          });
        }
        if (ch.amount_refunded > 0) {
          const hasRefundRow = local
            ? localRows.some((t) => t.status === "REFUNDED" && (t.stripeChargeId === ch.id || t.stripePaymentIntentId === piId))
            : false;
          if (!hasRefundRow) {
            result.unrecordedRefunds.push({ chargeId: ch.id, amountRefunded: ch.amount_refunded / 100 });
          }
        }
      }
      if (!res.has_more) break;
      startingAfter = res.data[res.data.length - 1]?.id;
      if (page === MAX_PAGES - 1) result.capped = true;
    }
  } catch (err) {
    return { ok: false, error: String(err), ...empty };
  }

  // Local Stripe-claimed SUCCEEDED rows never matched by any Stripe charge.
  for (const t of localRows) {
    if (t.status !== "SUCCEEDED") continue;
    if (claimed.has(t.id)) continue;
    if (!t.stripeChargeId && !t.stripePaymentIntentId && !t.stripeInvoiceId) {
      result.unmatchedLocal.push({
        transactionId: t.id,
        amount: Number(t.amount),
        description: t.description,
        createdAt: t.createdAt.toISOString(),
      });
    } else if (!byId.get(t.stripeChargeId ?? "")?.length && !claimed.has(t.id)) {
      // Carries Stripe ids but nothing in Stripe matched them (checkout PI ids
      // are matched via the charge's payment_intent, so a genuinely dangling
      // id lands here).
      result.unmatchedLocal.push({
        transactionId: t.id,
        amount: Number(t.amount),
        description: t.description,
        createdAt: t.createdAt.toISOString(),
      });
    }
  }
  // De-dup unmatchedLocal (both branches can push the same row).
  result.unmatchedLocal = result.unmatchedLocal.filter(
    (v, i, arr) => arr.findIndex((x) => x.transactionId === v.transactionId) === i,
  );

  return result;
}

/**
 * Fill missing Stripe-derived columns (stripeFeeAmount / netAmount /
 * stripeChargeId) on rows already MATCHED to a Stripe charge. Owner-triggered,
 * audit-logged. Touches nothing else — amounts, status, member, and source are
 * never modified here.
 */
export async function fillChargeFees(
  clubId: string,
  gaps: ChargeComparison["feeGaps"],
  actorUserId: string | null,
): Promise<number> {
  let filled = 0;
  for (const g of gaps) {
    const row = await prisma.transaction.findFirst({
      where: { id: g.transactionId, clubId },
      select: { id: true, stripeFeeAmount: true, memberId: true },
    });
    if (!row || row.stripeFeeAmount != null) continue;
    await prisma.transaction.update({
      where: { id: row.id },
      data: { stripeFeeAmount: g.fee, netAmount: g.net, stripeChargeId: g.chargeId },
    });
    await prisma.billingAuditLog.create({
      data: {
        clubId,
        memberId: row.memberId,
        actorUserId,
        action: "TRANSACTION_FEES_FILLED",
        before: { transactionId: row.id, stripeFeeAmount: null },
        after: { transactionId: row.id, stripeFeeAmount: g.fee, netAmount: g.net, stripeChargeId: g.chargeId },
        note: "Exact Stripe fee/net filled from the charge's balance transaction (reconciliation).",
      },
    });
    filled++;
  }
  return filled;
}
