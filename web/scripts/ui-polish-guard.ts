// B23 (2026-09-28) — UI polish guard, from the staff dashboard audit
// (docs/improvement/staff-dashboard-ia-and-design-audit.md §2a, §5.3, §5.4).
//
//   npx tsx scripts/ui-polish-guard.ts
//
// No database, no network — this reads the source tree (app/dashboard/** and
// components/**, .tsx only; comments stripped first).
//
// RULE 1 — page titles go through components/PageHeader.tsx.
//   36 of 51 dashboard pages used to hand-roll `<h1 className="text-3xl …">`
//   with non-wrapping action rows: three h1 sizes for one semantic level, and
//   the tablet overflow PageHeader's own comment records fixing. PageHeader is
//   the only responsive title block (text-xl → sm:text-2xl, actions wrap until
//   lg). A new `<h1` anywhere else fails unless it is in H1_ALLOW below.
//
// RULE 2 — no text under 12px.
//   `text-[Npx]` with N < 12 (10px, 10.5px, 11px, 11.5px, 9px …) and inline
//   `fontSize: 10|11` are below the platform floor (audit §5.3). Exceptions are
//   listed in SMALL_TEXT_ALLOW with the exact snippet and a reason; a snippet
//   not listed there fails.
//
// Both allowlists are exact. Don't widen them to make a build pass — use
// PageHeader and text-xs/text-[12px] instead.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(__dirname, "..");
const SCAN_DIRS = ["app/dashboard", "components"];

// ── RULE 1 allowlist: file → how many <h1 it may contain, and why ──────────
const H1_ALLOW: Record<string, { max: number; reason: string }> = {
  "components/PageHeader.tsx": { max: 1, reason: "the shared title primitive itself" },
  "components/members/MemberProfileHeader.tsx": {
    max: 1,
    reason: "profile identity header (avatar + name + track pills) — the Members handoff's own design, not a page title block",
  },
  "components/staff/StaffProfile.tsx": {
    max: 1,
    reason: "staff profile identity header, mirrors MemberProfileHeader by design",
  },
  "components/PayrollTabs.tsx": {
    max: 1,
    reason: "title + role=tablist in one block; PageHeader has no tabs slot. Uses PageHeader's exact h1 classes",
  },
  "components/registration/RegistrationCard.tsx": {
    max: 1,
    reason: "member-facing registration status card (stone palette), not a dashboard page header",
  },
  "app/dashboard/members/[id]/billing/page.tsx": {
    max: 1,
    reason: "title is followed by a row of status chips (a <div>) that PageHeader's <p> description can't hold. Uses PageHeader's exact h1 classes",
  },
  "app/dashboard/settings/branded-app/page.tsx": {
    max: 1,
    reason: "the Pro-plan upgrade gate is a centred card whose h1 is the card title; the page's real header uses PageHeader",
  },
  // Owned by concurrent workstreams (B11 schedule / events) and out of scope
  // for B23. Baseline counts — they may only go down.
  "app/dashboard/events/[id]/roster/page.tsx": { max: 1, reason: "events workstream — convert when that work lands" },
  "app/dashboard/staff/schedule/page.tsx": { max: 1, reason: "staff-schedule workstream — convert when that work lands" },
  "app/dashboard/staff/availability/page.tsx": { max: 1, reason: "staff-schedule workstream — convert when that work lands" },
};

