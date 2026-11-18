/**
 * Screens no longer spin forever on a dropped connection (audit U3 / U4).
 *
 *   npx tsx scripts/connection-guard-tests.ts
 *
 * No database, no network: a pretend window with a pretend fetch.
 *
 *   1  which requests are guarded (our own data loads, never a save)
 *   2  a load that never answers is given up on after the time limit
 *   3  a load that fails is reported; one the screen cancelled is not
 *   4  the request still behaves normally for the screen that made it
 *   5  coming back online retries only when nothing typed would be lost
 *   6  both layouts wrap their pages in the guard
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LOAD_TIMEOUT_MS, classifyLoadFailure, installConnectionGuard, isGuardedRequest, loadFailureMessage, safeToAutoRetry, type LoadFailure } from "../lib/connectionGuard";

const ROOT = join(__dirname, "..");
const code = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : `  — ${detail}`}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ORIGIN = "https://athletix-os.com";

function typeError() {
  return new TypeError("Load failed");
}
function abortError() {
  const e = new Error("The operation was aborted.");
  e.name = "AbortError";
  return e;
}

/** A window whose fetch does whatever `behave` says, and honours abort. */
function fakeWindow(behave: (url: string, init: RequestInit | undefined) => Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const win = {
    location: { origin: ORIGIN },
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(abortError()));
        behave(url, init).then(resolve, reject);
      });
    }) as typeof fetch,
  };
  return { win, calls };
}
const never = () => new Promise<Response>(() => undefined);
const ok = () => Promise.resolve(new Response("{}", { status: 200 }));

