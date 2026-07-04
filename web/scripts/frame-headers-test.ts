// Regression test: frame-blocking headers.
//
// Public embeddable calendar routes (/cal/:clubId/:token) must be iframeable:
//   - NO X-Frame-Options header
//   - enforcing Content-Security-Policy of exactly "frame-ancestors *"
// Every other route (dashboard, auth, member portal, checkout, APIs) must keep
// clickjacking protection:
//   - X-Frame-Options: DENY
//   - report-only CSP containing frame-ancestors 'none'
//
// Run (static check against next.config.mjs — no server needed):
//   npx tsx scripts/frame-headers-test.ts
// Run additionally against a live server:
//   BASE_URL=http://127.0.0.1:3000 npx tsx scripts/frame-headers-test.ts

import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { pathToRegexp } = require("next/dist/compiled/path-to-regexp");

const EMBED_PATHS = [
  "/cal/cmq9xyrjx00008tc4xck1k9qo/78a09d1154aef4da284ce360f5169d81501582d7",
  "/cal/someclub/sometoken",
  // Bare /cal is a 404, but it lives in the embed subtree so it must get the
  // embed headers (not a contradictory DENY + frame-ancestors * pair).
  "/cal",
];

const PROTECTED_PATHS = [
  "/",
  "/login",
  "/signup",
  "/dashboard",
  "/dashboard/settings/billing",
  "/member",
  "/member/profile",
  "/activate/some-token",
  "/api/members",
  "/api/public/calendar/club/token", // ICS feed — not an embed page, keeps DENY
  "/calendar", // prefix-adjacent path — must NOT be swept into the /cal/ exemption
];

let failures = 0;

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    failures++;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

type Rule = { source: string; headers: { key: string; value: string }[] };

/** Headers a path receives, applying every matching rule (last same-key wins, like Next). */
function resolveHeaders(rules: Rule[], path: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rule of rules) {
    const re: RegExp = pathToRegexp(rule.source);
    if (!re.test(path)) continue;
    for (const h of rule.headers) out.set(h.key.toLowerCase(), h.value);
  }
  return out;
}

function assertEmbeddable(path: string, headers: Map<string, string>, source: string) {
  check(
    `${source} ${path} has no X-Frame-Options`,
    !headers.has("x-frame-options"),
    `got "${headers.get("x-frame-options")}"`
  );
  const csp = headers.get("content-security-policy") ?? "";
  check(
    `${source} ${path} CSP allows all frame-ancestors`,
    /frame-ancestors \*/.test(csp) && !/frame-ancestors 'none'/.test(csp),
    `got "${csp}"`
  );
  const reportOnly = headers.get("content-security-policy-report-only") ?? "";
  check(
    `${source} ${path} report-only CSP has no frame-ancestors 'none'`,
    !/frame-ancestors 'none'/.test(reportOnly),
    `got "${reportOnly}"`
  );
}

function assertProtected(path: string, headers: Map<string, string>, source: string) {
  check(
    `${source} ${path} keeps X-Frame-Options: DENY`,
    headers.get("x-frame-options") === "DENY",
    `got "${headers.get("x-frame-options")}"`
  );
  const enforcing = headers.get("content-security-policy") ?? "";
  check(
    `${source} ${path} has no permissive enforcing frame-ancestors`,
    !/frame-ancestors \*/.test(enforcing),
    `got "${enforcing}"`
  );
  const reportOnly = headers.get("content-security-policy-report-only") ?? "";
  check(
    `${source} ${path} report-only CSP keeps frame-ancestors 'none'`,
    /frame-ancestors 'none'/.test(reportOnly),
    `got "${reportOnly}"`
  );
}

async function staticCheck() {
  console.log("— static check: next.config.mjs headers() rules —");
  const config = (await import("../next.config.mjs")).default;
  const rules: Rule[] = await config.headers();

  for (const path of EMBED_PATHS) assertEmbeddable(path, resolveHeaders(rules, path), "config");
  for (const path of PROTECTED_PATHS) assertProtected(path, resolveHeaders(rules, path), "config");
}

async function liveCheck(baseUrl: string) {
  console.log(`— live check against ${baseUrl} —`);
  const fetchHeaders = async (path: string) => {
    // manual redirect: assert on the direct response, not a followed target
    const res = await fetch(baseUrl + path, { redirect: "manual" });
    const map = new Map<string, string>();
    res.headers.forEach((v, k) => map.set(k.toLowerCase(), v));
    return map;
  };
  for (const path of EMBED_PATHS) assertEmbeddable(path, await fetchHeaders(path), "live");
  for (const path of PROTECTED_PATHS) assertProtected(path, await fetchHeaders(path), "live");
}

async function main() {
  await staticCheck();
  const baseUrl = process.env.BASE_URL;
  if (baseUrl) {
    await liveCheck(baseUrl.replace(/\/$/, ""));
  } else {
    console.log("(set BASE_URL=http://127.0.0.1:3000 to also check a live server)");
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll frame-header checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
