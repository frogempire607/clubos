/**
 * Every staff-facing API handler — READS included — must refuse a MEMBER login.
 *
 *   npx tsx scripts/staff-route-role-guard.ts
 *
 * No database, no network: this reads the source tree.
 *
 * ── The hole this closes (found 2026-11-15) ─────────────────────────────────
 *
 * `middleware.ts` matches /dashboard, /admin and /member — NOT /api. It keeps a
 * parent out of the dashboard PAGES and does nothing about the requests behind
 * them. `scripts/permission-boundary-guard.ts` already walls off every
 * MUTATING handler, but it never looked at GET. So a long list of read routes
 * shipped with only
 *
 *     if (!session) return 401;
 *
 * and any signed-in parent or athlete could call them directly:
 * `/api/export/members` returned the whole roster as a CSV — every family's
 * emails, phones, birthdates, addresses and guardian contacts, minors
 * included. `/api/members`, `/api/members/[id]`, the attendance rosters, the
 * transaction and attendance exports, every discount code and every message
 * group were open the same way. Because member self-signup needs only a club
 * slug, "any signed-in member" meant "anyone".
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * A handler in a staff-facing route file must, in ITS OWN body (or through a
 * helper defined in the same file), do one of:
 *   - call a permission helper from lib/apiGuard / lib/permissions
 *   - call requireStaff(session)            — owner or staff, any permissions
 *   - compare the session role explicitly   — role !== "OWNER", etc.
 *
 * A guard in a sibling handler of the same file does not count.
 *
 * This is a WALL: the baseline is zero and stays zero. A handler that is
 * genuinely for every signed-in person goes in ANY_SESSION_OK with its reason.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { requireStaff } from "../lib/apiGuard";

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

/** Anything that settles "is this caller owner/staff, and allowed?". */
const ROLE_GUARD = new RegExp(
  [
    // permission helpers (owner bypasses; a MEMBER is refused by all of them)
    String.raw`require(Permission|PermissionLive|Owner|OwnerLive|MessagesSubScope|Staff)\s*\(`,
    String.raw`has(PermissionLive|MessagesSubScope|BillingSubScope|ReportScope|ReportsAny)\s*\(`,
    String.raw`isOwnerLive\s*\(`,
    String.raw`assertCanRespondToRegistration|canDecideRegistrations|checkAssignmentChange\s*\(`,
    String.raw`resolveFamilyCapabilities\s*\(|canStartPreview\s*\(`,
    // explicit role comparisons
    String.raw`role\s*[!=]==\s*"(OWNER|STAFF|MEMBER)"`,
    String.raw`\["OWNER",\s*"STAFF"\]`,
    String.raw`isStaffRole\s*\(`,
  ].join("|"),
);

/**
 * Not staff-facing, so "is this caller staff?" is the wrong question:
 *   member/…        the client portal — authorized by identity + guardian links
 *   public/…        deliberately anonymous
 *   [token]         authenticated BY the token; there is no session
 *   webhook / cron  signature- or CRON_SECRET-authenticated
 *   auth/…          sign-in, sign-up, password flows
 */
const NOT_STAFF_FACING = [
  /\/api\/(member|public|auth|stripe\/webhook|cron|webhooks|well-known|unsubscribe)\//,
  /\[token\]/,
  // account/…  deleting YOUR OWN account — every signed-in person, by design
  /\/api\/account\//,
];

/**
 * Handlers that are correct for ANY signed-in person (or for nobody signed in
 * at all), each with the reason. Key: "<repo-relative route file>#<VERB>".
 * Adding a line here is a decision, not a way to get a build green.
 */
export const ANY_SESSION_OK: Record<string, string> = {
  "app/api/checkin/[id]/route.ts#GET":
    "The door QR target. Public by design — it names one class or event so a visitor can sign in or sign up; it returns no person's data.",
  "app/api/preview/route.ts#GET":
    "Reads the caller's own preview cookie. No database row is returned.",
  "app/api/preview/route.ts#DELETE":
    "Clears the caller's own preview cookie.",
  "app/api/upload/route.ts#POST":
    "Members upload their own profile photo (components/ImageUpload). The file is stored under the caller's club and the caller's user id.",
  "app/api/help/search/route.ts#GET":
    "Searches the static help articles in lib/helpContent. No club data.",
};

const VERBS = ["GET", "POST", "PATCH", "PUT", "DELETE"];

type Fn = { name: string; exported: boolean; start: number; body: string };

