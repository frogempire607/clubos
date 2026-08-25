// Autopay transitions — turning card billing on or off for one member.
//
// §8.6 / decisions D6 and D8.
//
// ── These are lifecycle events, not a toggle ────────────────────────────────
//
// "Autopay" has no column, and deliberately gets none: it is derivable
// (`billingType === "MANUAL" || stripeSubscriptionId === null`), and a stored
// flag that can disagree with Stripe is worse than a derived one. Turning it
// OFF cancels a Stripe subscription; turning it ON creates one. Neither is a
// field write.
//
// ── Why the transition completes synchronously (D6) ─────────────────────────
//
// The obvious design was "set cancel_at_period_end, then flip the row to MANUAL
// when customer.subscription.deleted arrives". That does not work: the webhook
// does an unconditional updateMany setting `status: "canceled"` on any row
// matching the subscription id, so the handoff would land as a CANCELLATION —
// the member would read as churned and recomputeMemberStatus would flip them
// inactive.
//
// So we do not wait for it. `cancel_at_period_end: true` means Stripe will not
// bill again and the current period is already paid, so everything is known at
// transition time: read back `current_period_end`, then in ONE write set
// MANUAL, stamp paidThroughDate, and null the subscription id. The later
// deletion webhook then matches no row and is a harmless no-op.
//
// Checked rather than assumed: `invoice.paid` has a metadata fallback that
// resolves the member when the row lookup misses, and charge.refunded /
// charge.dispute.created resolve by charge, not subscription — so nulling the
// id orphans no money event arriving afterwards.

import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { recurringUnitWithFee } from "@/lib/fees";
import { billingPeriodToStripeInterval } from "@/lib/stripe";
import { resolveChargeablePaymentMethodId } from "@/lib/memberCard";
import { ensureMembershipProduct } from "@/lib/stripeCatalog";
import { writeBillingAudit } from "@/lib/billingAudit";
import {
  recordSubscriptionEvent,
  SUBSCRIPTION_EVENT_KIND,
  type SubscriptionEventSource,
} from "@/lib/subscriptionEvents";
import crypto from "crypto";

export type AutopayResult =
  | { ok: true; direction: "off" | "on"; effectiveAt: Date; message: string }
  | { ok: false; code: string; error: string };

type Actor = { userId: string | null; source: SubscriptionEventSource };

/**
 * Autopay OFF — Stripe stops billing at the end of the paid period, and the
 * club collects from then on.
 *
 * Refuses when no period end can be established. Without one nobody knows when
 * cash is next due, and the member silently stops being billed by anybody.
 */
