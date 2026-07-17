// AUTO_CARD execution — charges consented event registrations on their
// scheduled date using the member's saved card, following the same off-session
// PaymentIntent discipline as /api/attendance/charge-card (server-owned
// amounts, idempotency keys, explicit outcomes, exactly one VERIFIED
// Transaction, receipt + audit on confirmed success).
//
// There is no cron in the app, so charges run via lazy sweeps (registrations
// GET / Action Center surfaces call runDueEventCharges) and the secret-gated
// /api/cron/event-charges route an external scheduler can hit. Both paths are
// safe to re-run: a prior PaymentIntent is retrieved (never re-created) and
// Transactions dedupe on the PI id.

import Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { stripe, calculatePlatformFee } from "@/lib/stripe";
import { applyProcessingFee, processingFeeLineItem } from "@/lib/fees";
import { resolveChargeablePaymentMethodId } from "@/lib/memberCard";
import { writeBillingAudit } from "@/lib/billingAudit";
import { sendEmail, sendPaymentReceiptEmail } from "@/lib/email";
import { getAppBaseUrl } from "@/lib/baseUrl";

export type AutoChargeOutcome =
  | "succeeded"
  | "declined"
  | "requires_action"
  | "processing"
  | "skipped"
  | "failed";

export type AutoChargeResult = {
  registrationId: string;
  outcome: AutoChargeOutcome;
  error?: string;
};

type RegForCharge = NonNullable<Awaited<ReturnType<typeof loadRegistration>>>;

function loadRegistration(id: string) {
  return prisma.eventRegistration.findUnique({
    where: { id },
    include: {
      event: { select: { id: true, name: true, publicSlug: true, startsAt: true } },
      member: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          isMinor: true,
          guardianEmail: true,
          stripeCustomerId: true,
          stripeSetupCustomerId: true,
          stripeSetupPaymentMethodId: true,
          user: { select: { email: true } },
        },
      },
      club: {
        select: {
          id: true,
          name: true,
          tier: true,
          stripeAccountId: true,
          stripeChargesEnabled: true,
          passProcessingFees: true,
        },
      },
    },
  });
}

function receiptRecipient(reg: RegForCharge): string | null {
  const m = reg.member;
  if (m) {
    return (m.isMinor ? m.guardianEmail || m.email : m.email) || m.user?.email || reg.email || null;
  }
  return reg.email || null;
}

function consentField(reg: RegForCharge, key: string): string | null {
  const consent = reg.autoChargeConsent as Record<string, unknown> | null;
  const v = consent?.[key];
  return typeof v === "string" ? v : null;
}

/** Record a confirmed Stripe success for the registration (idempotent). */
async function recordSuccess(reg: RegForCharge, pi: Stripe.PaymentIntent, totalCharged: number) {
  const charge = pi.latest_charge && typeof pi.latest_charge === "object" ? (pi.latest_charge as Stripe.Charge) : null;
  const bt =
    charge?.balance_transaction && typeof charge.balance_transaction === "object"
      ? (charge.balance_transaction as Stripe.BalanceTransaction)
      : null;

  const discountCode = consentField(reg, "discountCode");
  const consentDiscountAmount = (reg.autoChargeConsent as Record<string, unknown> | null)?.discountAmount;

  const existing = await prisma.transaction.findFirst({
    where: { stripePaymentIntentId: pi.id },
    select: { id: true },
  });
  const tx =
    existing ??
    (await prisma.transaction.create({
      data: {
        clubId: reg.clubId,
        memberId: reg.memberId,
        amount: totalCharged,
        status: "SUCCEEDED",
        stripePaymentIntentId: pi.id,
        stripeChargeId: charge?.id ?? null,
        description: `Event registration — ${reg.event.name} — ${reg.name} (scheduled card charge)`,
        discountCode,
        discountAmount: typeof consentDiscountAmount === "number" ? consentDiscountAmount : null,
        type: "EVENT",
        eventId: reg.eventId,
        category: "events",
        paymentMethod: "STRIPE",
        paymentSource: "STRIPE",
        reconciliationStatus: "VERIFIED",
        ...(bt ? { stripeFeeAmount: bt.fee / 100, netAmount: bt.net / 100 } : {}),
        txDate: new Date(),
      },
      select: { id: true },
    }));

  await prisma.eventRegistration.update({
    where: { id: reg.id },
    data: {
      status: "PAID",
      amountPaid: totalCharged,
      paidAt: new Date(),
      paidVia: "STRIPE",
      transactionId: tx.id,
      stripePaymentIntentId: pi.id,
      lastChargeError: null,
    },
  });

  await writeBillingAudit({
    clubId: reg.clubId,
    memberId: reg.memberId,
    action: "EVENT_AUTO_CHARGED",
    before: { registrationId: reg.id, status: reg.status, amountDue: Number(reg.amountDue ?? 0) },
    after: { registrationId: reg.id, status: "PAID", transactionId: tx.id, paymentIntentId: pi.id, total: totalCharged },
    note: `Scheduled event-day card charge for ${reg.event.name} confirmed by Stripe.`,
  });

  const to = receiptRecipient(reg);
  if (to) {
    try {
      await sendPaymentReceiptEmail({
        to,
        firstName: reg.member?.firstName || reg.name.split(" ")[0] || "there",
        clubName: reg.club.name,
        description: `${reg.event.name} — event registration (scheduled card charge)`,
        amountPaid: `$${totalCharged.toFixed(2)}`,
        paidAt: new Date(),
        portalUrl: `${getAppBaseUrl()}/member`,
      });
    } catch (e) {
      console.error("event auto-charge receipt failed", e);
    }
  }
}

