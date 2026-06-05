#!/usr/bin/env node
// Sync helper: switches the native iOS/Android dev target between the
// simulator, a real iPhone on the Mac's LAN, and production HTTPS in one
// command. Three things have to stay aligned for native login to work:
//
//   1. capacitor.config.ts reads CAPACITOR_SERVER_URL to build the
//      WebView's start URL.
//   2. public/native-shell/server-config.js reads the same env so the
//      reconnect page retries against the right origin.
//   3. NEXTAUTH_URL in .env.local must match the URL the WebView loads
//      — otherwise NextAuth's server-side absolute URLs (Stripe redirects,
//      password-reset links, partner-invite emails) point at a host the
//      phone can't reach (`127.0.0.1` from a real device), and certain
//      flows open Safari, where WKWebView's restricted-port blocklist
//      shows the "Not allowed to use restricted network port" page on
//      bind-only addresses like `0.0.0.0`.
//
// Usage:
//   node scripts/native-dev-switch.mjs sim
//   node scripts/native-dev-switch.mjs iphone 10.0.0.45
//   node scripts/native-dev-switch.mjs prod https://app.athletix-os.com
//
// Convenience npm scripts:
//   npm run cap:dev:sim
//   npm run cap:dev:iphone -- 10.0.0.45
//   npm run cap:dev:prod -- https://app.athletix-os.com
//
// The script edits .env.local in place — surgically — and runs cap:sync.
// .env.local is gitignored (Next default), so this never pollutes the
// repo or overrides committed .env values for other developers.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ENV_LOCAL = path.join(ROOT, ".env.local");

const [mode, arg] = process.argv.slice(2);

function die(msg) {
  console.error(`[native-dev-switch] ${msg}`);
  process.exit(1);
}

if (!mode || !["sim", "iphone", "prod"].includes(mode)) {
  die(
    "Usage:\n" +
      "  node scripts/native-dev-switch.mjs sim\n" +
      "  node scripts/native-dev-switch.mjs iphone <mac-lan-ip>\n" +
      "  node scripts/native-dev-switch.mjs prod <https-url>",
  );
}

let serverUrl;
if (mode === "sim") {
  serverUrl = "http://127.0.0.1:3000";
} else if (mode === "iphone") {
  if (!arg) die("iphone mode needs your Mac's LAN IP (e.g. `iphone 10.0.0.45`).");
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(arg)) {
    die(`"${arg}" doesn't look like a LAN IP. Try \`ipconfig getifaddr en0\`.`);
  }
  serverUrl = `http://${arg}:3000`;
} else if (mode === "prod") {
  if (!arg) die("prod mode needs the production URL (e.g. `prod https://app.athletix-os.com`).");
  if (!arg.startsWith("https://")) {
    die("prod URL must start with https://");
  }
  serverUrl = arg.replace(/\/$/, "");
}

// Update .env.local: replace or append NEXTAUTH_URL only. Preserve every
// other line (DATABASE_URL, STRIPE_*, SMTP_*, anything else).
let body = "";
let existed = false;
try {
  body = fs.readFileSync(ENV_LOCAL, "utf8");
  existed = true;
} catch {
  body = "";
}

const NEXTAUTH_LINE = `NEXTAUTH_URL=${serverUrl}`;
if (/^NEXTAUTH_URL=.*/m.test(body)) {
  body = body.replace(/^NEXTAUTH_URL=.*/m, NEXTAUTH_LINE);
} else {
  if (body.length > 0 && !body.endsWith("\n")) body += "\n";
  body += `# Set by scripts/native-dev-switch.mjs (mode=${mode}). Override or remove freely.\n`;
  body += `${NEXTAUTH_LINE}\n`;
}
fs.writeFileSync(ENV_LOCAL, body);
console.log(
  `[native-dev-switch] ${existed ? "updated" : "wrote"} ${path.relative(ROOT, ENV_LOCAL)} ` +
    `→ NEXTAUTH_URL=${serverUrl}`,
);

// Re-run cap:sync with the matching CAPACITOR_SERVER_URL. The cap:sync
// script in package.json invokes scripts/native-shell-config.mjs first
// (writes server-config.js) and then `cap sync`.
const sync = spawnSync("npm", ["run", "cap:sync"], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, CAPACITOR_SERVER_URL: serverUrl },
});
if (sync.status !== 0) die(`cap:sync exited ${sync.status}`);

console.log(`[native-dev-switch] ✓ ${mode} target baked → ${serverUrl}`);
console.log(`[native-dev-switch] Restart \`npm run dev\` so it picks up NEXTAUTH_URL.`);
if (mode === "iphone") {
  console.log(
    `[native-dev-switch] Then open Xcode, pick your iPhone, and Run. ` +
      `Confirm the phone can reach the dev server first: ` +
      `\`curl -I ${serverUrl}\` from another machine on the same network.`,
  );
} else if (mode === "sim") {
  console.log(`[native-dev-switch] Then open Xcode (\`npm run cap:ios\`), pick a simulator, and Run.`);
}