export async function turnAutopayOff(
  memberSubscriptionId: string,
  clubId: string,
  actor: Actor,
): Promise<AutopayResult> {
  const sub = await prisma.memberSubscription.findFirst({
    where: { id: memberSubscriptionId, member: { clubId, deletedAt: null } },
    select: {
      id: true, memberId: true, price: true, optionLabel: true, billingType: true,
      stripeSubscriptionId: true, currentPeriodEnd: true, paidThroughDate: true,
      member: { select: { id: true, club: { select: { stripeAccountId: true } } } },
    },
  });
  if (!sub) return { ok: false, code: "NOT_FOUND", error: "That membership no longer exists." };
  if (!sub.stripeSubscriptionId) {
    return { ok: false, code: "ALREADY_OFF", error: "This membership isn't billed by card — autopay is already off." };
  }
  const acct = sub.member.club.stripeAccountId;
  if (!acct) return { ok: false, code: "NO_STRIPE", error: "The club isn't connected to Stripe." };

  let periodEnd: number | null = null;
  try {
    const updated = await stripe.subscriptions.update(
      sub.stripeSubscriptionId,
      { cancel_at_period_end: true },
      { stripeAccount: acct },
    );
    periodEnd = (updated as unknown as { current_period_end?: number }).current_period_end ?? null;
  } catch (e) {
    // Hard-fail: never record autopay as off if Stripe did not agree.
    return { ok: false, code: "STRIPE_FAILED", error: `Stripe did not accept the change: ${String(e)}` };
  }

  const endsAt = periodEnd ? new Date(periodEnd * 1000) : (sub.currentPeriodEnd ?? sub.paidThroughDate);
  if (!endsAt) {
    return {
      ok: false,
      code: "NO_PERIOD_END",
      error:
        "Stripe didn't return a period end and none is stored, so there is no way to say when cash becomes due. " +
        "Reconcile this subscription from Stripe first. Nothing was changed locally.",
    };
  }

  await prisma.memberSubscription.update({
    where: { id: sub.id },
    data: {
      billingType: "MANUAL",
      // autoRenew is deliberately NOT touched. Autopay off means the club
      // collects cash from here on, not that the membership is ending — and
      // `autoRenew: false` is read everywhere as "this one stops". Writing it
      // here would manufacture the exact lie §8.0.8 was about: eleven rows
      // claiming to renew next to an end date.
      paidThroughDate: endsAt,
      currentPeriodEnd: endsAt,
      // The deletion webhook will match nothing after this, which is the point:
      // it would otherwise mark this row canceled and churn the member.
      stripeSubscriptionId: null,
      stripePriceId: null,
      notes: `Autopay turned off — card billing stops ${endsAt.toISOString().slice(0, 10)}; the club collects after that.`,
    },
  });

  await recordSubscriptionEvent({
    clubId,
    memberSubscriptionId: sub.id,
    memberId: sub.memberId,
    kind: SUBSCRIPTION_EVENT_KIND.PLAN_CHANGED,
    fromPlan: sub.optionLabel,
    toPlan: sub.optionLabel,
    // Equal amounts, deliberately: the money did not change, only the
    // mechanism. Churn reporting must not read this as a price movement.
    fromAmount: String(sub.price),
    toAmount: String(sub.price),
    actorUserId: actor.userId,
    source: actor.source,
    detail: { autopay: "off", stripeSubscriptionId: sub.stripeSubscriptionId, endsAt: endsAt.toISOString() },
  });
  await writeBillingAudit({
    clubId, memberId: sub.memberId, actorUserId: actor.userId,
    action: "AUTOPAY_OFF",
    before: { billingType: sub.billingType, stripeSubscriptionId: sub.stripeSubscriptionId },
    after: { billingType: "MANUAL", paidThroughDate: endsAt.toISOString() },
    note: "cancel_at_period_end set on Stripe; row moved to MANUAL in the same step.",
  });

  return {
    ok: true,
    direction: "off",
    effectiveAt: endsAt,
    message: `Autopay off. The card stops after ${endsAt.toISOString().slice(0, 10)}; the club collects $${Number(sub.price).toFixed(2)} from then on.`,
  };
}

/**
 * Autopay ON — create a Stripe subscription that starts charging when the
 * currently-paid period runs out.
 *
 * Never charges today. `trial_end` is the paid-through date, so the first charge
 * lands when the member's existing coverage ends — the same discipline the
 * migration-approve path uses.
 */