/** Failure path: mark PAYMENT_FAILED and email a pay-online link (normal billing workflow). */
async function recordFailure(reg: RegForCharge, error: string) {
  await prisma.eventRegistration.update({
    where: { id: reg.id },
    data: {
      status: "PAYMENT_FAILED",
      lastChargeError: error.slice(0, 500),
      chargeAttempts: { increment: 1 },
    },
  });

  await writeBillingAudit({
    clubId: reg.clubId,
    memberId: reg.memberId,
    action: "EVENT_AUTO_CHARGE_FAILED",
    before: { registrationId: reg.id, status: reg.status },
    after: { registrationId: reg.id, status: "PAYMENT_FAILED", error: error.slice(0, 200) },
    note: `Scheduled event-day card charge for ${reg.event.name} failed.`,
  });

  // Mint a fresh Checkout payment link so the client can settle online —
  // the webhook's eventRegistrationId branch completes it.
  if (!reg.club.stripeAccountId || !reg.club.stripeChargesEnabled || !reg.email) return;
  const baseCents = Math.round(Number(reg.amountDue ?? 0) * 100);
  if (baseCents <= 0) return;
  try {
    const baseUrl = getAppBaseUrl();
    const feeItem = processingFeeLineItem(baseCents, reg.club.passProcessingFees);
    const returnPath = reg.event.publicSlug ? `/e/${reg.event.publicSlug}` : "/member";
    const checkout = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        customer_email: reg.email,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: baseCents,
              product_data: { name: reg.event.name, description: "Event registration" },
            },
          },
          ...(feeItem ? [feeItem] : []),
        ],
        success_url: `${baseUrl}${returnPath}?paid=true`,
        cancel_url: `${baseUrl}${returnPath}?canceled=true`,
        payment_intent_data: {
          application_fee_amount: calculatePlatformFee(baseCents, reg.club.tier),
          metadata: { eventRegistrationId: reg.id, eventId: reg.eventId, clubId: reg.clubId },
        },
        metadata: { eventRegistrationId: reg.id, eventId: reg.eventId, clubId: reg.clubId },
      },
      { stripeAccount: reg.club.stripeAccountId },
    );
    await prisma.eventRegistration.update({
      where: { id: reg.id },
      data: {
        paymentUrl: checkout.url,
        stripeCheckoutSessionId: checkout.id,
        invoicedAt: new Date(),
        invoiceCount: { increment: 1 },
      },
    });
    await sendEmail({
      to: reg.email,
      subject: `Payment needed for ${reg.event.name}`,
      html: `
        <div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto">
          <h2 style="color:#1c1917">${reg.event.name}</h2>
          <p style="color:#57534e;line-height:1.6">
            Hi ${reg.name}, we couldn't charge your saved card for
            <strong>${reg.event.name}</strong> ($${Number(reg.amountDue ?? 0).toFixed(2)}).
            You can pay online below, or pay at the event.
          </p>
          <p><a href="${checkout.url}" style="display:inline-block;background:#534AB7;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Pay now</a></p>
        </div>`,
    });
  } catch (e) {
    console.error("event auto-charge payment-link fallback failed", e);
  }
}

/**
 * Record why a charge didn't happen WITHOUT touching chargeAttempts — the
 * idempotency key must not rotate on an unresolved attempt. Best-effort: a
 * failure to write the note must never mask the caller's real outcome.
 */
async function noteChargeError(registrationId: string, message: string): Promise<void> {
  try {
    await prisma.eventRegistration.update({
      where: { id: registrationId },
      data: { lastChargeError: message.slice(0, 500) },
    });
  } catch (e) {
    console.error("event auto-charge: could not record charge error", registrationId, e);
  }
}

