/**
 * A local server sees nothing real (crash audit 2026-11-18).
 *
 *   npx tsx scripts/dev-local-env-tests.ts
 *
 * scripts/dev-local.sh is the only safe way to start a local server, and for
 * three months it was a hand-kept list of credentials to blank. Three times a
 * name was missing from the list (SMTP, Stripe, and — found by this audit — a
 * second production database address that the database client loads from the
 * MAIN checkout's .env, even in a worktree with no .env of its own).
 *
 * This asks the script what a server started by it would see, for EVERY
 * environment variable the app reads, and fails if any holds a real value.
 * Names only: no value is ever read into this test or printed.
 *
 * On a machine with no .env files (the build server) it passes trivially; on a
 * developer's machine it is the real check.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : `  — ${detail}`}`);
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx|mjs|mts)$/.test(name)) out.push(p);
  }
  return out;
}

// Every name the running app reads.
const names = new Set<string>();
for (const dir of ["app", "lib", "components", "netlify"]) {
  for (const f of sources(join(ROOT, dir))) {
    for (const m of readFileSync(f, "utf8").matchAll(/process\.env\.([A-Z0-9_]+)|Netlify\.env\.get\("([A-Z0-9_]+)"\)/g)) names.add(m[1] ?? m[2]);
  }
}
for (const f of ["middleware.ts", "instrumentation.ts", "next.config.mjs", "sentry.client.config.ts", "sentry.server.config.ts", "sentry.edge.config.ts"]) {
  try { for (const m of readFileSync(join(ROOT, f), "utf8").matchAll(/process\.env\.([A-Z0-9_]+)/g)) names.add(m[1]); } catch { /* optional file */ }
}

// …and the two the database schema reads (prisma/schema.prisma), which never
// appear as process.env in app code.
names.add("DATABASE_URL");
names.add("DIRECT_URL");

// The only names allowed to hold something that is not blank or an address on
// this machine — and each is a throwaway the script itself sets.
const LOCAL_THROWAWAYS = new Set(["NEXTAUTH_SECRET", "RESEND_WEBHOOK_SECRET", "NODE_ENV", "NEXT_RUNTIME"]);

console.log(`\nwhat a server started by scripts/dev-local.sh sees, for the ${names.size} variables the app reads`);
// A scrubbed environment: only what the script sets and what libraries load
// from .env files on its behalf. (The build server's own variables are not the
// subject here — this script is never how production starts.)
const out = execFileSync("sh", ["scripts/dev-local.sh", "env", ...[...names].sort()], {
  cwd: ROOT,
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LC_ALL: "C" } as unknown as NodeJS.ProcessEnv,
  encoding: "utf8",
});
const seen = new Map<string, string>();
for (const line of out.split("\n")) {
  const m = /^([A-Z0-9_]+)=(blank|local|SET)$/.exec(line.trim());
  if (m) seen.set(m[1], m[2]);
}
check("the script answered for every variable", [...names].every((n) => seen.has(n)), [...names].filter((n) => !seen.has(n)).join(", "));

const real = [...seen].filter(([k, v]) => v === "SET" && !LOCAL_THROWAWAYS.has(k)).map(([k]) => k);
check("no variable the app reads holds a real value", real.length === 0, `still set: ${real.join(", ")}`);
for (const k of ["DATABASE_URL", "DIRECT_URL", "APP_DATABASE_URL"]) {
  check(`${k} is an address on this machine`, seen.get(k) === "local", `is ${seen.get(k)}`);
}
for (const k of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_CONNECT_WEBHOOK_SECRET", "SMTP_HOST", "RESEND_API_KEY", "APNS_KEY_ID", "APNS_PRIVATE_KEY", "FIREBASE_SERVICE_ACCOUNT_JSON", "PLAID_CLIENT_ID", "PLAID_SECRET", "SUPABASE_SERVICE_ROLE_KEY", "CRON_SECRET"]) {
  check(`${k} is blank`, seen.get(k) === "blank", `is ${seen.get(k)}`);
}

console.log("\nthe script itself");
const sh = readFileSync(join(ROOT, "scripts/dev-local.sh"), "utf8");
check("binds 127.0.0.1 in every mode, never 0.0.0.0", !/0\.0\.0\.0/.test(sh.replace(/^#.*$/gm, "")) && (sh.match(/-H 127\.0\.0\.1/g) ?? []).length >= 2);
check("blanks whatever an env file defines that it has not set (default-deny)", /already=/.test(sh) && /export "\$k="/.test(sh));

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
