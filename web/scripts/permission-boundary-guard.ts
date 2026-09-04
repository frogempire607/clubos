/**
 * Phase 6 §6A/§6B — every staff-facing mutating API route must consult
 * permissions, not just a role.
 *
 *   npm run test:permission-boundary
 *
 * No database, no network — this reads the source tree, like
 * scripts/subscription-truth-guard.ts.
 *
 * ── The gap this measures ───────────────────────────────────────────────────
 *
 * `middleware.ts` matches `["/dashboard/:path*", "/admin/:path*",
 * "/member/:path*"]`. **It does not match `/api`.** So middleware protects the
 * PAGES a staffer can open and nothing at all about the requests they can
 * send. For an API route, the guard written in that route is the entire
 * boundary.
 *
 * A route whose only check is
 *
 *     if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF"))
 *
 * therefore admits EVERY staff member of the club regardless of their
 * `StaffProfile.permissions`. Measured 2026-09-04, 26 mutating routes are in
 * that state, including `/api/expenses/[id]` (PATCH + DELETE) — money — while
 * `DEFAULT_PERMISSIONS.finances` is `"none"`. A coach explicitly denied
 * finances can still edit and delete expenses by calling the API directly.
 *
 * ── Why this is a ratchet and not a wall ────────────────────────────────────
 *
 * Fixing those 26 means choosing a permission key AND level for each, and a
 * wrong choice locks real staff out of their job mid-season. "Do not break role
 * permissions" is a standing repo guardrail, so the mapping is owner-approved
 * work, not a sweep. What this guard does today is stop the number growing: a
 * NEW ungated mutating route fails the build.
 *
 * Lower BASELINE as routes are fixed. Never raise it.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..");
const API = join(ROOT, "app", "api");

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith("route.ts")) out.push(p);
  }
  return out;
}

/** Blank comments rather than delete them, so line numbers stay true. */
const strip = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, (_m, p1) => p1);

/**
 * Every helper that actually consults `StaffProfile.permissions` (or a
 * narrower scope derived from it). Owners bypass all of them by design.
 *
 * If you add a new guard helper, add it here in the same commit — otherwise
 * this guard reports the routes using it as unprotected and someone "fixes"
 * a route that was already correct.
 */
