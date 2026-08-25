/**
 * §8.6.6 — where a non-renewing subscription actually stops.
 *
 * The whole point of planNonRenewal is that "the end of the billing period" and
 * "the end of the commitment" are different dates, and the code used to only
 * know the first one. Every case below is about that difference.
 *
 *   npx tsx scripts/non-renewal-tests.ts
 */
import { planNonRenewal } from "../lib/autopay";

let pass = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); return; }
  failures.push(detail ? `${label} — ${detail}` : label);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}

const NOW = new Date("2026-08-25T00:00:00.000Z");
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (x: Date | null) => (x ? x.toISOString().slice(0, 10) : null);

// The case that cost a third of the money: monthly billing, 3-month commitment.
{
  const p = planNonRenewal({
    minimumTermEndsAt: d("2026-11-24"), commitmentEndDate: null,
    currentPeriodEnd: d("2026-09-24"), paidThroughDate: null,
  }, NOW);
  check("a 3-month commitment billed monthly stops at the TERM, not the next month",
    p.mode === "TERM_END" && iso(p.at) === "2026-11-24", JSON.stringify(p));
}

// Month-to-month: the period IS the boundary, and the old behaviour was right.
{
  const p = planNonRenewal({
    minimumTermEndsAt: null, commitmentEndDate: null,
    currentPeriodEnd: d("2026-09-24"), paidThroughDate: null,
  }, NOW);
  check("with no commitment it still stops at the end of the paid period",
    p.mode === "PERIOD_END" && iso(p.at) === "2026-09-24", JSON.stringify(p));
}

// A term already served is history, not a boundary — otherwise turning
// auto-renew off would schedule a stop in the past.
{
  const p = planNonRenewal({
    minimumTermEndsAt: d("2026-06-01"), commitmentEndDate: null,
    currentPeriodEnd: d("2026-09-24"), paidThroughDate: null,
  }, NOW);
  check("a COMPLETED term falls back to the period end, never a date in the past",
    p.mode === "PERIOD_END" && iso(p.at) === "2026-09-24", JSON.stringify(p));
}

// Rows written before §8.8.1 have no minimumTermEndsAt but the member row may
// still record the commitment — exactly Max Hall's shape.
{
  const p = planNonRenewal({
    minimumTermEndsAt: null, commitmentEndDate: d("2027-01-15"),
    currentPeriodEnd: d("2026-09-24"), paidThroughDate: null,
  }, NOW);
  check("a legacy row falls back to Member.commitmentEndDate",
    p.mode === "TERM_END" && iso(p.at) === "2027-01-15", JSON.stringify(p));
}
{
  const p = planNonRenewal({
    minimumTermEndsAt: d("2026-11-24"), commitmentEndDate: d("2027-01-15"),
    currentPeriodEnd: d("2026-09-24"), paidThroughDate: null,
  }, NOW);
  check("the subscription's own term beats the member-level one",
    p.mode === "TERM_END" && iso(p.at) === "2026-11-24", JSON.stringify(p));
}

// Upfront options: period and term coincide, so both readings agree. Worth
// pinning — this is the shape that accidentally worked before the fix.
{
  const p = planNonRenewal({
    minimumTermEndsAt: d("2026-11-24"), commitmentEndDate: null,
    currentPeriodEnd: d("2026-11-24"), paidThroughDate: null,
  }, NOW);
  check("when period and term coincide, the answer is that date either way",
    iso(p.at) === "2026-11-24", JSON.stringify(p));
}

// paidThroughDate is the fallback when nothing has reconciled a period end.
{
  const p = planNonRenewal({
    minimumTermEndsAt: null, commitmentEndDate: null,
    currentPeriodEnd: null, paidThroughDate: d("2026-10-01"),
  }, NOW);
  check("with no period end it uses how far the money reaches",
    p.mode === "PERIOD_END" && iso(p.at) === "2026-10-01", JSON.stringify(p));
}

// Nothing known at all: null, not a guess. The caller refuses rather than
// stopping somebody on an invented date.
{
  const p = planNonRenewal({
    minimumTermEndsAt: null, commitmentEndDate: null,
    currentPeriodEnd: null, paidThroughDate: null,
  }, NOW);
  check("knowing nothing yields null, never today's date",
    p.mode === "PERIOD_END" && p.at === null, JSON.stringify(p));
}

// A term ending today is not still running — the boundary is strict.
{
  const p = planNonRenewal({
    minimumTermEndsAt: NOW, commitmentEndDate: null,
    currentPeriodEnd: d("2026-09-24"), paidThroughDate: null,
  }, NOW);
  check("a term ending exactly now counts as served",
    p.mode === "PERIOD_END", JSON.stringify(p));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nFailures:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