export async function turnAutopayOn(
  memberSubscriptionId: string,
  clubId: string,
  actor: Actor,
): Promise<AutopayResult> {
  const sub = await prisma.memberSubscription.findFirst({
    where: { id: memberSubscriptionId, member: { clubId, deletedAt: null } },
    select: {
      id: true, memberId: true, price: true, optionLabel: true, billingPeriod: true,
      billingType: true, stripeSubscriptionId: true,
      currentPeriodEnd: true, paidThroughDate: true, membershipId: true,
      member: {
        select: {
          id: true, stripeCustomerId: true, stripeSetupCustomerId: true, stripeSetupPaymentMethodId: true,
          club: { select: { id: true, stripeAccountId: true, stripeChargesEnabled: true, passProcessingFees: true } },
        },
      },
      membership: { select: { id: true, clubId: true, name: true, description: true, stripeProductId: true, stripePriceIds: true } },
    },
  });
  if (!sub) return { ok: false, code: "NOT_FOUND", error: "That membership no longer exists." };
  if (sub.stripeSubscriptionId) {
    return { ok: false, code: "ALREADY_ON", error: "This membership is already billed by card." };
  }
  const club = sub.member.club;
  if (!club.stripeAccountId || !club.stripeChargesEnabled) {
    return { ok: false, code: "NO_STRIPE", error: "The club hasn't finished setting up online payments." };
  }

  const customerId = sub.member.stripeSetupCustomerId ?? sub.member.stripeCustomerId;
  if (!customerId) {
    return {
      ok: false, code: "CARD_SETUP_REQUIRED",
      error: "No saved payment method on file. Send the card-setup link first — nothing was changed.",
    };
  }
  // The Mack Munroe guard: a family that replaced their card leaves a stale
  // pointer, and Stripe then errors "payment method must be attached".
  const pmId = await resolveChargeablePaymentMethodId(
    customerId, club.stripeAccountId, sub.member.stripeSetupPaymentMethodId,
  );
  if (!pmId) {
    return {
      ok: false, code: "CARD_SETUP_REQUIRED",
      error: "The saved payment method is no longer usable. Collect a new card first — nothing was changed.",
    };
  }

  // The FIRST charge lands when the paid period ends, never today.
  const anchor = sub.paidThroughDate ?? sub.currentPeriodEnd;
  const trialEnd = anchor && anchor.getTime() > Date.now() + 60_000
    ? Math.floor(anchor.getTime() / 1000)
    : undefined;

  // The member's OWN price, passed through the club's fee passthrough. Reading
  // the plan's option price here would silently reprice anyone on an override.
  const amountCents = recurringUnitWithFee(
    Math.round(Number(sub.price) * 100), club.passProcessingFees,
  );
  const interval = billingPeriodToStripeInterval(sub.billingPeriod ?? "MONTHLY")
    ?? { interval: "month" as const, interval_count: 1 };
  // Subscription price_data requires a real Product — unlike Checkout, there is
  // no inline `product_data` here. Reuse the plan's catalog Product so every
  // member on a plan shares one, and fall back to a plan-scoped product only if
  // catalog sync hiccups; never fail the transition over a catalog miss.
  let productId = sub.membership
    ? await ensureMembershipProduct(
        { id: sub.membership.id, clubId: sub.membership.clubId, name: sub.membership.name,
          description: sub.membership.description, stripeProductId: sub.membership.stripeProductId,
          stripePriceIds: sub.membership.stripePriceIds },
        { id: club.id, stripeAccountId: club.stripeAccountId, stripeChargesEnabled: club.stripeChargesEnabled },
      )
    : null;
  if (!productId) {
    try {
      const product = await stripe.products.create(
        {
          name: sub.membership?.name ?? sub.optionLabel,
          metadata: { athletixMembershipId: sub.membershipId, clubId, kind: "membership" },
        },
        { stripeAccount: club.stripeAccountId },
      );
      productId = product.id;
    } catch (e) {
      return { ok: false, code: "STRIPE_FAILED", error: `Could not prepare the Stripe product: ${String(e)}` };
    }
  }

  let created;
  try {
    created = await stripe.subscriptions.create(
      {
        customer: customerId,
        default_payment_method: pmId,
        items: [{
          price_data: {
            currency: "usd",
            unit_amount: amountCents,
            recurring: interval,
            product: productId,
          },
        }],
        ...(trialEnd ? { trial_end: trialEnd } : {}),
        application_fee_percent: 0,
        metadata: { memberSubscriptionId: sub.id, memberId: sub.memberId, clubId },
      },
      {
        stripeAccount: club.stripeAccountId,
        // Params-hashed, not static: a static per-subscription key is
        // permanently burned by one failure and every corrected retry is then
        // rejected (Mack Munroe, 2026-07-15).
        idempotencyKey: `aox-autopay-on-${sub.id}-${crypto
          .createHash("sha256")
          .update(JSON.stringify({ amountCents, trialEnd: trialEnd ?? null, pm: pmId }))
          .digest("hex").slice(0, 12)}`,
      },
    );
  } catch (e) {
    return { ok: false, code: "STRIPE_FAILED", error: `Could not start card billing: ${String(e)}` };
  }

  await prisma.memberSubscription.update({
    where: { id: sub.id },
    data: {
      billingType: "RECURRING",
      autoRenew: true,
      stripeSubscriptionId: created.id,
      stripePriceId: created.items?.data?.[0]?.price?.id ?? null,
      ...(productId ? { stripeProductId: productId } : {}),
      stripeStatus: created.status,
      notes: `Autopay turned on — first card charge ${anchor ? anchor.toISOString().slice(0, 10) : "at the next cycle"}.`,
    },
  });

  await recordSubscriptionEvent({
    clubId, memberSubscriptionId: sub.id, memberId: sub.memberId,
    kind: SUBSCRIPTION_EVENT_KIND.PLAN_CHANGED,
    fromPlan: sub.optionLabel, toPlan: sub.optionLabel,
    fromAmount: String(sub.price), toAmount: String(sub.price),
    actorUserId: actor.userId, source: actor.source,
    detail: { autopay: "on", stripeSubscriptionId: created.id, firstChargeAt: anchor?.toISOString() ?? null },
  });
  await writeBillingAudit({
    clubId, memberId: sub.memberId, actorUserId: actor.userId,
    action: "AUTOPAY_ON",
    before: { billingType: sub.billingType, stripeSubscriptionId: null },
    after: { billingType: "RECURRING", stripeSubscriptionId: created.id, firstChargeAt: anchor?.toISOString() ?? null },
    note: `Charged at the member's own price ($${Number(sub.price).toFixed(2)}), not the plan's option price.`,
  });

  const charged = (amountCents / 100).toFixed(2);
  return {
    ok: true,
    direction: "on",
    effectiveAt: anchor ?? new Date(),
    message: anchor
      ? `Autopay on. First card charge of $${charged} on ${anchor.toISOString().slice(0, 10)}.`
      : `Autopay on. First card charge of $${charged} at the next cycle.`,
  };
}

