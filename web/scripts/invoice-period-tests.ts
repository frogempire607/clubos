/**
 * Where the next billing date comes from. npx tsx scripts/invoice-period-tests.ts
 *
 * Fixtures are REAL production payload values, taken from stripe_webhook_events
 * on 2026-08-25 — because the whole point of this function is that the obvious
 * field is the wrong one, and only a real payload proves it.
 */
import { invoicePeriodEnd } from "../lib/stripeTruth";

let pass = 0; const failures: string[] = [];
function check(l: string, ok: boolean, d?: string) {
  if (ok) { pass++; console.log(`  ✓ ${l}`); return; }
  failures.push(d ? `${l} — ${d}` : l); console.log(`  ✗ ${l}${d ? ` — ${d}` : ""}`);
}
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

// in_1U7lKZEIplcCMoSo3lOdODT2 — $180.08 charged 2026-08-24.
// The invoice's own period_end is the DAY OF THE INVOICE; the line carries the
// service period that was actually bought. Getting this backwards would show
// "next billing: today" forever.
{
  const real = {
    period_end: 1787529600,                                   // 2026-08-24
    lines: { data: [{ period: { start: 1787529600, end: 1790208000 } }] }, // → 2026-09-24
  };
  check("reads the LINE period, not the invoice's own",
    day(invoicePeriodEnd(real)) === "2026-09-24", String(day(invoicePeriodEnd(real))));
  check("and specifically NOT the top-level field, which is the invoice date",
    day(invoicePeriodEnd(real)) !== "2026-08-24");
}

// Levi's real renewal: charged 2026-08-19, next period ends 2026-09-18, which
// matches the endDate already on his row.
{
  const levi = { period_end: 1787097600, lines: { data: [{ period: { end: 1789689600 } }] } };
  check("Levi's 2026-08-19 charge advances him to 2026-09-18",
    day(invoicePeriodEnd(levi)) === "2026-09-18", String(day(invoicePeriodEnd(levi))));
}

// Legacy shape with no line period at all — fall back rather than return null,
// because a slightly-wrong date still beats the stale anchor it replaces.
{
  const legacy = { period_end: 1790208000, lines: { data: [{}] } };
  check("falls back to the top-level period when no line carries one",
    day(invoicePeriodEnd(legacy)) === "2026-09-24", String(day(invoicePeriodEnd(legacy))));
}

// Multi-line invoices (a proration beside the subscription line): take the
// first line that HAS a period, not blindly the first line.
{
  const multi = { lines: { data: [{ period: null }, { period: { end: 1790208000 } }] } };
  check("skips lines with no period and uses the one that has it",
    day(invoicePeriodEnd(multi)) === "2026-09-24", String(day(invoicePeriodEnd(multi))));
}

// Anything unreadable must yield null — the caller then leaves the column
// alone rather than writing a guess over a real date.
check("null invoice yields null", invoicePeriodEnd(null) === null);
check("empty object yields null", invoicePeriodEnd({}) === null);
check("no lines and no period yields null", invoicePeriodEnd({ lines: { data: [] } }) === null);
check("a zero timestamp is not a date", invoicePeriodEnd({ period_end: 0 }) === null);
check("a non-numeric timestamp yields null",
  invoicePeriodEnd({ period_end: "soon" as unknown as number }) === null);

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.error("\nFailures:"); for (const f of failures) console.error(`  - ${f}`); process.exit(1); }