/**
 * Charge one SCHEDULED registration now. Re-entrant: a PaymentIntent created
 * by a previous run is retrieved and settled, never duplicated.
 */
export async function chargeEventRegistration(registrationId: string): Promise<AutoChargeResult> {
  const reg = await loadRegistration(registrationId);
  if (!reg || reg.status !== "SCHEDULED") {
    return { registrationId, outcome: "skipped", error: "Not a scheduled registration" };
  }
  const baseAmount = Number(reg.amountDue ?? 0);
  if (!(baseAmount > 0)) {
    // Nothing owed — treat as complete.
    await prisma.eventRegistration.update({ where: { id: reg.id }, data: { status: "REGISTERED" } });
    return { registrationId, outcome: "skipped", error: "No amount due" };
  }
  if (!reg.club.stripeAccountId || !reg.club.stripeChargesEnabled) {
    return { registrationId, outcome: "skipped", error: "Stripe is not enabled for the club" };
  }

  const fee = applyProcessingFee(Math.round(baseAmount * 100), reg.club.passProcessingFees);
  const totalCents = fee.totalCents;
  const totalCharged = totalCents / 100;

  // Settle any prior attempt BEFORE creating anything.
  //
  // Two ways a previous run can have left a live PaymentIntent behind:
  //  (a) we stored its id (happy path), or
  //  (b) the create call succeeded at Stripe but the response never reached us
  //      (timeout / dropped connection) — so we have NO id. That case is why we
  //      also search by metadata: without it, a retry would create a SECOND
  //      charge for the same registration.
  let prior: Stripe.PaymentIntent | null = null;
  if (reg.stripePaymentIntentId) {
    try {
      prior = await stripe.paymentIntents.retrieve(
        reg.stripePaymentIntentId,
        { expand: ["latest_charge.balance_transaction"] },
        { stripeAccount: reg.club.stripeAccountId },
      );
    } catch (e) {
      // We KNOW a PaymentIntent exists and couldn't read it. Never fall through
      // to create another — that's how you bill someone twice. Retry later.
      console.error("event auto-charge prior PI retrieve failed", e);
      await noteChargeError(reg.id, `Could not read the existing payment ${reg.stripePaymentIntentId} — not charging again until it can be verified.`);
      return {
        registrationId,
        outcome: "failed",
        error: "Could not verify the existing payment — not charging again.",
      };
    }
  }
  // `lastChargeError` with no stored PI id is the fingerprint of an ambiguous
  // attempt (b). chargeAttempts covers a rotated-but-unrecorded attempt.
  // Idempotency keys only protect a replay for 24h, so this search — not the
  // key — is what stops a double charge on a stale retry.
  if (!prior && (reg.chargeAttempts > 0 || !!reg.lastChargeError)) {
    // An earlier attempt ended ambiguously. Find whatever it left behind.
    try {
      const found = await stripe.paymentIntents.search(
        {
          query: `metadata['eventRegistrationId']:'${reg.id}'`,
          limit: 10,
          expand: ["data.latest_charge.balance_transaction"],
        },
        { stripeAccount: reg.club.stripeAccountId },
      );
      prior =
        found.data.find((p) => p.status === "succeeded") ??
        found.data.find((p) => p.status === "processing") ??
        null;
      if (prior) {
        console.error(
          `event auto-charge: recovered orphaned PaymentIntent ${prior.id} for registration ${reg.id}`,
        );
      }
    } catch (e) {
      // Search is best-effort (it's eventually consistent and not enabled on
      // every account). Fail CLOSED: without it we cannot prove a prior charge
      // doesn't exist, and charging again risks billing the client twice.
      console.error("event auto-charge PI search failed", e);
      await noteChargeError(
        reg.id,
        "Could not verify whether an earlier charge went through — not charging again. Check Stripe for this registration.",
      );
      return {
        registrationId,
        outcome: "failed",
        error: "Could not verify whether a previous charge exists — not charging again.",
      };
    }
  }
  if (prior) {
    if (prior.status === "succeeded") {
      await recordSuccess(reg, prior, prior.amount / 100);
      return { registrationId, outcome: "succeeded" };
    }
    if (prior.status === "processing") {
      if (prior.id !== reg.stripePaymentIntentId) {
        await prisma.eventRegistration.update({
          where: { id: reg.id },
          data: { stripePaymentIntentId: prior.id },
        });
      }
      return { registrationId, outcome: "processing" };
    }
    // Definitively dead (canceled / requires_payment_method). Only NOW is it
    // safe to rotate the idempotency key — replaying the old key would replay
    // Stripe's cached failure instead of making a real new attempt.
    await prisma.eventRegistration.update({
      where: { id: reg.id },
      data: { chargeAttempts: { increment: 1 }, stripePaymentIntentId: null },
    });
    reg.chargeAttempts += 1;
  }

  if (!reg.member) {
    await recordFailure(reg, "No member record with a saved card is linked to this registration.");
    return { registrationId, outcome: "failed", error: "No linked member" };
  }
  const customerId = reg.member.stripeSetupCustomerId ?? reg.member.stripeCustomerId;
  const paymentMethodId = await resolveChargeablePaymentMethodId(
    customerId,
    reg.club.stripeAccountId,
    reg.member.stripeSetupPaymentMethodId,
  );
  if (!customerId || !paymentMethodId) {
    await recordFailure(reg, "No chargeable saved card on file.");
    return { registrationId, outcome: "failed", error: "No saved card" };
  }

  let pi: Stripe.PaymentIntent;
  try {
    pi = await stripe.paymentIntents.create(
      {
        amount: totalCents,
        currency: "usd",
        customer: customerId,
        payment_method: paymentMethodId,
        off_session: true,
        confirm: true,
        description: `Event registration — ${reg.event.name} — ${reg.name}`,
        expand: ["latest_charge.balance_transaction"],
        application_fee_amount: calculatePlatformFee(totalCents, reg.club.tier),
        metadata: {
          kind: "event_auto_charge",
          eventRegistrationId: reg.id,
          eventId: reg.eventId,
          clubId: reg.clubId,
          memberId: reg.memberId ?? "",
        },
      },
      {
        stripeAccount: reg.club.stripeAccountId,
        idempotencyKey: `aox-eventreg-${reg.id}-a${reg.chargeAttempts}`,
      },
    );
  } catch (err) {
    const e = err as { type?: string; code?: string; message?: string };
    if (e.type === "StripeCardError") {
      const outcome: AutoChargeOutcome = e.code === "authentication_required" ? "requires_action" : "declined";
      await recordFailure(
        reg,
        outcome === "declined"
          ? e.message || "The card was declined."
          : "The card requires the cardholder to authenticate — a payment link was sent instead.",
      );
      return { registrationId, outcome, error: e.message };
    }
    console.error("event auto-charge failed", err);
    // Transient/ambiguous error (timeout, connection drop, 5xx): Stripe may
    // have created AND captured this charge before the response was lost.
    // Leave SCHEDULED so the next sweep retries — but do NOT touch
    // chargeAttempts: the idempotency key must stay identical so the retry
    // REPLAYS this request instead of billing the client a second time.
    // Rotation happens only after a definitively dead PaymentIntent (above).
    await prisma.eventRegistration.update({
      where: { id: reg.id },
      data: { lastChargeError: String(e.message || err).slice(0, 500) },
    });
    return { registrationId, outcome: "failed", error: String(e.message || err) };
  }

  if (pi.status === "processing") {
    await prisma.eventRegistration.update({
      where: { id: reg.id },
      data: { stripePaymentIntentId: pi.id },
    });
    return { registrationId, outcome: "processing" };
  }
  if (pi.status !== "succeeded") {
    await recordFailure(reg, `Stripe returned status ${pi.status}`);
    return { registrationId, outcome: "failed", error: `Stripe status ${pi.status}` };
  }

  await recordSuccess(reg, pi, totalCharged);
  return { registrationId, outcome: "succeeded" };
}

