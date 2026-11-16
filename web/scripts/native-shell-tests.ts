/**
 * The native app shell: what a store build may ship, and the small decisions
 * the website makes when it is running inside the app.
 *
 *   npx tsx scripts/native-shell-tests.ts
 *
 * No device, no simulator, no network. What can only be proven on a phone
 * (the camera actually opening, a haptic actually firing) is listed in
 * docs/STORE-SUBMISSION-PACKET.md as a hands-on check.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildNativeConfig, allowedNavigation, isReleaseTarget, resolveServerUrl, PAYMENT_HOSTS, APP_ID } from "../lib/nativeConfig";
import { backAction } from "../lib/nativeBack";
import { checkInPathFromScan, pathForAppUrl, scanProblemMessage } from "../lib/nativeLinks";
import { buildOfflineSchedule, parseOfflineSchedule, isStale, OFFLINE_SCHEDULE_MAX, OFFLINE_SCHEDULE_KEY, OFFLINE_SCHEDULE_STALE_MS } from "../lib/offlineSchedule";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, (_m, p1) => p1);

let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : `  — ${detail}`}`);
}

console.log("\n§1 a store build (https) ships nothing loose");
{
  const c = buildNativeConfig({ CAPACITOR_SERVER_URL: "https://athletix-os.com" });
  check("app id is the registered bundle / package id", c.appId === "com.athletixos.app" && APP_ID === c.appId);
  check("debug logging is off", c.loggingBehavior === "none");
  check("cleartext http is off", c.server.cleartext === false);
  check("Android mixed content is off", c.android.allowMixedContent === false);
  check("Android web debugging is off", c.android.webContentsDebuggingEnabled === false);
  check("it starts at the member entry, over https", c.server.url === "https://athletix-os.com/member");
  check("a bundled offline screen is configured", c.server.errorPath === "native-shell-error.html" && c.webDir === "public/native-shell");
  const nav = c.server.allowNavigation;
  check("navigation has no wildcard", !nav.some((h) => h.includes("*")), nav.join(", "));
  check("navigation allows our host, with and without www", nav.includes("athletix-os.com") && nav.includes("www.athletix-os.com"));
  check("navigation allows the Stripe pages we send people to (so the return lands in the app)", PAYMENT_HOSTS.every((h) => nav.includes(h)));
  check("navigation allows nothing else", nav.length === 2 + PAYMENT_HOSTS.length, nav.join(", "));
  check("no localhost or LAN address in a store build", !nav.some((h) => /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(h)));
  check("a trailing slash on the server URL does not double up", buildNativeConfig({ CAPACITOR_SERVER_URL: "https://athletix-os.com/" }).server.url === "https://athletix-os.com/member");
  check("a www server URL also allows the bare host", allowedNavigation("https://www.athletix-os.com").includes("athletix-os.com"));
}

console.log("\n§2 a development build stays workable");
{
  const c = buildNativeConfig({});
  check("defaults to the simulator address", c.server.url === "http://127.0.0.1:3000/member");
  check("logging on, cleartext on (dev only)", c.loggingBehavior === "debug" && c.server.cleartext === true && c.android.allowMixedContent === true);
  check("CAPACITOR_SERVER_URL wins over NEXT_PUBLIC_APP_URL", resolveServerUrl({ CAPACITOR_SERVER_URL: "http://10.0.0.5:3000", NEXT_PUBLIC_APP_URL: "https://x.example" }) === "http://10.0.0.5:3000");
  check("only https counts as a release target", isReleaseTarget("https://athletix-os.com") && !isReleaseTarget("http://athletix-os.com") && !isReleaseTarget("http://127.0.0.1:3000"));
}

console.log("\n§3 the native projects match");
{
  const gradle = read("android/variables.gradle");
  const sdk = (k: string) => Number(new RegExp(`${k}\\s*=\\s*(\\d+)`).exec(gradle)?.[1] ?? 0);
  check("Android targets API 36 or newer (Google Play, from 2026-08-31)", sdk("targetSdkVersion") >= 36, String(sdk("targetSdkVersion")));
  check("Android compiles against the SDK it targets", sdk("compileSdkVersion") >= sdk("targetSdkVersion"));
  const manifest = read("android/app/src/main/AndroidManifest.xml");
  check("Android does not back the signed-in session up to the cloud", /android:allowBackup="false"/.test(manifest));
  check("Android declares no cleartext exception", !/usesCleartextTraffic="true"/.test(manifest));
  const plist = read("ios/App/App/Info.plist");
  const usage = /<key>NSCameraUsageDescription<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1] ?? "";
  check("iOS camera wording names the real use (scanning the check-in code)", /scan/i.test(usage) && /check-in/i.test(usage), usage);
  check("iOS asks for nothing it does not use (no location, microphone, contacts, tracking)", !/NSLocation|NSMicrophone|NSContacts|NSUserTracking/.test(plist));
  check("iOS answers the export-compliance question", /ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/.test(plist));
  const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
  const plugins = Object.keys(pkg.dependencies).filter((d) => d.startsWith("@capacitor/"));
  check("every native plugin is an official @capacitor one", plugins.length >= 12 && !Object.keys(pkg.dependencies).some((d) => /capacitor/i.test(d) && !d.startsWith("@capacitor/")), plugins.join(", "));
  const swift = read("ios/App/CapApp-SPM/Package.swift");
  for (const p of ["CapacitorBarcodeScanner", "CapacitorHaptics", "CapacitorNetwork", "CapacitorPreferences", "CapacitorShare", "CapacitorSplashScreen", "CapacitorStatusBar", "CapacitorKeyboard", "CapacitorApp"]) {
    check(`iOS project links ${p}`, swift.includes(p));
  }
}

console.log("\n§4 the website carries no native code");
{
  const walk = (dir: string): string[] =>
    readdirSync(join(ROOT, dir)).flatMap((e) => {
      const rel = `${dir}/${e}`;
      if (e === "node_modules") return [];
      return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(rel) ? [rel] : [];
    });
  const offenders = [...walk("app"), ...walk("components"), ...walk("lib")].filter((f) => /from\s+["']@capacitor\//.test(code(f)));
  check("no @capacitor import in app/, components/ or lib/ (the bridge is lib/native.ts)", offenders.length === 0, offenders.join(", "));
  const native = code("lib/native.ts");
  check("the bridge uses the primitives the app injects, not Capacitor.Plugins", /nativePromise/.test(native) && /addListener/.test(native) && !/Capacitor\??\.Plugins/.test(native));
  check("deep links attach through the bridge", /nativeListen[^(]*\("App", "appUrlOpen"/.test(code("components/NativeDeepLinks.tsx")) && !/Plugins\?\.App/.test(code("components/NativeDeepLinks.tsx")));
  const layout = code("app/layout.tsx");
  check("the shell and the deep-link listener are mounted once, at the root", /<NativeShell \/>/.test(layout) && /<NativeDeepLinks \/>/.test(layout));
}

console.log("\n§5 Android back button");
check("something open on top closes first", backAction({ hasOpenDialog: true, pathname: "/member/schedule", historyLength: 5 }) === "CLOSE_DIALOG");
check("…even on a top-level screen", backAction({ hasOpenDialog: true, pathname: "/member", historyLength: 5 }) === "CLOSE_DIALOG");
check("a deeper screen goes back", backAction({ hasOpenDialog: false, pathname: "/member/schedule", historyLength: 5 }) === "GO_BACK");
check("the member home leaves the app", backAction({ hasOpenDialog: false, pathname: "/member", historyLength: 9 }) === "LEAVE_APP");
check("the dashboard home leaves the app", backAction({ hasOpenDialog: false, pathname: "/dashboard/", historyLength: 9 }) === "LEAVE_APP");
check("a screen opened straight from a link (no history) leaves rather than doing nothing", backAction({ hasOpenDialog: false, pathname: "/member/checkin/abc123", historyLength: 1 }) === "LEAVE_APP");

console.log("\n§6 a scanned code is never trusted");
{
  const host = "athletix-os.com";
  const ok = checkInPathFromScan("https://athletix-os.com/c/cmabc123XYZ", host);
  check("a door code checks in", ok.ok && ok.path === "/member/checkin/cmabc123XYZ");
  check("www and a trailing slash are fine", (checkInPathFromScan("https://www.athletix-os.com/c/cmabc123XYZ/", host) as { path?: string }).path === "/member/checkin/cmabc123XYZ");
  check("a check-in link is accepted and normalised", (checkInPathFromScan("https://athletix-os.com/member/checkin/cmabc123XYZ?paid=1", host) as { path?: string }).path === "/member/checkin/cmabc123XYZ");
  const reason = (raw: string) => { const r = checkInPathFromScan(raw, host); return r.ok ? "OK" : r.reason; };
  check("another site's code is refused", reason("https://evil.example.com/c/cmabc123XYZ") === "OTHER_SITE");
  check("a look-alike host is refused", reason("https://athletix-os.com.evil.example/c/cmabc123XYZ") === "OTHER_SITE");
  check("our site, but not a check-in page, is refused", reason("https://athletix-os.com/dashboard/settings") === "NOT_A_CHECK_IN");
  check("a path that tries to climb out is refused", reason("https://athletix-os.com/c/../dashboard") === "NOT_A_CHECK_IN");
  check("a javascript: code is refused", reason("javascript:alert(1)") === "NOT_A_LINK");
  check("plain text is refused", reason("WIFI:S:Gym;T:WPA;P:secret;;") === "NOT_A_LINK" && reason("hello") === "NOT_A_LINK");
  check("nothing scanned is its own case", reason("") === "EMPTY" && reason("   ") === "EMPTY");
  for (const r of ["EMPTY", "NOT_A_LINK", "OTHER_SITE", "NOT_A_CHECK_IN"] as const) {
    check(`"${r}" has a plain message with no web address in it`, scanProblemMessage(r).length > 20 && !/https?:|athletix-os\.com/.test(scanProblemMessage(r)));
  }
  check("deep link: foreign host still ignored", pathForAppUrl("https://evil.example.com/c/abc", host) === null);
}

console.log("\n§7 the schedule kept for offline");
{
  const now = new Date(Date.now());
  const at = (h: number) => new Date(now.getTime() + h * 3_600_000).toISOString();
  const snap = buildOfflineSchedule(
    [
      { title: "Later class", startsAt: at(48), kind: "class", bookingStatus: null },
      { title: "Soon event", startsAt: at(2), kind: "event", bookingStatus: "CONFIRMED" },
      { title: "Long past", startsAt: at(-72), kind: "class" },
      { title: "Cancelled day", startsAt: at(24), kind: "class", canceled: true },
      { title: 42, startsAt: at(3) },
      { title: "Bad date", startsAt: "not a date" },
    ],
    "Riverside Athletics",
    now,
  );
  check("soonest first", snap.entries.map((e) => e.title).join("|") === "Soon event|Cancelled day|Later class");
  check("long-past items are dropped, malformed ones ignored", !snap.entries.some((e) => e.title === "Long past" || e.title === "Bad date"));
  check("class times are flagged as wall-clock, event times are not", snap.entries.find((e) => e.title === "Later class")!.wallClockUTC && !snap.entries.find((e) => e.title === "Soon event")!.wallClockUTC);
  check("booked and cancelled carry over", snap.entries.find((e) => e.title === "Soon event")!.booked && snap.entries.find((e) => e.title === "Cancelled day")!.canceled);
  const many = buildOfflineSchedule(Array.from({ length: 60 }, (_, i) => ({ title: `C${i}`, startsAt: at(i + 1), kind: "class" })), null, now);
  check("capped", many.entries.length === OFFLINE_SCHEDULE_MAX);
  const json = JSON.stringify(snap);
  check("no money, contact details or ids are stored", !/price|amount|email|phone|memberId|\$\d/i.test(json), json.slice(0, 120));
  check("round-trips", parseOfflineSchedule(json)?.entries.length === 3);
  check("junk parses to null, never throws", parseOfflineSchedule("{") === null && parseOfflineSchedule(null) === null && parseOfflineSchedule("[]") === null && parseOfflineSchedule('{"savedAt":1}') === null);
  check("a fresh copy is not stale; an old one is", !isStale(snap, now) && isStale(snap, new Date(now.getTime() + OFFLINE_SCHEDULE_STALE_MS + 1000)));
  const page = read("public/native-shell/native-shell-error.html");
  check("the bundled offline screen reads the same key", page.includes(`"${OFFLINE_SCHEDULE_KEY}"`));
  check("the offline screen builds its list with textContent (a saved title cannot inject markup)", /textContent = e\.title/.test(page) && !/innerHTML/.test(page));
  check("the offline screen retries by itself when the connection returns", /networkStatusChange/.test(page));
  check("the offline screen says the copy may be out of date", /may have changed since/.test(page));
}

console.log(`\n${"─".repeat(70)}`);
if (failed) {
  console.log(`✗ ${failed} native shell check(s) failed\n`);
  process.exit(1);
}
console.log("✓ native shell tests passed\n");
