// One safety net for every screen's data load (audit U3 / U4, 2026-11-15).
//
// About sixty screens start with a spinner and clear it when their request
// answers. On a phone that walks out of signal the request either fails at
// once or never answers at all, and on most of those screens nothing then
// clears the spinner: it turns forever, with no way out but killing the app.
//
// Rather than rewrite sixty screens, the app's own data requests (same-origin
// GETs under /api/) pass through this guard:
//
//   a time limit   a request that has not answered in LOAD_TIMEOUT_MS is
//                  aborted, so "never answers" becomes "failed"
//   an error state a failed or timed-out load is reported to the layout,
//                  which shows a bar saying the server can't be reached
//   a retry        "Try again" on that bar remounts the screen, which re-runs
//                  its loads; it also happens by itself when the phone
//                  reports it is back online
//
// Only GETs: a load is safe to abort and repeat. A POST that saves a payment
// is never timed out or replayed here.
//
// The decisions are PURE functions (tested in scripts/connection-guard-tests.ts);
// installConnectionGuard is the thin part that touches window.fetch.

/** Longer than any data route is allowed to run (the slowest set maxDuration 60 are POSTs or crons). */
export const LOAD_TIMEOUT_MS = 30_000;

export type LoadFailure = "OFFLINE" | "TIMEOUT";

/** Is this one of our own data loads? */
export function isGuardedRequest(r: { url: string; method?: string | null; origin: string }): boolean {
  if ((r.method ?? "GET").toUpperCase() !== "GET") return false;
  let u: URL;
  try {
    u = new URL(r.url, r.origin);
  } catch {
    return false;
  }
  if (u.origin !== r.origin) return false;
  if (!u.pathname.startsWith("/api/")) return false;
  // Sign-in plumbing keeps its own handling: a guard-triggered remount in the
  // middle of signing in or out would be worse than the problem.
  if (u.pathname.startsWith("/api/auth/")) return false;
  return true;
}

/**
 * What a rejected load means.
 *   our timer fired                 → TIMEOUT
 *   the browser could not connect   → OFFLINE (fetch rejects with a TypeError)
 *   the screen cancelled it itself  → null: not a connection problem, say nothing
 */
export function classifyLoadFailure(err: unknown, f: { timedOut: boolean; callerAborted: boolean }): LoadFailure | null {
  if (f.timedOut) return "TIMEOUT";
  if (f.callerAborted) return null;
  const name = (err as { name?: string } | null)?.name;
  if (name === "AbortError") return null;
  if (name === "TypeError") return "OFFLINE";
  return null;
}

export function loadFailureMessage(kind: LoadFailure): string {
  return kind === "TIMEOUT"
    ? "This is taking too long. The connection may have dropped."
    : "Can't reach the server. Check your connection.";
}

type FetchFn = typeof fetch;
type GuardWindow = { fetch: FetchFn; location: { origin: string } };

/**
 * Wrap `win.fetch`. Returns a function that puts the original back.
 * `onFailure` fires for a guarded load that failed; `onSuccess` when one
 * answers (any HTTP status: an answer means the server was reached).
 */
export function installConnectionGuard(
  win: GuardWindow,
  handlers: { onFailure: (kind: LoadFailure) => void; onSuccess: () => void },
  opts: { timeoutMs?: number } = {},
): () => void {
  const original = win.fetch;
  const timeoutMs = opts.timeoutMs ?? LOAD_TIMEOUT_MS;

  const guarded: FetchFn = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const method = init?.method ?? (typeof input === "object" && !(input instanceof URL) ? (input as Request).method : "GET");
    if (!isGuardedRequest({ url, method, origin: win.location.origin })) return original.call(win, input, init);

    const controller = new AbortController();
    const callerSignal = init?.signal ?? null;
    let timedOut = false;
    let callerAborted = false;
    const onCallerAbort = () => {
      callerAborted = true;
      controller.abort();
    };
    if (callerSignal) {
      if (callerSignal.aborted) onCallerAbort();
      else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    return original
      .call(win, input, { ...init, signal: controller.signal })
      .then((res) => {
        handlers.onSuccess();
        return res;
      })
      .catch((err: unknown) => {
        const kind = classifyLoadFailure(err, { timedOut, callerAborted });
        if (kind) handlers.onFailure(kind);
        throw err;
      })
      .finally(() => {
        clearTimeout(timer);
        callerSignal?.removeEventListener("abort", onCallerAbort);
      });
  };

  win.fetch = guarded;
  return () => {
    if (win.fetch === guarded) win.fetch = original;
  };
}

/**
 * Coming back online retries by itself, unless the person has typed
 * something on the screen: a retry remounts it, and their words would go.
 * Then the bar stays and "Try again" is theirs to press.
 */
export function safeToAutoRetry(fields: Array<{ value: string; type?: string | null; defaultValue?: string }>): boolean {
  return !fields.some((f) => {
    const t = (f.type ?? "text").toLowerCase();
    if (["hidden", "checkbox", "radio", "submit", "button", "search"].includes(t)) return false;
    return f.value.trim() !== "" && f.value !== (f.defaultValue ?? "");
  });
}