/**
 * Run every due SCHEDULED charge (optionally scoped to a club or event).
 * Sequential on purpose — serverless-friendly, no thundering herd against
 * Stripe. Never throws.
 */
export async function runDueEventCharges(scope?: {
  clubId?: string;
  eventId?: string;
  limit?: number;
}): Promise<{ due: number; results: AutoChargeResult[] }> {
  try {
    const due = await prisma.eventRegistration.findMany({
      where: {
        status: "SCHEDULED",
        scheduledChargeAt: { lte: new Date() },
        ...(scope?.clubId ? { clubId: scope.clubId } : {}),
        ...(scope?.eventId ? { eventId: scope.eventId } : {}),
      },
      orderBy: { scheduledChargeAt: "asc" },
      take: scope?.limit ?? 20,
      select: { id: true },
    });
    const results: AutoChargeResult[] = [];
    for (const r of due) {
      // One registration blowing up (e.g. a unique-constraint race with the
      // webhook) must not abandon everyone behind it in the queue.
      try {
        results.push(await chargeEventRegistration(r.id));
      } catch (e) {
        console.error("event auto-charge threw for registration", r.id, e);
        results.push({ registrationId: r.id, outcome: "failed", error: String(e) });
      }
    }
    return { due: due.length, results };
  } catch (e) {
    console.error("runDueEventCharges failed", e);
    return { due: 0, results: [] };
  }
}
