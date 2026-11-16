// Small helpers for reading slow outside services (Stripe, Plaid) while a page
// is waiting on the answer.
//
// The pattern they replace, found all over the billing reads on 2026-11-15:
//
//     for (const customer of customers) {
//       await stripe.customers.retrieve(customer)        // ~300 ms each,
//       await stripe.customers.listPaymentMethods(...)   // one after another,
//     }                                                  // same customer twice
//
// A family that shares one Stripe customer across three athletes paid for the
// same lookup three times in a row, and a coach paying for eight athletes
// turned one page open into 20+ sequential round trips.
//
// SCOPE RULE: build a memo INSIDE the request handler and let it die with the
// request. Never hold one at module level — on a warm server instance that
// would hand one family's card details to the next viewer.

/**
 * Wrap a keyed async lookup so each key is fetched at most once per memo.
 * Concurrent callers share the in-flight promise. A rejection is cached too:
 * within one request, asking again would only fail the same way more slowly.
 */
export function memoAsync<V>(fn: (key: string) => Promise<V>): (key: string) => Promise<V> {
  const seen = new Map<string, Promise<V>>();
  return (key: string) => {
    let hit = seen.get(key);
    if (!hit) {
      hit = fn(key);
      // The caller decides what a failure means; this only stops Node from
      // reporting an unhandled rejection when nobody has awaited it yet.
      hit.catch(() => undefined);
      seen.set(key, hit);
    }
    return hit;
  };
}

/** Thrown by `withTimeout` when no fallback was given. */
export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} did not answer within ${ms} ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Resolve with `promise`, or give up after `ms`.
 *   - with a `fallback` function: resolves to its value (a page that can
 *     render without the answer);
 *   - without one: rejects with TimeoutError (the caller has an error path).
 * The underlying call is NOT cancelled — only use this for READS.
 */
export function withTimeout<V>(promise: Promise<V>, ms: number, label: string, fallback?: () => V): Promise<V> {
  return new Promise<V>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (fallback) resolve(fallback());
      else reject(new TimeoutError(label, ms));
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Run `fn` over `items` with at most `limit` in flight, keeping input order.
 * For fan-outs that must not open dozens of connections at once.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