// Function extent is "from the declaration to the first line that starts with
// `}` in column 0" — the repo is formatted so top-level declarations close in
// column 0 and nothing inside a body does. Same rule as
// scripts/permission-boundary-guard.ts.
function topLevelFunctions(src: string): Fn[] {
  const out: Fn[] = [];
  const lines = src.split("\n");
  const decl = /^(export\s+)?(?:async\s+)?function\s+(\w+)\s*[(<]|^(export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/;
  for (let i = 0; i < lines.length; i++) {
    const m = decl.exec(lines[i]);
    if (!m) continue;
    const name = m[2] ?? m[4];
    let j = i;
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

export type Unguarded = { verb: string; line: number };

/** Exported handlers of one route file that never settle the caller's role. */
export function unguardedHandlers(raw: string): Unguarded[] {
  const src = strip(raw);
  const fns = topLevelFunctions(src);
  const guarding = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of fns) {
      if (guarding.has(f.name) || VERBS.includes(f.name)) continue;
      const callsGuarding = Array.from(guarding).some((g) => new RegExp(`\\b${g}\\s*\\(`).test(f.body));
      if (ROLE_GUARD.test(f.body) || callsGuarding) {
        guarding.add(f.name);
        grew = true;
      }
    }
  }
  const out: Unguarded[] = [];
  for (const f of fns) {
    if (!f.exported || !VERBS.includes(f.name)) continue;
    const viaHelper = Array.from(guarding).some((g) => new RegExp(`\\b${g}\\s*\\(`).test(f.body));
    if (ROLE_GUARD.test(f.body) || viaHelper) continue;
    out.push({ verb: f.name, line: f.start });
  }
  return out;
}

export function scanTree(): { open: { rel: string; verb: string; line: number }[]; handlers: number } {
  const open: { rel: string; verb: string; line: number }[] = [];
  let handlers = 0;
  for (const file of walk(API)) {
    const rel = relative(ROOT, file).split("\\").join("/");
    if (NOT_STAFF_FACING.some((re) => re.test("/" + rel))) continue;
    const src = readFileSync(file, "utf8");
    handlers += topLevelFunctions(strip(src)).filter((f) => f.exported && VERBS.includes(f.name)).length;
    for (const h of unguardedHandlers(src)) {
      if (ANY_SESSION_OK[`${rel}#${h.verb}`]) continue;
      open.push({ rel, verb: h.verb, line: h.line });
    }
  }
  return { open, handlers };
}

function selfTest(): string[] {
  const problems: string[] = [];
  const expect = (label: string, src: string, verbs: string[]) => {
    const got = unguardedHandlers(src).map((h) => h.verb).sort().join(",");
    if (got !== [...verbs].sort().join(",")) problems.push(`${label}: expected [${verbs}] unguarded, got [${got}]`);
  };
  expect(
    "session-only GET is caught",
    `export async function GET() {\n  const session = await getServerSession(authOptions);\n  if (!session) return new Response("Unauthorized", { status: 401 });\n  return prisma.member.findMany({ where: { clubId: session.user.clubId } });\n}\n`,
    ["GET"],
  );
  expect(
    "requireStaff passes",
    `export async function GET() {\n  const session = await getServerSession(authOptions);\n  const denied = requireStaff(session);\n  if (denied) return denied;\n  return 1;\n}\n`,
    [],
  );
  expect(
    "a guard in a sibling handler does not count",
    `export async function GET() {\n  const session = await getServerSession(authOptions);\n  return 1;\n}\nexport async function POST() {\n  const denied = requirePermission(session, "members", "edit");\n  return 2;\n}\n`,
    ["GET"],
  );
  expect(
    "a same-file helper that guards counts",
    `async function gate() {\n  const session = await getServerSession(authOptions);\n  return requireOwner(session);\n}\nexport async function GET() {\n  const denied = await gate();\n  return 1;\n}\n`,
    [],
  );
  expect(
    "a guard mentioned only in a comment does not count",
    `export async function GET() {\n  // requireStaff(session) would go here\n  return 1;\n}\n`,
    ["GET"],
  );
  expect(
    "an explicit role comparison passes",
    `export async function DELETE() {\n  if (session.user.role !== "OWNER") return 403;\n  return 1;\n}\n`,
    [],
  );
  // The helper itself: what each kind of caller gets back.
  const as = (role: string) => requireStaff({ user: { id: `guard-test-${role}`, role, clubId: "club-1" } });
  if (requireStaff(null)?.status !== 401) problems.push("requireStaff(null) must answer 401");
  if (as("MEMBER")?.status !== 403) problems.push("requireStaff must answer 403 for a MEMBER login");
  if (requireStaff({ user: { id: "guard-test-none", clubId: "club-1" } })?.status !== 403) {
    problems.push("requireStaff must answer 403 when the session carries no role");
  }
  if (as("STAFF") !== null) problems.push("requireStaff must allow STAFF");
  if (as("OWNER") !== null) problems.push("requireStaff must allow OWNER");
  return problems;
}

function main() {
  const note = (s: string) => console.log(s);
  let failed = false;

  const self = selfTest();
  if (self.length) {
    failed = true;
    note("✗ the guard's own checks failed:");
    for (const p of self) note(`    ${p}`);
  }

  const { open, handlers } = scanTree();
  note("\nSTAFF ROUTES REFUSE MEMBER LOGINS — every handler, reads included");
  note(`  handlers checked: ${handlers}`);
  note(`  reachable by any signed-in member: ${open.length} (must be 0)`);
  for (const r of open) note(`      ${r.rel}:${r.line}  [${r.verb}]`);

  if (open.length) {
    failed = true;
    note("");
    note("  ✗ a staff-facing handler never checks WHO is calling. A parent's login");
    note("    reaches it directly — the dashboard pages are hidden from members,");
    note("    the API behind them is not.");
    note("");
    note("    Add, right after the `if (!session) return 401;` line:");
    note("        const denied = requireStaff(session);");
    note("        if (denied) return denied;");
    note("    or a stricter requirePermission(session, <key>, <level>).");
    note("    If the handler really is for every signed-in person, add it to");
    note("    ANY_SESSION_OK in this file and say why.");
  }

  const stale = Object.keys(ANY_SESSION_OK).filter((k) => {
    const [rel, verb] = k.split("#");
    try {
      return !unguardedHandlers(readFileSync(join(ROOT, rel), "utf8")).some((h) => h.verb === verb);
    } catch {
      return true;
    }
  });
  if (stale.length) {
    failed = true;
    note("\n  ✗ ANY_SESSION_OK entries that no longer apply (handler gone or now guarded) — remove them:");
    for (const k of stale) note(`      ${k}`);
  }

  note(`\n${"─".repeat(70)}`);
  if (failed) {
    note("✗ staff route role guard failed\n");
    process.exit(1);
  }
  note("✓ staff route role guard passed\n");
}

if (require.main === module) main();