/**
 * What the confirm dialog says, computed from live values — never from a
 * snapshot taken when a member filed the request.
 *
 * §8.6.3 requires the owner to see the exact next charge date and amount
 * BEFORE approving. A payload written days earlier can be stale by then (a
 * price change, a period that rolled, a card that was removed), and a dialog
 * that states the wrong number is worse than one that states none.
 */
export type AutopayPreview = {
  direction: "off" | "on";
  /** Already possible? False means approving would fail — say so up front. */
  ready: boolean;
  blockedReason: string | null;
  effectiveAt: Date | null;
  /** What the CARD is charged, fee passthrough included. Null on the off path. */
  chargeAmount: number | null;
  /** The sticker price. What the club collects in cash on the off path. */
  price: number;
  sentence: string;
};

export async function previewAutopayChange(
  memberSubscriptionId: string,
  clubId: string,
  direction: "off" | "on",
): Promise<AutopayPreview | null> {
  const sub = await prisma.memberSubscription.findFirst({
    where: { id: memberSubscriptionId, member: { clubId, deletedAt: null } },
    select: {
      price: true, billingPeriod: true, stripeSubscriptionId: true,
      currentPeriodEnd: true, paidThroughDate: true,
      member: {
        select: {
          stripeCustomerId: true, stripeSetupCustomerId: true, stripeSetupPaymentMethodId: true,
          club: { select: { stripeAccountId: true, stripeChargesEnabled: true, passProcessingFees: true } },
        },
      },
    },
  });
  if (!sub) return null;

  const price = Number(sub.price);
  const club = sub.member.club;
  const anchor = sub.paidThroughDate ?? sub.currentPeriodEnd;
  const every = periodPhrase(sub.billingPeriod);

  if (direction === "off") {
    if (!sub.stripeSubscriptionId) {
      return {
        direction, ready: false, blockedReason: "This membership isn't billed by card.",
        effectiveAt: null, chargeAmount: null, price,
        sentence: "Autopay is already off — the club collects this one directly.",
      };
    }
    // The date shown is our cached period end. The real transition re-reads it
    // from Stripe, so the two can differ by a reconciliation lag; the dialog
    // says "around" rather than pretending to a precision it does not have.
    return {
      direction, ready: true, blockedReason: null,
      effectiveAt: anchor, chargeAmount: null, price,
      sentence: anchor
        ? `Autopay off — Stripe will stop after ${dayStr(anchor)}. From then the club collects $${price.toFixed(2)} ${every} by cash or check.`
        : `Autopay off — Stripe will stop at the end of the current period. From then the club collects $${price.toFixed(2)} ${every} by cash or check.`,
    };
  }

  if (sub.stripeSubscriptionId) {
    return {
      direction, ready: false, blockedReason: "This membership is already billed by card.",
      effectiveAt: null, chargeAmount: null, price,
      sentence: "Autopay is already on.",
    };
  }
  if (!club.stripeAccountId || !club.stripeChargesEnabled) {
    return {
      direction, ready: false, blockedReason: "The club hasn't finished setting up online payments.",
      effectiveAt: anchor, chargeAmount: null, price,
      sentence: "Card billing isn't available until the club finishes Stripe setup.",
    };
  }

  const customerId = sub.member.stripeSetupCustomerId ?? sub.member.stripeCustomerId;
  const pmId = customerId
    ? await resolveChargeablePaymentMethodId(customerId, club.stripeAccountId, sub.member.stripeSetupPaymentMethodId)
    : null;
  const charge = recurringUnitWithFee(Math.round(price * 100), club.passProcessingFees) / 100;

  if (!pmId) {
    return {
      direction, ready: false,
      blockedReason: "No usable card on file — send the card-setup link first.",
      effectiveAt: anchor, chargeAmount: charge, price,
      sentence: "Autopay can't start yet: there's no usable card on file. Send the card-setup link, then approve.",
    };
  }
  return {
    direction, ready: true, blockedReason: null,
    effectiveAt: anchor, chargeAmount: charge, price,
    // The amount shown is what the CARD is charged — sticker plus the club's
    // passthrough. Showing $175 and charging $180.08 is how a dispute starts.
    sentence: anchor
      ? `Autopay on — first card charge $${charge.toFixed(2)} on ${dayStr(anchor)}, then ${every}.`
      : `Autopay on — first card charge $${charge.toFixed(2)} at the next cycle, then ${every}.`,
  };
}

