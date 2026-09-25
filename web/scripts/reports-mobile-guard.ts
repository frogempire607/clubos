// B5 (plan §2.5.12) — Reports on phones. A static guard over the Reports hub
// source so the responsive rules can't quietly regress. No browser needed.
//
//   npx tsx scripts/reports-mobile-guard.ts
//
// What it locks in:
//   • the tab bar scrolls sideways and is never a <select>
//   • every <table> sits inside <ScrollTable> (momentum scroll, pinned first
//     column, right-edge fade) or is desktop-only with a phone card list
//   • nothing forces a width wider than a 375px phone (min-w-[Npx] > 343 must
//     be sm:/md:/lg:-scoped)
//   • no window.innerWidth reads during render (use the live media query)
//   • KPI cards go 4 → 2 → 1
//   • P&L has a phone layout; drill-through is a full-screen sheet on phones
//   • the reliability strip is never hidden on phones
//   • the touch-target rule exists and is applied to both Reports pages
//   • chart month labels don't slip a month in US time zones

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { monthLabel } from "../lib/reportsMonthLabel";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) pass++; else fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
};

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const reportFiles = readdirSync(join(ROOT, "components/reports")).filter((f) => f.endsWith(".tsx")).map((f) => `components/reports/${f}`);
const pages = ["app/dashboard/reports/page.tsx", "app/dashboard/reports/imports/page.tsx"];
const all = [...reportFiles, ...pages].map((p) => ({ p, s: read(p) }));

// ── tab bar ──
const hub = read("app/dashboard/reports/page.tsx");
ok("tab bar scrolls horizontally", /role="tablist"[\s\S]{0,300}overflow-x-auto/.test(hub));
ok("tab bar never collapses to <select>", !/<select/.test(hub));
ok("active tab scrolls into view", /scrollIntoView\(/.test(hub));
ok("tabs don't shrink (scroll instead)", /shrink-0 text-xs sm:text-sm/.test(hub));

// ── tables ──
for (const { p, s } of all) {
  const tables = (s.match(/<table\b/g) ?? []).length;
  if (tables === 0) continue;
  const wrapped = (s.match(/<ScrollTable\b/g) ?? []).length;
  ok(`${p}: every <table> in a ScrollTable (${tables})`, wrapped >= tables, `${wrapped} ScrollTable for ${tables} tables`);
}
const rt = read("components/reports/responsive.tsx");
ok("ScrollTable pins the first column", /\[&_td:first-child\]:sticky/.test(rt) && /\[&_th:first-child\]:left-0/.test(rt));
ok("ScrollTable momentum scroll", /WebkitOverflowScrolling: "touch"/.test(rt));
ok("ScrollTable right-edge fade", /bg-gradient-to-l from-surface/.test(rt));

// ── widths ──
for (const { p, s } of all) {
  const bad: string[] = [];
  for (const m of s.matchAll(/(^|[\s"`'])((?:[a-z]+:)*)(min-)?w-\[(\d+)px\]/g)) {
    const px = Number(m[4]);
    if (px > 343 && !m[2]) bad.push(m[0].trim());
  }
  ok(`${p}: nothing wider than a phone unless breakpoint-scoped`, bad.length === 0, bad.join(", "));
}
for (const { p, s } of all) ok(`${p}: no window.innerWidth`, !/window\.innerWidth/.test(s));

// ── KPI + P&L + drill ──
const ue = read("components/reports/UnitEconomicsTab.tsx");
ok("KPI cards 4 → 2 → 1", /grid-cols-1 sm:grid-cols-2 lg:grid-cols-4/.test(ue));
const pnl = read("components/reports/PnlTab.tsx");
ok("P&L phone layout exists", /function MobilePnl/.test(pnl) && /md:hidden space-y-3/.test(pnl));
ok("P&L phone layout picks one period", /role="tablist" aria-label="Period"/.test(pnl));
ok("P&L drill is full-screen on phones", /h-\[100dvh\] sm:h-auto/.test(pnl) && /rounded-none sm:rounded-xl/.test(pnl));
ok("P&L drill locks page scroll", /useBodyScrollLock\(true\)/.test(pnl));

// ── strips ──
const rel = read("components/reports/ReliabilityStrip.tsx");
ok("reliability strip never hidden on phones", !/\bhidden\b[^"]*"[^>]*>\s*\{sections/.test(rel) && /flex flex-col sm:flex-row/.test(rel));
ok("reliability rows are 44px on phones", /min-h-\[44px\] sm:min-h-0/.test(rel));

// ── touch targets ──
const css = read("app/globals.css");
ok("touch-target rule exists", /@media \(pointer: coarse\)[\s\S]*\.reports-touch button[\s\S]*min-height: 44px/.test(css));
for (const p of pages) ok(`${p}: root carries reports-touch`, /className="reports-touch /.test(read(p)));

// ── range sheet ──
const rd = read("components/reports/RangeDropdown.tsx");
ok("range: bottom sheet on phones", /sm:hidden fixed inset-0 z-50 flex items-end/.test(rd));
ok("range: 44px rows on phones", /mobile \? "min-h-\[44px\]"/.test(rd));
ok("range: native date inputs", (rd.match(/type="date"/g) ?? []).length === 2);

// ── chart ──
const snap = read("components/reports/SnapshotTab.tsx");
ok("12-month chart: last 6 on phones + toggle", /trend\.slice\(-6\)/.test(snap) && /Show all/.test(snap));
ok("chart columns stretch so bar % heights resolve", /flex items-stretch gap-2 h-40/.test(snap));
ok("no UTC month parse in chart", !/new Date\(b\.month\)/.test(snap));
ok("monthLabel Sep", monthLabel("2026-09-01") === "Sep", `got ${monthLabel("2026-09-01")} (TZ=${process.env.TZ ?? "local"})`);
ok("monthLabel Jan", monthLabel("2027-01-01") === "Jan");
ok("monthLabel junk", monthLabel("") === "");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
