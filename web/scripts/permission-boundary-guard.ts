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
  /require(Permission|PermissionLive|Owner|OwnerLive|MessagesSubScope)\s*\(|has(Permission|PermissionLive|MessagesSubScope|BillingSubScope|ReportScope|ReportsAny)\s*\(|assertCanRespondToRegistration|canDecideRegistrations|resolveFamilyCapabilities\s*\(|checkAssignmentChange\s*\(/;

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

const MUTATING = ["POST", "PATCH", "PUT", "DELETE"] as const;
/** Admits STAFF without consulting permissions. */
const ADMITS_STAFF =
  /role\s*!==\s*"OWNER"\s*&&\s*[\w.]*role\s*!==\s*"STAFF"|\["OWNER",\s*"STAFF"\]|role\s*===\s*"STAFF"/;
const OWNER_CHECK = /role\s*!==\s*"OWNER"/;

// ── Handler-level analysis (2026-10-07) ─────────────────────────────────────
//
// This guard used to ask "does the FILE mention a guard anywhere?". That let a
// route file pass because its GET or DELETE was guarded while its PATCH only
// checked the role — which is exactly how `PATCH /api/classes/[id]` shipped
// open to every staff login (and members/[id], memberships/[id],
// products/[id], expenses POST, messages/groups/[id] POST with it).
//
// Now every exported mutating handler is judged on ITS OWN body: it must call
// a guard itself, or call a helper defined in the same file that does.
//
// Function extent is "from the declaration to the first line that starts with
// `}` in column 0" — the repo is formatted so top-level declarations close in
// column 0 and nothing inside a body does.

export type HandlerKind = "guarded" | "anyStaff" | "ownerOnly" | "noRoleCheck";
export type HandlerFinding = { verb: string; line: number; kind: HandlerKind };

type Fn = { name: string; exported: boolean; start: number; body: string };

function topLevelFunctions(src: string): Fn[] {
  const out: Fn[] = [];
  const lines = src.split("\n");
  const decl = /^(export\s+)?(?:async\s+)?function\s+(\w+)\s*[(<]|^(export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/;
  for (let i = 0; i < lines.length; i++) {
    const m = decl.exec(lines[i]);
    if (!m) continue;
    const name = m[2] ?? m[4];
    let j = i;
    // A one-line arrow helper has no closing-brace line of its own.
    const oneLine = m[4] !== undefined && /;\s*$/.test(lines[i]);
    if (!oneLine) {
      j = i + 1;
      while (j < lines.length && !/^\}/.test(lines[j])) j++;
    }
    out.push({ name, exported: !!(m[1] ?? m[3]), start: i + 1, body: lines.slice(i, j + 1).join("\n") });
    i = j;
  }
  return out;
}

/** Classify every exported mutating handler of one route file. */
export function analyzeRouteSource(raw: string): HandlerFinding[] {
  const src = strip(raw);
  const fns = topLevelFunctions(src);
  // Helpers that guard, transitively (a helper calling a guarding helper).
  const guarding = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of fns) {
      if (guarding.has(f.name) || (MUTATING as readonly string[]).includes(f.name) || f.name === "GET") continue;
      const callsGuarding = Array.from(guarding).some((g) => new RegExp(`\\b${g}\\s*\\(`).test(f.body));
      if (GUARD.test(f.body) || callsGuarding) { guarding.add(f.name); grew = true; }
    }
  }
  const out: HandlerFinding[] = [];
  for (const f of fns) {
    if (!f.exported || !(MUTATING as readonly string[]).includes(f.name)) continue;
    const viaHelper = Array.from(guarding).some((g) => new RegExp(`\\b${g}\\s*\\(`).test(f.body));
    let kind: HandlerKind;
    if (GUARD.test(f.body) || viaHelper) kind = "guarded";
    else if (ADMITS_STAFF.test(f.body)) kind = "anyStaff";
    // Owner-only is STRONGER than any permission — a staffer cannot reach it at
    // all. Settings, Stripe Connect, Plaid and tier live here deliberately.
    else if (OWNER_CHECK.test(f.body)) kind = "ownerOnly";
    else kind = "noRoleCheck";
    out.push({ verb: f.name, line: f.start, kind });
  }
  return out;
}

/**
 * Handlers that are correct WITHOUT a permission helper, each with the reason.
 * Key: "<repo-relative route file>#<VERB>". Adding a line here is a decision,
 * not a way to get a build green — say why the handler is safe.
 */
export const APPROVED_INLINE: Record<string, string> = {
  "app/api/messages/dm/[userId]/route.ts#POST":
    "Session-only by design: members may DM staff and owners freely. Recipient and subject athlete are both looked up with clubId = the caller's club, so there is no cross-tenant reach.",
};

type Row = { rel: string; verb: string; line: number };

export function scanTree(): { anyStaff: Row[]; ownerOnly: Row[]; noRoleCheck: Row[]; handlers: number } {
  const anyStaff: Row[] = [];
  const ownerOnly: Row[] = [];
  const noRoleCheck: Row[] = [];
  let handlers = 0;
  for (const file of walk(API)) {
    const rel = relative(ROOT, file).split("\\").join("/");
    if (NOT_STAFF_FACING.some((re) => re.test("/" + rel))) continue;
    for (const h of analyzeRouteSource(readFileSync(file, "utf8"))) {
      handlers++;
      if (h.kind === "guarded") continue;
      if (APPROVED_INLINE[`${rel}#${h.verb}`]) continue;
      const row = { rel, verb: h.verb, line: h.line };
      if (h.kind === "anyStaff") anyStaff.push(row);
      else if (h.kind === "ownerOnly") ownerOnly.push(row);
      else noRoleCheck.push(row);
    }
  }
  return { anyStaff, ownerOnly, noRoleCheck, handlers };
}

/**
 * Was 26 when first measured on 2026-09-04 (file-level). The owner-approved
 * mapping took it to zero on 2026-09-08. On 2026-10-07 the check became
 * HANDLER-level, which found six more role-only handlers hiding in files whose
 * other handlers were guarded; those were fixed the same day, so this is still
 * zero and still a WALL, not a ratchet.
 *
 * Do not raise this to get a build green.
 */
const BASELINE = 0;
/** Handlers with no role check at all — every one must be in APPROVED_INLINE. */
const NO_ROLE_BASELINE = 0;

function main() {
  const { anyStaff, ownerOnly, noRoleCheck, handlers } = scanTree();
  const note = (s: string) => console.log(s);
  let failed = false;

  note("\nPERMISSION BOUNDARY — staff-facing mutating API handlers (checked one handler at a time)");
  note(`  middleware matches /dashboard, /admin, /member — NOT /api, so the handler's`);
  note("  own guard is the entire boundary.\n");
  note(`  mutating handlers checked: ${handlers}`);
  note(`  admits ANY staff regardless of permissions: ${anyStaff.length} (baseline ${BASELINE})`);
  for (const r of anyStaff) note(`      ${r.rel}:${r.line}  [${r.verb}]`);
  note(`\n  no role check at all: ${noRoleCheck.length} (baseline ${NO_ROLE_BASELINE})`);
  for (const r of noRoleCheck) note(`      ${r.rel}:${r.line}  [${r.verb}]`);
  note(`\n  owner-only (stronger than a permission — not counted): ${ownerOnly.length}`);
  note(`  approved inline patterns (see APPROVED_INLINE for each reason): ${Object.keys(APPROVED_INLINE).length}`);

  if (anyStaff.length > BASELINE || noRoleCheck.length > NO_ROLE_BASELINE) {
    failed = true;
    note("");
    note("  ✗ a mutating HANDLER reaches the database without checking permissions.");
    note("    (A guard in another handler of the same file does not count.)");
    note("");
    note("    Gate it with requirePermission(session, <key>, <level>) from lib/apiGuard,");
    note("    or requirePermissionLive for anything that moves money or changes who");
    note("    works what (it re-reads the staff row rather than trusting the JWT).");
    note("");
    note("    Keys: members attendance classes events schedule messages documents");
    note("          finances billing reports staff");
    note("    Levels: none view send edit full. OWNER bypasses everything.");
    note("    Privates are gated under `events`, not a `privates` key.");
    note("    Staff ASSIGNMENTS (who coaches a class / works an event) need schedule:edit.");
    note("");
    note("    TypeScript gotcha: replacing an inline `session.user.role` check with");
    note("    requirePermission loses null-narrowing on `session`. Add an explicit");
    note("    `if (!session) return 401;` before the guard or the build fails with");
    note("    \"'session' is possibly null\".");
  } else {
    note("\n  ✓ holding at zero — every mutating handler has its own guard");
  }

  // Stale allowlist entries hide the next real hole behind an old reason.
  const stale = Object.keys(APPROVED_INLINE).filter((k) => {
    const [rel, verb] = k.split("#");
    try {
      return !analyzeRouteSource(readFileSync(join(ROOT, rel), "utf8")).some((h) => h.verb === verb && h.kind !== "guarded");
    } catch {
      return true;
    }
  });
  if (stale.length) {
    failed = true;
    note("\n  ✗ APPROVED_INLINE entries that no longer apply (handler gone or now guarded) — remove them:");
    for (const k of stale) note(`      ${k}`);
  }

  note(`\n${"─".repeat(70)}`);
  if (failed) {
    note("✗ permission boundary guard failed\n");
    process.exit(1);
  }
  note("✓ permission boundary guard passed\n");
}

if (require.main === module) main();