const GUARD =
  /require(Permission|PermissionLive|Owner|MessagesSubScope)\s*\(|has(Permission|MessagesSubScope|BillingSubScope|ReportScope|ReportsAny)\s*\(|assertCanRespondToRegistration|canDecideRegistrations/;

/**
 * Not staff-facing, so a permission key is the wrong question:
 *   member/…      the client portal — authorized by session identity and
 *                 guardian links, covered by lib/familyAccess
 *   public/…      deliberately anonymous
 *   [token]       authenticated BY the token (activation, reactivation,
 *                 guardian consent, partner invite) — there is no session
 *   webhook/cron  signature- or CRON_SECRET-authenticated
 *   me/…, widgets, upload  act on the caller's own row
 */
const NOT_STAFF_FACING = [
  /\/api\/(member|public|auth|stripe\/webhook|cron|webhooks|files|preview|unsubscribe)\//,
  /\[token\]/,
  /\/api\/(me|dashboard\/widgets|upload|emails\/image-url)\//,
];

const MUTATES = /export async function (POST|PATCH|PUT|DELETE)/;
/** Admits STAFF without consulting permissions. */
const ADMITS_STAFF =
  /role\s*!==\s*"OWNER"\s*&&\s*[\w.]*role\s*!==\s*"STAFF"|\["OWNER",\s*"STAFF"\]|role\s*===\s*"STAFF"/;
const OWNER_CHECK = /role\s*!==\s*"OWNER"/;

type Row = { rel: string; verbs: string };
const anyStaff: Row[] = [];
const ownerOnly: Row[] = [];
const noRoleCheck: Row[] = [];

for (const file of walk(API)) {
  const rel = relative(ROOT, file);
  if (NOT_STAFF_FACING.some((re) => re.test("/" + rel))) continue;
  const src = strip(readFileSync(file, "utf8"));
  if (!MUTATES.test(src)) continue;
  if (GUARD.test(src)) continue;

  const verbs = (src.match(MUTATES) ? src.match(/export async function (POST|PATCH|PUT|DELETE)/g) ?? [] : [])
    .map((m) => m.split(" ").pop() as string)
    .join(",");
  const row = { rel, verbs };

  const admits = ADMITS_STAFF.test(src);
  if (admits) anyStaff.push(row);
  // Owner-only is STRONGER than any permission — a staffer cannot reach it at
  // all. Settings, Stripe Connect, Plaid and tier live here deliberately.
  else if (OWNER_CHECK.test(src)) ownerOnly.push(row);
  else noRoleCheck.push(row);
}

/**
 * Was 26 when first measured on 2026-09-04. The owner-approved mapping landed
 * the same day and took it to 4. The four that remain are HELD ON PURPOSE, not
 * missed:
 *
 *   classes/[id]/charge   taking money at the door. billing:full is the safe
 *   events/[id]/charge    reading, but it would stop a coach who checks people
 *                         in and takes a drop-in payment. Owner's call, still
 *                         outstanding as of 2026-09-04.
 *
 * Announcements left this list the same day: the owner ruled messages:full,
 * "a DM and a broadcast to 293 families shouldn't be the same bar."
 *
 * Lower this as those land; never raise it.
 */
const BASELINE = 2;
/**
 * Routes with no role check at all.
 *
 * The one at baseline is `/api/messages/dm/[userId]` POST, and it is correct:
 * both the recipient and the subject athlete are looked up with
 * `clubId: session.user.clubId`, so there is no cross-tenant reach, and
 * "members may DM staff and owners freely" is the intended product rule. It is
 * counted rather than excluded so that a SECOND session-only mutating route
 * has to be looked at rather than blending in.
 */
const NO_ROLE_BASELINE = 1;

const note = (s: string) => console.log(s);
let failed = false;

note("\nPERMISSION BOUNDARY — staff-facing mutating API routes");
note(`  middleware matches /dashboard, /admin, /member — NOT /api, so the route's`);
note("  own guard is the entire boundary.\n");

note(`  admits ANY staff regardless of permissions: ${anyStaff.length} (baseline ${BASELINE})`);
for (const r of anyStaff) note(`      ${r.rel}  [${r.verbs}]`);
note(`\n  no role check at all: ${noRoleCheck.length} (baseline ${NO_ROLE_BASELINE})`);
for (const r of noRoleCheck) note(`      ${r.rel}  [${r.verbs}]`);
note(`\n  owner-only (stronger than a permission — not counted): ${ownerOnly.length}`);

if (anyStaff.length > BASELINE || noRoleCheck.length > NO_ROLE_BASELINE) {
  failed = true;
  note("");
  note("  ✗ a NEW mutating route reaches the database without checking permissions.");
  note("");
  note("    Gate it with requirePermission(session, <key>, <level>) from lib/apiGuard,");
  note("    or requirePermissionLive for anything that moves money (it re-reads the");
  note("    staff row rather than trusting the JWT, so a permission revoked five");
  note("    minutes ago is actually revoked).");
  note("");
  note("    Keys: members attendance classes events schedule messages documents");
  note("          finances billing reports staff");
  note("    Levels: none view send edit full. OWNER bypasses everything.");
  note("    Privates are gated under `events`, not a `privates` key.");
  note("");
  note("    TypeScript gotcha: replacing an inline `session.user.role` check with");
  note("    requirePermission loses null-narrowing on `session`. Add an explicit");
  note("    `if (!session) return 401;` before the guard or the build fails with");
  note("    \"'session' is possibly null\".");
} else if (anyStaff.length < BASELINE) {
  note(`\n  ✓ went DOWN (${BASELINE} → ${anyStaff.length}) — lower BASELINE to ${anyStaff.length}`);
} else {
  note("\n  ✓ holding at baseline — no new ungated route");
}

note(`\n${"─".repeat(70)}`);
if (failed) {
  note("✗ permission boundary guard failed\n");
  process.exit(1);
}
note("✓ permission boundary guard passed\n");
