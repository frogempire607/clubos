// Simple token-bucket rate limiter for API routes.
//
// Implementation: in-memory map of key -> { count, resetAt }. Keys
// usually combine a route identifier with either the requester's IP
// (unauthenticated routes) or their user id (authenticated routes).
//
// Caveats:
//   * In-memory state is per-process. On a long-running Node server
//     (npm run dev, or self-hosted prod) the limits are global. On
//     Vercel serverless / fly machines, each instance has its own
//     bucket, so the effective limit is `limit × number_of_warm_instances`.
//     For the AthletixOS scale (small clubs, a few hundred users per
//     club) this is acceptable best-effort throttling. If we ever
//     deploy to a horizontally-scaled production environment with
//     real abuse risk, swap this implementation for @upstash/ratelimit
//     + Redis — the call sites in routes/* don't have to change.
//   * Keys are stored unbounded. We sweep expired entries on every
//     `rateLimit` call so the map can't grow without bound for routes
//     with a hot-enough request stream, and a periodic janitor runs
//     every 5 minutes to clean cold keys.

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

// Sweep stale buckets every 5 minutes so a process that hasn't been
// hit in a while doesn't grow without bound from one-off abuse keys.
let janitor: NodeJS.Timeout | null = null;
function ensureJanitor() {
  if (janitor) return;
  // unref() so the interval doesn't keep `next dev` alive after the
  // user Ctrl-C's the dev server.
  janitor = setInterval(() => {
    const now = Date.now();
    for (const [key, b] of buckets.entries()) {
      if (b.resetAt <= now) buckets.delete(key);
    }
  }, 5 * 60 * 1000);
  if (typeof janitor.unref === "function") janitor.unref();
}

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
};

// Test-only — clears the buckets so suites don't bleed state between cases.
export function _resetRateLimitForTests() {
  buckets.clear();
}

// Returns a rate-limit decision. Pass the same `key` for every request
// you want to count against the same bucket.
//
// Example: `await rateLimit({ key: \`login:\${ip}\`, limit: 5, windowMs: 60_000 })`
export function rateLimit({
  key,
  limit,
  windowMs,
}: {
  key: string;
  limit: number;
  windowMs: number;
}): RateLimitResult {
  ensureJanitor();
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    const fresh: Bucket = { count: 1, resetAt: now + windowMs };
    buckets.set(key, fresh);
    return {
      allowed: true,
      remaining: limit - 1,
      resetAt: fresh.resetAt,
      retryAfterSeconds: 0,
    };
  }

  if (existing.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: existing.resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  existing.count += 1;
  return {
    allowed: true,
    remaining: limit - existing.count,
    resetAt: existing.resetAt,
    retryAfterSeconds: 0,
  };
}

// Best-effort requester identifier for unauthenticated routes. Picks
// the first IP in X-Forwarded-For (set by Vercel + most reverse
// proxies), falls back to x-real-ip, then to "unknown". The "unknown"
// bucket can be a noisy neighbor target in pure-local dev — that's
// acceptable since prod runs behind a proxy that always sets these
// headers.
export function ipFromRequest(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const xri = req.headers.get("x-real-ip");
  if (xri) return xri;
  return "unknown";
}

// Convenience: wraps a NextResponse.json 429 with Retry-After header.
import { NextResponse } from "next/server";
export function rateLimitedResponse(result: RateLimitResult, message?: string) {
  return NextResponse.json(
    {
      error:
        message ||
        "Too many requests. Please slow down and try again in a moment.",
      retryAfterSeconds: result.retryAfterSeconds,
    },
    {
      status: 429,
      headers: {
        "retry-after": String(result.retryAfterSeconds),
        "x-ratelimit-reset": String(result.resetAt),
      },
    },
  );
}
