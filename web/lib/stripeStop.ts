// Scheduling (or clearing) the date a Stripe subscription stops.
//
// Stripe has two ways to schedule a stop — `cancel_at` (a date) and
// `cancel_at_period_end` (the end of the current period) — and it now REFUSES
// any update that sends both: "Received both cancel_at_period_end and
// cancel_at parameters. Please pass in only one." (seen 2026-10-15 turning
// auto-renew back on for Weston). Every place that used to send both at once
// goes through here instead, which looks at what the live subscription has and
// sends only the one parameter that undoes it.

import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";

export type LiveStop = { cancel_at_period_end?: boolean | null; cancel_at?: number | null };

/**
 * PURE. The updates to send, in order, so the subscription ends up stopping at
 * `stopAtUnix` (or not at all when null). Never puts both parameters in one
 * update. `extra` (price items, metadata, proration…) rides on the LAST step,
 * or is sent alone when nothing about the stop needs to change.
 */
export function stopSteps(
  live: LiveStop,
  stopAtUnix: number | null,
  extra: Stripe.SubscriptionUpdateParams = {},
): Stripe.SubscriptionUpdateParams[] {
  const steps: Stripe.SubscriptionUpdateParams[] = [];
  if (stopAtUnix == null) {
    if (live.cancel_at_period_end) steps.push({ cancel_at_period_end: false });
    else if (live.cancel_at) steps.push({ cancel_at: "" });
  } else {
    if (live.cancel_at_period_end) steps.push({ cancel_at_period_end: false });
    steps.push({ cancel_at: stopAtUnix });
  }
  const hasExtra = Object.keys(extra).length > 0;
  if (steps.length === 0) return hasExtra ? [{ ...extra }] : [];
  if (hasExtra) steps[steps.length - 1] = { ...extra, ...steps[steps.length - 1] };
  return steps;
}

/**
 * Apply `stopSteps` to a live subscription. Pass `live` when the caller has
 * already retrieved it; otherwise it is fetched. Returns the subscription as
 * Stripe last answered (or the retrieved one when nothing needed sending).
 */
export async function setStripeStop(opts: {
  subscriptionId: string;
  stripeAccount: string;
  stopAt: Date | number | null;
  live?: (LiveStop & Partial<Stripe.Subscription>) | null;
  extra?: Stripe.SubscriptionUpdateParams;
  idempotencyKey?: string;
}): Promise<Stripe.Subscription> {
  const live =
    opts.live ?? (await stripe.subscriptions.retrieve(opts.subscriptionId, {}, { stripeAccount: opts.stripeAccount }));
  const at = opts.stopAt == null ? null : typeof opts.stopAt === "number" ? opts.stopAt : Math.floor(opts.stopAt.getTime() / 1000);
  const steps = stopSteps(live, at, opts.extra ?? {});
  let last = live as Stripe.Subscription;
  for (let i = 0; i < steps.length; i++) {
    const key = opts.idempotencyKey ? (steps.length > 1 ? `${opts.idempotencyKey}-s${i}` : opts.idempotencyKey) : undefined;
    last = await stripe.subscriptions.update(opts.subscriptionId, steps[i], {
      stripeAccount: opts.stripeAccount,
      ...(key ? { idempotencyKey: key } : {}),
    });
  }
  return last;
}