/**
 * §8.6.4 — does this membership continue after the current term.
 *
 * Distinct from autopay: this one ENDS the membership. On a Stripe row it maps
 * to `cancel_at_period_end`, never to a recomputed absolute `cancel_at` — a
 * cancel_at calculated at creation is exactly why eleven rows now claim to
 * renew next to an end date (§8.0.8). Stripe answers with the real period end
 * and that answer, not a local guess, becomes `endDate`.
 */
export async function setAutoRenew(
  memberSubscriptionId: string,
  clubId: string,
  autoRenew: boolean,
  actor: Actor,
): Promise<AutopayResult> {
  const sub = await prisma.memberSubscription.findFirst({
    where: { id: memberSubscriptionId, member: { clubId, deletedAt: null } },
    select: {
      id: true, memberId: true, autoRenew: true, optionLabel: true, price: true,
      billingPeriod: true, minimumTermEndsAt: true,
      stripeSubscriptionId: true, endDate: true, currentPeriodEnd: true, paidThroughDate: true,
      member: { select: { commitmentEndDate: true, club: { select: { stripeAccountId: true } } } },
    },
  });
  if (!sub) return { ok: false, code: "NOT_FOUND", error: "That membership no longer exists." };
  if (sub.autoRenew === autoRenew) {
    return { ok: false, code: "UNCHANGED", error: `Auto-renew is already ${autoRenew ? "on" : "off"}.` };
  }

  // The mid-commitment hazard this used to guard against is gone: OFF now
  // schedules `cancel_at` at the TERM end, so a 3-month member billed monthly
  // stops after three months rather than one. What is still refused is the case
  // where neither a term nor a period end is known — there is then no date to
  // stop on, and inventing one is how a membership ends on the wrong day.

  let endsAt: Date | null = sub.endDate;
  const acct = sub.member.club.stripeAccountId;
  if (sub.stripeSubscriptionId && acct) {
    try {
      if (autoRenew) {
        // Renewal back ON: clear BOTH ways a stop can be scheduled. A row that
        // was stopped at a term end carries `cancel_at`, and clearing only
        // `cancel_at_period_end` would leave it silently still ending.
        await stripe.subscriptions.update(
          sub.stripeSubscriptionId,
          { cancel_at_period_end: false, cancel_at: null },
          { stripeAccount: acct },
        );
        endsAt = null;
      } else {
        endsAt = await applyNonRenewal(
          sub.stripeSubscriptionId,
          acct,
          planNonRenewal(
            {
              minimumTermEndsAt: sub.minimumTermEndsAt,
              commitmentEndDate: sub.member.commitmentEndDate,
              currentPeriodEnd: sub.currentPeriodEnd,
              paidThroughDate: sub.paidThroughDate,
            },
            new Date(),
          ),
        );
      }
    } catch (e) {
      return { ok: false, code: "STRIPE_FAILED", error: `Stripe did not accept the change: ${String(e)}` };
    }
  } else if (autoRenew) {
    // A MANUAL row: renewal on means it stops having an end.
    endsAt = null;
  } else if (!endsAt) {
    endsAt = sub.paidThroughDate ?? sub.currentPeriodEnd;
    if (!endsAt) {
      return {
        ok: false, code: "NO_PERIOD_END",
        error:
          "This membership has no end of period recorded, so there is no date to stop it on. " +
          "Set a paid-through date first. Nothing was changed.",
      };
    }
  }

  await prisma.memberSubscription.update({
    where: { id: sub.id },
    data: { autoRenew, endDate: endsAt },
  });
  await writeBillingAudit({
    clubId, memberId: sub.memberId, actorUserId: actor.userId,
    action: autoRenew ? "AUTO_RENEW_ON" : "AUTO_RENEW_OFF",
    before: { autoRenew: sub.autoRenew, endDate: sub.endDate?.toISOString() ?? null },
    after: { autoRenew, endDate: endsAt?.toISOString() ?? null },
    note: sub.stripeSubscriptionId
      ? "cancel_at_period_end set on Stripe; endDate taken from Stripe's own period end."
      : "Manual subscription — no Stripe object involved.",
  });

  return {
    ok: true,
    direction: autoRenew ? "on" : "off",
    effectiveAt: endsAt ?? new Date(),
    message: autoRenew
      ? "Auto-renew on. This membership continues until someone stops it."
      : `Auto-renew off. This membership ends ${endsAt ? dayStr(endsAt) : "at the end of the current period"}.`,
  };
}