// ── RULE 2 allowlist: exact snippets that may keep sub-12px text ───────────
const SMALL_TEXT_ALLOW: Record<string, { snippets: string[]; reason: string }> = {
  "components/reports/MembershipTab.tsx": {
    snippets: [
      'text-[10px] text-text-muted whitespace-nowrap">{t.label',
      'text-[10px] text-text-muted tabular-nums">{fmtPct(t.churnRate)',
    ],
    reason: "churn bar-chart axis labels under 24px-min columns; 12px collides at 375px",
  },
  "components/reports/SnapshotTab.tsx": {
    snippets: ['text-[10px] text-text-muted whitespace-nowrap">'],
    reason: "cash bar-chart month axis labels under 24px-min columns",
  },
  "components/reports/CashFlowTab.tsx": {
    snippets: [
      'justify-center text-[10px] text-text-muted">',
      "text-[11px] sm:text-xs font-semibold ${it.text}",
      'text-[10px] sm:text-[11px] text-text-muted uppercase tracking-wide font-semibold">{it.label}',
    ],
    reason: "cash waterfall sized to fit 5 × 56px columns on a 375px phone (see its comment); values/labels inside bars",
  },
  "app/dashboard/members/migration/page.tsx": {
    snippets: ["styles: { fontSize: 8, cellPadding: 2"],
    reason: "jsPDF autoTable export — PDF points, not screen pixels",
  },
  "components/member/WeekCalendar.tsx": {
    snippets: ["block text-[9.5px] font-bold rounded-[5px]"],
    reason: "event chips inside a 7-column week grid (~45px cells at 375px)",
  },
  "app/dashboard/settings/branded-app/page.tsx": {
    snippets: ['text-[9px] font-medium leading-none">{item.label}'],
    reason: "tab labels inside the scaled phone-mockup preview — depicts the app at reduced scale",
  },
  "app/dashboard/products/[id]/tags/page.tsx": {
    snippets: ['text-[11px]">{hint}', "text-[8px] text-stone-500 break-all", "text-[11px] text-stone-500 break-all"],
    reason: "print-only price tags/poster laid out in inches; the URL line is a fallback under the QR code",
  },
};
// Owned by concurrent workstreams — baseline counts, may only go down.
const SMALL_TEXT_BASELINE: Record<string, number> = {
  "app/dashboard/events/[id]/roster/page.tsx": 4,
  "app/dashboard/events/page.tsx": 69,
  "app/dashboard/events/bundles/page.tsx": 5,
  "components/events/AutoDiscountsEditor.tsx": 7,
  "components/events/EventEditor.tsx": 41,
  "components/events/EventRow.tsx": 13,
  "components/events/AttendeesModal.tsx": 8,
  "components/events/SpotPicker.tsx": 1,
  "components/events/EntriesEditor.tsx": 1,
  "app/dashboard/calendar/page.tsx": 11,
  "app/dashboard/staff/schedule/page.tsx": 26,
  "app/dashboard/staff/availability/page.tsx": 5,
};

const SMALL_TEXT = /text-\[(?:\d|1[01])(?:\.\d+)?px\]|fontSize:\s*(?:\d|1[01])(?:\.\d+)?\b(?!\.)|fontSize:\s*"(?:\d|1[01])(?:\.\d+)?px"/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

// Drop /* … */ (incl. JSX {/* … */}) and whole-line // comments so an
// explanation that mentions "<h1" or "text-[11px]" isn't counted.
function stripComments(src: string): string {
  return src
    // Only a /* that follows whitespace or "{" opens a comment — "image/*"
    // in an accept= attribute must not swallow the file up to the next */.
    .replace(/(^|[{\s])\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const failures: string[] = [];
let files = 0;
for (const d of SCAN_DIRS) {
  for (const abs of walk(join(ROOT, d))) {
    files++;
    const rel = relative(ROOT, abs).split(sep).join("/");
    const src = stripComments(readFileSync(abs, "utf8"));

    // Rule 1
    const h1 = (src.match(/<h1\b/g) ?? []).length;
    if (h1 > 0) {
      const allow = H1_ALLOW[rel];
      if (!allow) failures.push(`${rel}: hand-rolled <h1> (${h1}) — use components/PageHeader.tsx`);
      else if (h1 > allow.max) failures.push(`${rel}: ${h1} <h1>, allowlist permits ${allow.max}`);
    }

    // Rule 2
    let rest = src;
    for (const s of SMALL_TEXT_ALLOW[rel]?.snippets ?? []) rest = rest.split(s).join("");
    const lines = rest.split("\n");
    const hits: string[] = [];
    lines.forEach((l, i) => {
      const m = l.match(SMALL_TEXT);
      if (m) hits.push(`${rel}:${i + 1}: ${m.join(", ")}`);
    });
    const base = SMALL_TEXT_BASELINE[rel];
    const n = hits.reduce((a, h) => a + h.split(", ").length, 0);
    if (base !== undefined) {
      if (n > base) failures.push(`${rel}: ${n} sub-12px text sizes, baseline is ${base} (may only go down)`);
    } else if (hits.length) {
      for (const h of hits) failures.push(`${h} — text under 12px (use text-xs / text-[12px])`);
    }
  }
}

// Allowlist hygiene: an entry for a file that no longer needs it is stale.
for (const [rel, a] of Object.entries(SMALL_TEXT_ALLOW)) {
  let src = "";
  try {
    src = readFileSync(join(ROOT, rel), "utf8");
  } catch {
    failures.push(`SMALL_TEXT_ALLOW: ${rel} no longer exists — remove the entry`);
    continue;
  }
  for (const s of a.snippets) if (!src.includes(s)) failures.push(`SMALL_TEXT_ALLOW: ${rel}: snippet not found, remove it: ${s}`);
}
for (const rel of Object.keys(H1_ALLOW)) {
  try {
    readFileSync(join(ROOT, rel));
  } catch {
    failures.push(`H1_ALLOW: ${rel} no longer exists — remove the entry`);
  }
}

if (failures.length) {
  console.error(`ui-polish-guard: ${failures.length} failure(s)\n  ` + failures.join("\n  "));
  process.exit(1);
}
console.log(`ui-polish-guard: OK — ${files} files, page titles via PageHeader, no text under 12px outside the allowlist`);
