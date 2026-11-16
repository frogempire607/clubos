// One GET shared by every component that asks for the same URL at the same
// moment.
//
// Screens here are assembled from independent cards, and several cards on one
// screen read the same endpoint when they mount (the member profile opened the
// billing read — live Stripe calls and all — from two cards at once; the
// member portal asked for /api/member/portal from the layout and the page).
// Each duplicate is a second serverless invocation, and on a quiet day a
// second COLD one.
//
// Sharing is IN-FLIGHT ONLY: once the answer arrives the entry is dropped, so
// a card that reloads after saving always gets a fresh read. Nothing is cached.

export type SharedResult<T = unknown> = {
  ok: boolean;
  status: number;
  /** Parsed JSON body, or null when the body was empty or not JSON. */
  data: T | null;
};

const inFlight = new Map<string, Promise<SharedResult>>();

export function sharedGet<T = unknown>(url: string, init?: { cache?: RequestCache }): Promise<SharedResult<T>> {
  const hit = inFlight.get(url);
  if (hit) return hit as Promise<SharedResult<T>>;
  const p: Promise<SharedResult> = fetch(url, init)
    .then(async (res) => ({ ok: res.ok, status: res.status, data: await res.json().catch(() => null) }))
    .finally(() => {
      if (inFlight.get(url) === p) inFlight.delete(url);
    });
  inFlight.set(url, p);
  return p as Promise<SharedResult<T>>;
}

/** Test seam: how many requests are in flight right now. */
export function sharedGetInFlight(): number {
  return inFlight.size;
}
