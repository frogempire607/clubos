// Phase 5 — the sport-vocabulary guard.
//
//   npm run test:sport-terms
//
// No database, no network — this reads the source tree.
//
// THE RULE: no sport-specific term may NAME A FEATURE OR A FIELD in the
// screens every club shares.
//
// The distinction matters, and the first draft of this guard got it wrong by
// flagging 20 legitimate strings. Naming a SPORT is fine and often necessary:
// the landing page says "built for wrestling, BJJ, MMA, gymnastics", onboarding
// asks a club to pick their sport from a list that includes Wrestling, and the
// signup slug placeholder is "apex-wrestling". None of that tells a judo club
// their software was written for somebody else.
//
// Naming a FEATURE after one sport does. "Weight class" as a field label,
// "Wrestle an additional dual" as a checkbox, "126 is stacked" as an example —
// those appear on a screen a soccer coach uses, describing a thing the product
// does, in a vocabulary they don't share.
//
// So: marketing, auth and onboarding are out of scope by directory, and the
// patterns below are the feature vocabulary rather than the sport names.
// AthletixOS is sold to any youth sports organisation. A judo club, a swim
// club and a soccer club all see the same screens, and every one of them reads
// "Weight class" or "Wrestle an additional dual" as nonsense written for
// somebody else.
//
// This is modelled on the vendor-literal guard from Phase 4.5.10 and exists
// for the same reason: a sport term in a placeholder or an example reads as
// helpful copy, so well-meaning people add it back. It shipped once already —
// the propose-a-change form asked coaches for a weight class and a division,
// offered "Wrestle an additional dual", and suggested "126 is stacked — he'd
// get more matches at 132" (fixed 2026-08-12).
//
// WHERE THE WORDS LEGITIMATELY LIVE:
//
//   · lib/eventCategories.ts — the preset catalogue. Those strings are choices
//     OFFERED TO AN OWNER ("Weight Class · wrestling, judo, boxing, MMA"), not
//     copy shown to a family. This used to be out of scope by construction,
//     because only app/ and components/ were scanned. lib/ is scanned now (see
//     SCAN_DIRS), so the catalogue needs the one named entry in EXCLUDE_FILES
//     below. That is a FILE exclusion for a catalogue of owner-facing choices,
//     not a word added to an allowlist — which is the thing the note at
//     BASELINE forbids. A second preset catalogue would join it. A sport term
//     anywhere else in lib/ would not.
//   · scripts/ and prisma/ — fixtures, seeds and migrations. A local test club
//     called "Frog Empire Wrestling" is data, not UI.
//   · comments — an explanation of a past incident is documentation, and
//     rewriting history to satisfy a linter makes the incident harder to
//     understand later. Stripped before scanning, same as the vendor guard.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(__dirname, "..");
// In-product surfaces only — what a club sees after they've signed up. The
// marketing pages (app/page.tsx, app/pricing), the auth pages and onboarding
// legitimately name sports, and are deliberately not scanned.
//
// lib/ was added 2026-09-25. The guard protected the screens but not the
// words that navigate to them: every sidebar and bottom-nav label lives in
// lib/dashboardNav.ts, and the payee, permission and revenue-row labels live
// in lib/payouts.ts, lib/permissions.ts and lib/reportsRevenue.ts. A rendered
// string does not stop being rendered because it is declared one directory
// over, and an IA rename lands in exactly the file the guard could not see.
//
// Scanning the whole directory rather than an include-list of copy-bearing
// files is deliberate: the two failure modes are not symmetric. A file wrongly
// IN scope produces a hit somebody has to look at. A file wrongly OUT of scope
// produces silence, which is the failure this guard exists to prevent. Noise
// is recoverable; a miss is the thing that shipped in August.
const SCAN_DIRS = ["app/dashboard", "app/member", "app/e", "components", "lib"];

// Paths (relative to ROOT, posix separators) that are in a scanned directory
// but are not rendered copy. See WHERE THE WORDS LEGITIMATELY LIVE above.
// This is a list of FILES, never of words — read the BASELINE note before
// adding to it, and add a reason on the same line.
const EXCLUDE_FILES = new Set<string>([
  // The preset entry-category catalogue: labels and hints an OWNER picks from
  // when configuring an event type, not copy any family is shown.
  "lib/eventCategories.ts",
]);

function walk(dir: string): string[] {
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
    if (st.isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Word-boundary anchored on purpose. "mat" would hit format/estimate/match,
 * and a guard that cries wolf gets switched off within a week.
 */
const SPORT_PATTERNS: [string, RegExp][] = [
  // Feature copy, not sport names. "Wrestle an additional dual" is the shape
  // that shipped; "Wrestling academies" on the landing page is not this.
  ["wrestle as an action", /\bwrestl(e|es|ing)\s+(a|an|the|another|in)\b/i],
  ["weight class as a field", /\bweight\s*class(es)?\b/i],
  ["dual as an entry", /\bduals?\b/i],
  ["takedown", /\btakedowns?\b/i],
  ["singlet", /\bsinglets?\b/i],
  ["grappling", /\bgrappl(e|es|ing)\b/i],
  ["belt level as a field", /\bbelt\s*levels?\b/i],
  ["weigh-in", /\bweigh[-\s]?ins?\b/i],
  ["bout/mat as a field", /\b(bout|mat)\s*(number|assignment|side)\b/i],
];

const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d))).filter(
  (f) => !EXCLUDE_FILES.has(relative(ROOT, f).split(sep).join("/")),
);
const hits: string[] = [];

for (const file of files) {
  const code = stripComments(readFileSync(file, "utf8"));
  const lines = code.split("\n");
  for (const [name, re] of SPORT_PATTERNS) {
    lines.forEach((line, i) => {
      if (re.test(line)) hits.push(`  ${relative(ROOT, file)}:${i + 1} — ${name}: ${line.trim().slice(0, 100)}`);
    });
  }
}

/**
 * Baselined at 0 on 2026-08-12, the day the propose-a-change form stopped
 * being wrestling-shaped. It has never been anything other than 0 since, and
 * it is a HARD FAIL rather than a ratchet for that reason.
 *
 * If you are here because this failed: the fix is never to add the word to the
 * allowlist. Entry categories are configured per event and per event type
 * (lib/eventCategories.ts), so the club supplies the vocabulary and the UI
 * renders whatever they typed.
 */
const BASELINE = 0;

console.log("\nGUARD — sport-specific terms in rendered UI");
if (hits.length > BASELINE) {
  console.log(`  ✗ ${hits.length} sport literal(s) in ${SCAN_DIRS.join(", ")} (comments excluded):`);
  hits.forEach((h) => console.log(h));
  console.log("");
  console.log("  Entry categories are the club's own words: a label plus an optional");
  console.log("  value list, configured per event and per event type. Read them via");
  console.log("  resolveCategoryFields / labelForChangeKey in lib/eventCategories.ts");
  console.log("  rather than naming a sport in shared copy.");
  process.exit(1);
}

console.log(`  ✓ none in ${files.length} rendered source files (comments excluded)`);
process.exit(0);