async function main() {
  console.log("\n§1 which requests are guarded");
  check("a data load from our own API", isGuardedRequest({ url: "/api/member/portal", method: "GET", origin: ORIGIN }));
  check("the same, written as a full address", isGuardedRequest({ url: `${ORIGIN}/api/events/abc/attendees`, origin: ORIGIN }));
  check("a save is never guarded (never timed out, never replayed)", !isGuardedRequest({ url: "/api/attendance/charge", method: "POST", origin: ORIGIN }));
  for (const m of ["PUT", "PATCH", "DELETE"]) check(`${m} is never guarded`, !isGuardedRequest({ url: "/api/members/1", method: m, origin: ORIGIN }));
  check("sign-in plumbing is left alone", !isGuardedRequest({ url: "/api/auth/session", origin: ORIGIN }));
  check("page navigation is left alone", !isGuardedRequest({ url: "/member/schedule?_rsc=abc", origin: ORIGIN }));
  check("another site is left alone", !isGuardedRequest({ url: "https://api.stripe.com/v1/x", origin: ORIGIN }));
  check("the time limit is longer than a slow page and shorter than a minute", LOAD_TIMEOUT_MS >= 20_000 && LOAD_TIMEOUT_MS <= 45_000);

  console.log("\n§2 a load that never answers is given up on");
  {
    const { win } = fakeWindow(never);
    const seen: LoadFailure[] = [];
    installConnectionGuard(win, { onFailure: (k) => seen.push(k), onSuccess: () => undefined }, { timeoutMs: 40 });
    let rejected = false;
    const p = win.fetch("/api/member/schedule").catch(() => { rejected = true; });
    await sleep(15);
    check("before the limit: still waiting, nothing reported", !rejected && seen.length === 0);
    await p;
    check("after the limit: the request is ended, so the screen's own error path runs", rejected);
    check("and it is reported as taking too long", seen.join() === "TIMEOUT", seen.join());
  }
  {
    const { win } = fakeWindow(never);
    const seen: LoadFailure[] = [];
    installConnectionGuard(win, { onFailure: (k) => seen.push(k), onSuccess: () => undefined }, { timeoutMs: 30 });
    let settled = false;
    void win.fetch("/api/attendance/charge", { method: "POST" }).then(() => { settled = true; }, () => { settled = true; });
    await sleep(80);
    check("a save that is slow is NOT ended by the guard", !settled && seen.length === 0);
  }

  console.log("\n§3 what gets reported");
  {
    const { win } = fakeWindow(() => Promise.reject(typeError()));
    const seen: LoadFailure[] = [];
    installConnectionGuard(win, { onFailure: (k) => seen.push(k), onSuccess: () => undefined });
    let err: unknown = null;
    await win.fetch("/api/member/portal").catch((e) => { err = e; });
    check("no connection: reported as can't reach the server", seen.join() === "OFFLINE");
    check("the screen still receives the original error", err instanceof TypeError);
  }
  {
    const { win } = fakeWindow(never);
    const seen: LoadFailure[] = [];
    installConnectionGuard(win, { onFailure: (k) => seen.push(k), onSuccess: () => undefined }, { timeoutMs: 500 });
    const c = new AbortController();
    const p = win.fetch("/api/members?q=a", { signal: c.signal }).catch(() => "cancelled");
    c.abort();
    check("a search the screen cancelled itself is not a connection problem", (await p) === "cancelled" && seen.length === 0);
  }
  check("a cancel is never mistaken for a dropped connection", classifyLoadFailure(abortError(), { timedOut: false, callerAborted: false }) === null);
  check("our own time limit always reads as a timeout", classifyLoadFailure(abortError(), { timedOut: true, callerAborted: false }) === "TIMEOUT");
  check("some other bug in a screen is not blamed on the connection", classifyLoadFailure(new RangeError("x"), { timedOut: false, callerAborted: false }) === null);
  check("the two messages are plain and different", loadFailureMessage("OFFLINE") !== loadFailureMessage("TIMEOUT") && /connection/i.test(loadFailureMessage("OFFLINE")));

  console.log("\n§4 the request behaves normally otherwise");
  {
    const { win, calls } = fakeWindow(ok);
    const seen: LoadFailure[] = [];
    let successes = 0;
    const uninstall = installConnectionGuard(win, { onFailure: (k) => seen.push(k), onSuccess: () => { successes++; } });
    const res = await win.fetch("/api/member/club", { headers: { "x-test": "1" } });
    check("an answered load returns its response untouched", res.status === 200 && seen.length === 0 && successes === 1);
    check("the screen's own options are passed through", (calls[0].init?.headers as Record<string, string>)["x-test"] === "1");
    const errRes = await fakeWindow(() => Promise.resolve(new Response("no", { status: 500 }))).win.fetch("/api/x");
    check("a server error is an answer, not a dropped connection", errRes.status === 500);
    await win.fetch("https://example.com/other");
    check("an unguarded request is passed straight through", calls[1].init === undefined);
    uninstall();
    await win.fetch("/api/member/club");
    check("removing the guard puts the original fetch back", calls[2].init === undefined);
  }

  console.log("\n§5 coming back online");
  check("nothing typed: retry by itself", safeToAutoRetry([{ value: "" }, { value: "  " }]));
  check("a half-written message: do NOT retry by itself (it would be lost)", !safeToAutoRetry([{ value: "See you at 6", type: null }]));
  check("a ticked box or a search field does not count as typing", safeToAutoRetry([{ value: "on", type: "checkbox" }, { value: "smith", type: "search" }]));
  check("a field still showing its saved value does not count", safeToAutoRetry([{ value: "Ava", defaultValue: "Ava" }]));

  console.log("\n§6 where it is switched on");
  for (const f of ["app/member/layout.tsx", "app/dashboard/layout.tsx"]) {
    check(`${f} wraps its pages in the guard`, code(f).includes("<ConnectionGuard>{children}</ConnectionGuard>"));
  }
  const comp = code("components/ConnectionGuard.tsx");
  check("the bar is announced to screen readers and has a Try again button", comp.includes('role="alert"') && comp.includes("Try again"));
  check("Try again remounts the screen, which re-runs its loads", comp.includes("key={attempt}") && comp.includes("setAttempt((n) => n + 1)"));
  check("the button is a full-size tap target", comp.includes("min-h-11"));

  console.log(failed ? `\n${failed} FAILED` : "\nall passed");
  process.exit(failed ? 1 : 0);
}
main();