const dayStr = (d: Date) =>
  d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function periodPhrase(period: string | null): string {
  switch ((period ?? "MONTHLY").toUpperCase()) {
    case "WEEKLY": return "every week";
    case "MONTHLY": return "every month";
    case "QUARTERLY": return "every 3 months";
    case "SEMI_ANNUAL": return "every 6 months";
    case "ANNUAL": return "every year";
    default: return "each period";
  }
}

// ── §8.6.6 · "stop at the next period" is not "don't start another term" ─────
//
// One flag, `autoRenew`, has been doing two jobs, and the implementation only
// ever did the first: `cancel_at_period_end`, i.e. stop at the end of the
// current BILLING period.
//
// On a month-to-month membership those are the same thing. On a membership
// billed monthly against a multi-month commitment they are not, and the
// difference is a third of the money: turning auto-renew off on "3 Months"
// ($160/mo, 3-month term) ended it after ONE month.
//
// The settled semantics (owner, 2026-08-25):
//   · The minimum term IS the billing commitment — 3 months charges 3×.
//   · Auto-renew governs what happens AFTER the term, not during it.
//
// So auto-renew OFF means "bill out the term, then stop", which is an absolute
// `cancel_at` at the term end — never a recomputed period end. With no term,
// the period end IS the boundary and `cancel_at_period_end` stays correct.
//
// No new column. `autoRenew` keeps its name and gains its real meaning; the
// "stop now, inside the term" case is a CANCELLATION and belongs to the
// approval queue, where an early termination is recorded rather than implied.

export type NonRenewalPlan =
  /** Bill out the commitment, then stop. Absolute `cancel_at`. */
  | { mode: "TERM_END"; at: Date }
  /** No commitment left to serve — stop at the end of the paid period. */
  | { mode: "PERIOD_END"; at: Date | null };

type NonRenewalInput = {
  minimumTermEndsAt: Date | null;
  /** Legacy rows written before §8.8.1 carry no term; the member row may. */
  commitmentEndDate?: Date | null;
  currentPeriodEnd: Date | null;
  paidThroughDate: Date | null;
};

/**
 * Where a non-renewing subscription should actually stop. Pure — `now` is
 * injected so every branch is testable without waiting for a date to pass.
 */
export function planNonRenewal(sub: NonRenewalInput, now: Date): NonRenewalPlan {
  const term = sub.minimumTermEndsAt ?? sub.commitmentEndDate ?? null;
  // A term already served is not a boundary — it is history. Falling back to
  // the period end is right: they are month-to-month from here.
  if (term && term.getTime() > now.getTime()) return { mode: "TERM_END", at: term };
  return { mode: "PERIOD_END", at: sub.currentPeriodEnd ?? sub.paidThroughDate ?? null };
}

/**
 * Tell Stripe to stop, at the boundary `planNonRenewal` chose, and return the
 * date it will actually stop on — read back from Stripe, never assumed.
 */
export async function applyNonRenewal(
  stripeSubscriptionId: string,
  stripeAccountId: string,
  plan: NonRenewalPlan,
): Promise<Date | null> {
  if (plan.mode === "TERM_END") {
    const updated = await stripe.subscriptions.update(
      stripeSubscriptionId,
      // Absolute, not `cancel_at_period_end`. A period end recomputed at each
      // renewal walks forward forever and never reaches the term.
      { cancel_at: Math.floor(plan.at.getTime() / 1000) },
      { stripeAccount: stripeAccountId },
    );
    const at = (updated as unknown as { cancel_at?: number }).cancel_at;
    return at ? new Date(at * 1000) : plan.at;
  }
  const updated = await stripe.subscriptions.update(
    stripeSubscriptionId,
    { cancel_at_period_end: true },
    { stripeAccount: stripeAccountId },
  );
  const periodEnd = (updated as unknown as { current_period_end?: number }).current_period_end;
  return periodEnd ? new Date(periodEnd * 1000) : plan.at;
}
