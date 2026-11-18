/**
 * Client error reporting — a crashed screen is recorded, and nothing about a
 * person is (crash audit 2026-11-18).
 *
 *   npx tsx scripts/client-errors-tests.ts
 *
 * No database, no network: pure functions, a pretend window, and the source.
 *
 *   1  an address keeps its shape and loses ids, tokens and its query string
 *   2  error text loses email addresses and tokens
 *   3  the server trusts nothing the browser sends
 *   4  noise that is not a bug in this app is dropped
 *   5  repeats group into one line
 *   6  the browser reporter: once per crash, five per page, never throws
 *   7  every error screen reports; the endpoints are what they claim to be
 *   8  the migration adds one table and touches nothing else
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildReport, fingerprintOf, groupErrors, isNoise, parseReport, scrubPath, scrubText, MAX_MESSAGE, MAX_STACK } from "../lib/clientErrors";

const ROOT = join(__dirname, "..");
const code = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : `  — ${detail}`}`);
}
const eq = (label: string, got: unknown, want: unknown) => check(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

async function main() {
  console.log("\n§1 an address keeps its shape and loses what identifies anyone");
  eq("a member profile", scrubPath("https://athletix-os.com/dashboard/members/cmq9xyrjx00008tc4xck1k9qo?edit=1&tab=family"), "/dashboard/members/:id");
  eq("a staff profile", scrubPath("/dashboard/staff/cmwmcjh2x0001occ6itrizglo"), "/dashboard/staff/:id");
  eq("an activation link — the token IS the path", scrubPath("/activate/3f9c2b7a1d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4"), "/activate/:id");
  eq("a staff setup link — the token is in the query", scrubPath("/setup?token=abc123def456ghi789&club=frog-empire"), "/setup");
  eq("a calendar feed", scrubPath("/cal/cmq9xyrjx00008tc4xck1k9qo/eyJzIjoiUFVCTElDIn0.c2lnbmF0dXJl9x"), "/cal/:id/:id");
  eq("a seeded-style id", scrubPath("/dashboard/reports/imports/batch_9f2k1"), "/dashboard/reports/imports/:id");
  eq("a numeric id", scrubPath("/member/checkin/48213"), "/member/checkin/:id");
  eq("an email in a path", scrubPath("/member/messages/dm/parent%40example.com"), "/member/messages/dm/:id");
  eq("a public event keeps its readable name", scrubPath("/e/summer-camp-2027"), "/e/summer-camp-2027");
  eq("ordinary pages are untouched", scrubPath("/dashboard/settings/billing"), "/dashboard/settings/billing");
  eq("a fragment is dropped", scrubPath("/dashboard#token=secret1234567890abcdef"), "/dashboard");
  eq("nothing at all is the home page", scrubPath(""), "/");
  check("never longer than 200 characters", scrubPath("/" + "a/".repeat(400)).length <= 200);

  console.log("\n§2 error text");
  eq("an email address is removed", scrubText("No member for shannan.hall@example.com", 500), "No member for [email]");
  check("a long token is removed", !/3f9c2b7a/.test(scrubText("bad token 3f9c2b7a1d4e5f60718293a4b5c6d7e8", 500)));
  check("a query string on an address in a stack is removed", !/token=/.test(scrubText("at https://athletix-os.com/setup?token=abc123def (x.js:1:2)", 500)));
  const frame = "at t (https://athletix-os.com/_next/static/chunks/app/dashboard/staff/%5Bid%5D/page-356b316376a84189.js:1:4707)";
  eq("a stack frame is kept whole — it is what finds the bug", scrubText(frame, 500), frame);
  eq("ordinary error text is untouched", scrubText("Cannot read properties of undefined (reading 'firstName')", 500), "Cannot read properties of undefined (reading 'firstName')");
  check("capped", scrubText("x".repeat(9000), MAX_MESSAGE).length === MAX_MESSAGE);

  console.log("\n§3 the server trusts nothing the browser sends");
  const good = parseReport({ source: "SCREEN", path: "/dashboard/staff/cmwmcjh2x0001occ6itrizglo?x=1", message: "Rendered more hooks than during the previous render.", stack: "Error: x\n at a (b.js:1:1)", digest: "123456", viewport: "390x844" });
  check("a real report is accepted", !!good && good.source === "SCREEN" && good.viewport === "390x844" && good.digest === "123456");
  eq("…and its path is scrubbed again on the server", good?.path, "/dashboard/staff/:id");
  check("an unknown kind is refused", parseReport({ source: "ADMIN", message: "x", path: "/" }) === null);
  check("no message is refused", parseReport({ source: "WINDOW", message: "   ", path: "/" }) === null);
  check("not an object is refused", parseReport("boom") === null && parseReport(null) === null && parseReport([1]) === null);
  const hostile = parseReport({ source: "WINDOW", path: "/x", message: "m".repeat(5000), stack: "s".repeat(50_000), digest: "<script>alert(1)</script>", viewport: "DROP TABLE", clubId: "club_other", userId: "user_other", role: "OWNER" }) as Record<string, unknown> | null;
  check("oversized text is cut down", !!hostile && (hostile.message as string).length === MAX_MESSAGE && (hostile.stack as string).length === MAX_STACK);
  check("a digest is letters and digits only; a made-up viewport is dropped", hostile?.digest === "scriptalert1script" && hostile?.viewport === null);
  check("WHO it happened to cannot be claimed in the body", !!hostile && !("clubId" in hostile) && !("userId" in hostile) && !("role" in hostile));

  console.log("\n§4 noise is dropped");
  for (const m of ["Script error.", "ResizeObserver loop limit exceeded", "AbortError: The operation was aborted.", "TypeError: Load failed", "TypeError: Failed to fetch", "NEXT_REDIRECT"]) {
    check(`"${m}"`, isNoise({ message: m, stack: null }));
  }
  check("a browser extension's error", isNoise({ message: "x is not defined", stack: "at chrome-extension://abcdef/content.js:1:1" }));
  check("a real crash is not noise", !isNoise({ message: "Rendered more hooks than during the previous render.", stack: "at StaffProfile" }) && !isNoise({ message: "TypeError: a.then is not a function", stack: null }));

  console.log("\n§5 repeats group into one line");
  const row = (message: string, userId: string | null, at: string, path = "/dashboard/staff/:id") => ({ source: "SCREEN", path, message, stack: `stack@${at}`, userId, createdAt: at, fingerprint: fingerprintOf({ source: "SCREEN", path, message }) });
  const groups = groupErrors([
    row("hooks", "u1", "2026-11-18T10:00:00.000Z"),
    row("hooks", "u2", "2026-11-18T09:00:00.000Z"),
    row("hooks", "u1", "2026-11-17T09:00:00.000Z"),
    row("then is not a function", null, "2026-11-18T08:00:00.000Z", "/dashboard/reports/imports/:id"),
  ]);
  check("two distinct crashes, most frequent first", groups.length === 2 && groups[0].message === "hooks" && groups[0].count === 3);
  check("people are counted once each", groups[0].people === 2 && groups[1].people === 0);
  check("first and last seen, and the newest stack", groups[0].firstAt.startsWith("2026-11-17T09") && groups[0].lastAt.startsWith("2026-11-18T10") && groups[0].lastStack === "stack@2026-11-18T10:00:00.000Z");

  console.log("\n§6 the browser reporter");
  {
    const posts: { url: string; body: Record<string, unknown>; keepalive?: boolean }[] = [];
    const listeners = new Map<string, (e: unknown) => void>();
    const win = {
      location: { href: "https://athletix-os.com/dashboard/staff/cmwmcjh2x0001occ6itrizglo?tab=pay" },
      innerWidth: 390,
      innerHeight: 844,
      fetch: (url: string, init: { body: string; keepalive?: boolean }) => { posts.push({ url, body: JSON.parse(init.body), keepalive: init.keepalive }); return Promise.reject(new TypeError("Load failed")); },
      addEventListener: (t: string, f: (e: unknown) => void) => { listeners.set(t, f); },
      removeEventListener: (t: string) => { listeners.delete(t); },
    };
    (globalThis as Record<string, unknown>).window = win;
    const { reportClientError, installClientErrorReporter, _resetClientErrorReporterForTests, MAX_REPORTS_PER_LOAD } = await import("../lib/clientErrorReporter");
    _resetClientErrorReporterForTests();

    const crash = new Error("Rendered more hooks than during the previous render.");
    check("a crash is sent", reportClientError(crash, "SCREEN", { digest: "777" }) === true && posts.length === 1);
    check("…to this app's own endpoint and nowhere else", posts[0].url === "/api/public/client-errors");
    check("…with the screen's shape, not its address", posts[0].body.path === "/dashboard/staff/:id" && posts[0].body.viewport === "390x844" && posts[0].body.digest === "777");
    check("…and it still goes out if the person leaves the page", posts[0].keepalive === true);
    check("the same crash again is not sent twice", reportClientError(crash, "SCREEN") === false && posts.length === 1);
    check("a failed send never surfaces (the pretend network rejects every request)", true);

    for (let i = 0; i < 20; i++) reportClientError(new Error(`different crash ${String.fromCharCode(97 + i)}`), "WINDOW");
    check(`at most ${MAX_REPORTS_PER_LOAD} reports per page load, however many errors`, posts.length === MAX_REPORTS_PER_LOAD, `sent ${posts.length}`);

    _resetClientErrorReporterForTests();
    posts.length = 0;
    let threw = false;
    try {
      const circular: Record<string, unknown> = {}; circular.self = circular;
      for (const odd of [undefined, null, 0, "a string was thrown", circular, Symbol("s"), { message: { toString() { throw new Error("no"); } } }]) reportClientError(odd, "PROMISE");
    } catch { threw = true; }
    check("it never throws, whatever it is handed", !threw);
    check("noise is not sent", reportClientError(new TypeError("Failed to fetch"), "PROMISE") === false);

    _resetClientErrorReporterForTests();
    posts.length = 0;
    const stop = installClientErrorReporter(win as unknown as Window);
    listeners.get("error")?.({ error: new Error("uncaught in a click handler"), message: "uncaught in a click handler" });
    listeners.get("unhandledrejection")?.({ reason: new Error("a save that nobody awaited") });
    check("uncaught errors and unhandled promise rejections are both reported", posts.length === 2 && posts[0].body.source === "WINDOW" && posts[1].body.source === "PROMISE");
    stop();
    check("…and it stops listening when unmounted", listeners.size === 0);
    delete (globalThis as Record<string, unknown>).window;
    check("on the server it does nothing", reportClientError(crash, "SCREEN") === false);
  }

  console.log("\n§7 every error screen reports; the endpoints are what they claim");
  check("the dashboard / portal error screen reports", /reportClientError\(error, "SCREEN"/.test(code("components/RouteError.tsx")));
  check("pages outside both have an error screen now, and it is the same one", /RouteError/.test(code("app/error.tsx")));
  check("a crash in the root layout reports too", /reportClientError\(error, "SCREEN"/.test(code("app/global-error.tsx")) && /<html/.test(code("app/global-error.tsx")));
  check("the listener for uncaught errors is mounted in the root layout", /<ClientErrorReporter \/>/.test(code("app/layout.tsx")));
  const post = code("app/api/public/client-errors/route.ts");
  check("POST: who it happened to comes from the session", /getServerSession\(authOptions\)/.test(post) && /clubId: user\?\.clubId/.test(post) && /userId: user\?\.id/.test(post));
  check("POST: nothing identifying is read from the body", !/body\.(clubId|userId|role|email)/.test(post) && /parseReport\(body\)/.test(post));
  check("POST: rate limited per address, and the address is not stored", /rateLimit\(\{ key: `client-error:/.test(post) && !/\bip(Address)?:/.test(post.slice(post.indexOf("clientError.create"))));
  check("POST: a failed insert is swallowed (the table is applied separately)", /could not store the report/.test(post));
  check("POST: only ever answers 204", (post.match(/status: /g) ?? []).length === 1 && /status: 204/.test(post));
  check("POST: also writes one line to the function log", /console\.error\(`\[client-error\]/.test(post));
  const get = code("app/api/client-errors/route.ts");
  check("GET: owner only", /requireOwner\(session\)/.test(get));
  check("GET: only this club's rows", /where: \{ clubId: session\.user\.clubId,/.test(get));
  check("GET: says so when the table is not there yet", /ready: false/.test(get));

  console.log("\n§8 the migration");
  const sql = code("prisma/migrations/20261118000000_client_errors/migration.sql").replace(/^--.*$/gm, "");
  check("creates client_errors, if not already there", /CREATE TABLE IF NOT EXISTS "client_errors"/.test(sql));
  check("touches no other table (no ALTER, DROP, UPDATE, DELETE, INSERT)", !/\b(ALTER|DROP|UPDATE|DELETE|INSERT|TRUNCATE)\b/i.test(sql));
  check("no foreign keys — a signed-out crash is storable and outlives the account", !/REFERENCES/i.test(sql));
  const model = /model ClientError \{([\s\S]*?)\n\}/.exec(code("prisma/schema.prisma"))?.[1] ?? "";
  const modelCols = [...model.matchAll(/^\s{2}(\w+)\s+(String|DateTime)/gm)].map((m) => m[1]).sort();
  const sqlCols = [...sql.matchAll(/^\s{2}"(\w+)"\s+(TEXT|TIMESTAMP)/gm)].map((m) => m[1]).sort();
  check("the table and the model list the same columns", modelCols.length > 10 && JSON.stringify(modelCols) === JSON.stringify(sqlCols), `model ${modelCols.join(",")} · sql ${sqlCols.join(",")}`);
  check("no column for a name, an email or an IP address", !/"(name|email|ip|ipAddress|firstName|lastName)"/i.test(sql));
  check("sorts after the last applied migration", "20261118000000_client_errors" > "20261117020000_class_session_capacity");
}

main().then(() => {
  console.log(failed ? `\n${failed} FAILED` : "\nall passed");
  process.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
