// What Stripe holds as a subscription's stop date, from what Stripe itself
// last told us.
//
// Every webhook is stored whole (stripe_webhook_events). Stripe sends
// customer.subscription.created/updated whenever a subscription is created or
// its cancel_at changes, so the newest one IS the current answer. No Stripe
// call, so a list of fifty members costs one database read (about 10 ms on
// production, 2026-11-25), and nothing has to be written back first.
//
// READ ONLY and never throws. A subscription that isn't in the result is "not
// known", and lib/renewalTruth says what to show then.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/** Stripe subscription id to its stop date, or null = Stripe has none. Missing = not known. */
export type StripeStops = Map<string, Date | null>;

export type StopEvent = { sid: string; cancel_at: string | null; at_period_end: string | null; period_end: string | null; item_period_end: string | null };

/** Pure: one stored event and the stop it describes. */
export function stopFromEvent(e: StopEvent): Date | null {
  const unix = (v: string | null) => {
    const n = Number(v);
    return v != null && v !== "" && Number.isFinite(n) && n > 0 ? new Date(n * 1000) : null;
  };
  // Newer Stripe versions moved current_period_end onto the item.
  return unix(e.cancel_at) ?? (e.at_period_end === "true" ? unix(e.period_end) ?? unix(e.item_period_end) : null);
}

export async function loadStripeStops(subscriptionIds: (string | null | undefined)[]): Promise<StripeStops> {
  const ids = Array.from(new Set(subscriptionIds.filter((x): x is string => !!x)));
  const out: StripeStops = new Map();
  if (ids.length === 0) return out;
  try {
    const rows = await prisma.$queryRaw<StopEvent[]>(Prisma.sql`
      SELECT DISTINCT ON (o->>'id')
        o->>'id' AS sid,
        o->>'cancel_at' AS cancel_at,
        o->>'cancel_at_period_end' AS at_period_end,
        o->>'current_period_end' AS period_end,
        o->'items'->'data'->0->>'current_period_end' AS item_period_end
      FROM (
        SELECT payload->'data'->'object' AS o, "createdAt" AS at
        FROM stripe_webhook_events
        WHERE type IN ('customer.subscription.created', 'customer.subscription.updated')
      ) e
      WHERE o->>'id' IN (${Prisma.join(ids)})
      ORDER BY o->>'id', at DESC`);
    for (const r of rows) out.set(r.sid, stopFromEvent(r));
  } catch (e) {
    console.error("[stripeStops] could not read stored subscription events", e);
  }
  return out;
}

/** For renewalTruth: undefined when Stripe's answer isn't known. */
export function stopOf(stops: StripeStops, subscriptionId: string | null | undefined): Date | null | undefined {
  return subscriptionId && stops.has(subscriptionId) ? stops.get(subscriptionId) : undefined;
}
