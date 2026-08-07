// Phase 4.5.11 — the two grep guards.
//
//   npm run test:members-guards
//
// No database, no network — this reads the source tree.
//
//   GUARD 1  No hard-coded vendor name may appear in user-facing code.
//            HARD FAIL. This one is green today and must stay green.
//
//   GUARD 2  The deprecated migration vocabulary (migrationGroup,
//            migrationFinalAction, readiness*) must disappear from the UI.
//            RATCHET, not a hard fail: those symbols are still on screen today
//            and 4.5.2 / 4.5.7 are what remove them. The guard records the
//            current count as a baseline and fails only if it GROWS. A test
//            that is known-red from the day it is written gets ignored within a
//            week; a ratchet keeps working the whole time.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..");
const SCAN_DIRS = ["app", "components", "lib"];

let failed = false;
const note = (s: string) => console.log(s);

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === ".next" || e.startsWith(".")) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((x) => p.endsWith(x))) out.push(p);
  }
  return out;
}

const ALL_SOURCE = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d), [".ts", ".tsx"]));
const TSX_ONLY = ALL_SOURCE.filter((f) => f.endsWith(".tsx"));

// ═══════════════════════════════════════════════════════════════════════════
// GUARD 1 — no hard-coded vendor names
// ═══════════════════════════════════════════════════════════════════════════
// The rule from the handoff: "Nowhere in the UI should a specific
// previous-software name appear as a literal." The label comes from one
// owner-typed field and degrades to "your previous system" when blank.
//
// Why this needs a guard rather than a code review: a vendor name in a
// placeholder or an empty state reads as helpful example copy, so it gets added
// back by well-meaning people. It shipped once already — the import wizard's
// "e.g. Jackrabbit, Mindbody, spreadsheet" placeholder, removed in this phase.

const VENDOR_PATTERNS: [string, RegExp][] = [
  ["WellnessLiving", /wellness\s*living/i],
  ["JackRabbit", /jack\s*rabbit/i],
  ["iClassPro", /i\s*class\s*pro/i],
  ["Mindbody", /mind\s*body/i],
  ["Zen Planner", /zen\s*planner/i],
  ["PushPress", /push\s*press/i],
  ["TeamSnap", /team\s*snap/i],
  ["SportsEngine", /sports\s*engine/i],
  ["Gymdesk", /gym\s*desk/i],
  ["ClubReady", /club\s*ready/i],
];

/**
 * Strip comments before scanning. A vendor name in a comment explaining a past
 * incident is documentation, not UI — and rewriting history to satisfy a linter
 * makes the incident harder to understand later. Only rendered code counts.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

note("\nGUARD 1 — hard-coded vendor names (user-facing code)");
const vendorHits: string[] = [];
for (const file of ALL_SOURCE) {
  const code = stripComments(readFileSync(file, "utf8"));
  for (const [name, re] of VENDOR_PATTERNS) {
    if (re.test(code)) {
      const line = code.split("\n").findIndex((l) => re.test(l)) + 1;
      vendorHits.push(`  ${relative(ROOT, file)}:${line} — ${name}`);
    }
  }
}

if (vendorHits.length) {
  failed = true;
  note(`  ✗ ${vendorHits.length} vendor literal(s) in rendered code:`);
  vendorHits.forEach(note);
  note("");
  note("  The previous-system label has exactly one source: the owner-typed");
  note("  field at import (ImportBatch.sourceLabel, else Member.legacySource).");
  note("  Read it through lib/memberTracks.resolveSourceLabel, which degrades to");
  note('  "your previous system" rather than naming a product.');
} else {
  note(`  ✓ none in ${ALL_SOURCE.length} source files (comments excluded)`);
}

// ═══════════════════════════════════════════════════════════════════════════
// GUARD 2 — deprecated migration vocabulary, as a ratchet
// ═══════════════════════════════════════════════════════════════════════════
// The schema columns stay — this is a UI deprecation only. Their information is
// expressed by Track 3's step + whose-turn instead.

const DEPRECATED = [
  "migrationGroup",
  "migrationFinalAction",
  "readinessLabel",
  "readinessReasons",
  "GROUP_FILTERS",
  "READINESS_FILTERS",
];

/**
 * Baseline was 8 when measured on 2026-08-04, before 4.5.2 and 4.5.7 rewrote
 * the members list and the migration dashboard. It reached 0 on 2026-08-07,
 * which is the Phase 4.5 exit criterion, so this is now a HARD FAIL rather
 * than a ratchet: any reintroduction of the old vocabulary breaks the build.
 *
 * The SCHEMA COLUMNS are all still present and still populated — this guard is
 * about what a staffer is shown and asked to maintain, not about dropping data.
 * `deriveReadiness` still reads migrationGroup for the billing centre's own
 * readiness chip; what went is the second place a human was asked to classify
 * somebody by hand, which the 7-step meter now answers from facts.
 *
 * Never raise it.
 */
const DEPRECATED_BASELINE = 0;

note("\nGUARD 2 — deprecated migration vocabulary in .tsx (ratchet)");
let deprecatedCount = 0;
const perSymbol: string[] = [];
for (const sym of DEPRECATED) {
  const re = new RegExp(`\\b${sym}\\b`);
  const files = TSX_ONLY.filter((f) => re.test(stripComments(readFileSync(f, "utf8"))));
  deprecatedCount += files.length;
  if (files.length) perSymbol.push(`    ${sym}: ${files.map((f) => relative(ROOT, f)).join(", ")}`);
}

note(`  current: ${deprecatedCount} file-symbol pair(s), baseline ${DEPRECATED_BASELINE}`);
perSymbol.forEach(note);

if (deprecatedCount > DEPRECATED_BASELINE) {
  failed = true;
  note(`  ✗ went UP (${DEPRECATED_BASELINE} → ${deprecatedCount}). The deprecated`);
  note("    vocabulary is being re-introduced; Track 3 step + whose-turn replaces it.");
} else if (deprecatedCount < DEPRECATED_BASELINE) {
  note(`  ✓ went DOWN (${DEPRECATED_BASELINE} → ${deprecatedCount}) — lower DEPRECATED_BASELINE to ${deprecatedCount}`);
} else {
  note("  ✓ holding at baseline (removal is 4.5.2 + 4.5.7 work)");
}

// ═══════════════════════════════════════════════════════════════════════════
note(`\n${"─".repeat(62)}`);
if (failed) {
  note("✗ grep guards failed\n");
  process.exit(1);
}
note("✓ grep guards passed\n");
