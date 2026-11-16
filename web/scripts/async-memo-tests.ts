/**
 * The small helpers behind the 2026-11 speed work: fetch each thing once, give
 * up on slow outside services, ask for only the rows a card shows.
 *
 *   npx tsx scripts/async-memo-tests.ts
 *
 * No database, no network (fetch is replaced with a local fake).
 */
import { memoAsync, withTimeout, mapLimit, TimeoutError } from "../lib/asyncMemo";
import { parseAnnouncementLimit, MAX_ANNOUNCEMENT_LIMIT } from "../lib/announcementLimit";
import { parseRecentLimit, parseNextEventsLimit, MAX_RECENT_MEMBERS, MAX_NEXT_EVENTS } from "../lib/listLimits";
import { sharedGet, sharedGetInFlight } from "../lib/sharedGet";

let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : `  — ${detail}`}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("\n§1 memoAsync — one fetch per key");
  {
    let calls = 0;
    const get = memoAsync(async (k: string) => { calls++; await sleep(5); return `v:${k}`; });
    const [a, b, c] = await Promise.all([get("x"), get("x"), get("y")]);
    check("concurrent callers of one key share the fetch", calls === 2 && a === "v:x" && b === "v:x" && c === "v:y", `calls=${calls}`);
    await get("x");
    check("a later caller of the same key does not refetch", calls === 2);
  }
  {
    let calls = 0;
    const get = memoAsync(async (_k: string) => { calls++; throw new Error("boom"); });
    const first = await get("k").then(() => "ok", (e) => (e as Error).message);
    const second = await get("k").then(() => "ok", (e) => (e as Error).message);
    check("a failure is remembered within the memo (no slow second failure)", calls === 1 && first === "boom" && second === "boom");
  }
  {
    const a = memoAsync(async (k: string) => `a:${k}`);
    const b = memoAsync(async (k: string) => `b:${k}`);
    check("two memos never share entries (one request cannot read another's)", (await a("id")) === "a:id" && (await b("id")) === "b:id");
  }
  {
    // An un-awaited rejection must not crash the process.
    let unhandled = 0;
    const onUnhandled = () => { unhandled++; };
    process.on("unhandledRejection", onUnhandled);
    const get = memoAsync(async (_k: string) => { throw new Error("nobody is listening"); });
    void get("z");
    await sleep(20);
    process.off("unhandledRejection", onUnhandled);
    check("a rejection nobody awaited is not reported as unhandled", unhandled === 0);
  }

  console.log("\n§2 withTimeout — a page does not wait forever on an outside service");
  check("a fast answer wins", (await withTimeout(Promise.resolve(7), 50, "t", () => -1)) === 7);
  check("a slow answer falls back", (await withTimeout(sleep(200).then(() => 7), 20, "t", () => -1)) === -1);
  {
    const r = await withTimeout(sleep(200), 20, "card lookup").then(() => null, (e) => e);
    check("without a fallback it rejects with TimeoutError naming what was slow", r instanceof TimeoutError && /card lookup/.test((r as Error).message));
  }
  {
    const r = await withTimeout(Promise.reject(new Error("real failure")), 50, "t", () => "fallback").then((v) => v, (e) => (e as Error).message);
    check("a real failure is passed on, not swallowed by the fallback", r === "real failure");
  }

  console.log("\n§3 mapLimit — bounded fan-out, order kept");
  {
    let live = 0; let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => { live++; peak = Math.max(peak, live); await sleep(5); live--; return n * 2; });
    check("results keep input order", out.join(",") === "2,4,6,8,10,12,14");
    check("never more than the limit in flight", peak <= 3, `peak=${peak}`);
    check("an empty list resolves empty", (await mapLimit([], 3, async (n: number) => n)).length === 0);
  }

  console.log("\n§4 list limits — a card that shows five rows asks for five");
  check("announcements: a plain number", parseAnnouncementLimit("3") === 3);
  check("announcements: capped", parseAnnouncementLimit("999") === MAX_ANNOUNCEMENT_LIMIT);
  for (const bad of [null, undefined, "", "0", "-1", "2.5", "abc", "3; drop", " "]) {
    check(`announcements: ${JSON.stringify(bad)} means no limit, never an error`, parseAnnouncementLimit(bad as string) === null);
  }
  check("recent members: a plain number", parseRecentLimit("5") === 5);
  check("recent members: capped", parseRecentLimit("5000") === MAX_RECENT_MEMBERS);
  check("recent members: junk falls through to the normal list", parseRecentLimit("all") === null && parseRecentLimit("0") === null && parseRecentLimit(null) === null);
  check("next events: a plain number", parseNextEventsLimit("5") === 5);
  check("next events: capped", parseNextEventsLimit("21") === MAX_NEXT_EVENTS);
  check("next events: junk falls through", parseNextEventsLimit("true") === null);

  console.log("\n§5 sharedGet — one request for cards that mount together");
  {
    let hits = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      hits++;
      await sleep(10);
      if (String(url).includes("forbidden")) return new Response(JSON.stringify({ code: "UPGRADE_REQUIRED" }), { status: 403 });
      if (String(url).includes("notjson")) return new Response("<html>", { status: 200 });
      return new Response(JSON.stringify({ n: hits }), { status: 200 });
    }) as typeof fetch;
    try {
      const [a, b] = await Promise.all([sharedGet<{ n: number }>("/api/x"), sharedGet<{ n: number }>("/api/x")]);
      check("two callers at once make one request", hits === 1 && a.data?.n === 1 && b.data?.n === 1, `hits=${hits}`);
      check("nothing is held once the answer is in", sharedGetInFlight() === 0);
      const c = await sharedGet<{ n: number }>("/api/x");
      check("a later caller gets a FRESH read (reload after save is never stale)", hits === 2 && c.data?.n === 2);
      const before = hits;
      await Promise.all([sharedGet("/api/x"), sharedGet("/api/y")]);
      check("different URLs are not shared", hits === before + 2);
      const f = await sharedGet<{ code: string }>("/api/forbidden");
      check("an error status is reported with its body, not thrown", !f.ok && f.status === 403 && f.data?.code === "UPGRADE_REQUIRED");
      const nj = await sharedGet("/api/notjson");
      check("a non-JSON body gives data: null instead of throwing", nj.ok && nj.data === null);
      globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
      const off = await sharedGet("/api/offline").then(() => "resolved", (e) => (e as Error).message);
      check("a network failure rejects, and clears the entry", off === "offline" && sharedGetInFlight() === 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  console.log(`\n${"─".repeat(70)}`);
  if (failed) {
    console.log(`✗ ${failed} check(s) failed\n`);
    process.exit(1);
  }
  console.log("✓ async-memo tests passed\n");
}
main();
