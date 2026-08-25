/** npx tsx scripts/billing-anchor-tests.ts */
import { anchorGrant } from "../lib/billingAnchor";
let pass = 0; const failures: string[] = [];
function check(l: string, ok: boolean, d?: string) {
  if (ok) { pass++; console.log(`  ✓ ${l}`); return; }
  failures.push(d ? `${l} — ${d}` : l); console.log(`  ✗ ${l}${d ? ` — ${d}` : ""}`);
}
const NOW = new Date("2026-07-21T00:00:00.000Z");
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

// Levi's real case: anchor 2026-08-19 on a $175 monthly, 7-day club trial.
{
  const g = anchorGrant({ now: NOW, anchor: d("2026-08-19"), trialDays: 7, price: 175, billingPeriod: "MONTHLY" });
  check("Levi's anchor is 29 days out", g.totalFreeDays === 29, String(g.totalFreeDays));
  check("the trial is subtracted — the GRANT is 22 days, not 29", g.grantedDays === 22, String(g.grantedDays));
  check("priced at his own rate: $128.33", g.grantedValue === 128.33, String(g.grantedValue));
  check("and it says so plainly", /grants 22 extra free days — about \$128\.33/.test(g.sentence), g.sentence);
}
// An anchor inside the trial grants nothing extra.
{
  const g = anchorGrant({ now: NOW, anchor: d("2026-07-26"), trialDays: 7, price: 175, billingPeriod: "MONTHLY" });
  check("an anchor inside the trial window grants nothing", g.grantedDays === 0, String(g.grantedDays));
  check("and produces no dialog line", g.sentence === "", g.sentence);
}
// No anchor at all.
{
  const g = anchorGrant({ now: NOW, anchor: null, trialDays: 7, price: 175, billingPeriod: "MONTHLY" });
  check("no anchor grants nothing", g.totalFreeDays === 0 && g.grantedDays === 0);
}
// A past anchor must never produce a negative grant.
{
  const g = anchorGrant({ now: NOW, anchor: d("2026-07-01"), trialDays: 7, price: 175, billingPeriod: "MONTHLY" });
  check("a past anchor clamps to zero rather than going negative", g.totalFreeDays === 0 && g.grantedDays === 0);
}
// Period matters: the same 22 days is worth less on a quarterly plan.
{
  const g = anchorGrant({ now: NOW, anchor: d("2026-08-19"), trialDays: 7, price: 450, billingPeriod: "QUARTERLY" });
  check("a quarterly rate is prorated over 91 days, not 30",
    g.grantedValue === Math.round((450 / 91) * 22 * 100) / 100, String(g.grantedValue));
}
// A club with no trial: the whole gap is the grant.
{
  const g = anchorGrant({ now: NOW, anchor: d("2026-08-19"), trialDays: 0, price: 175, billingPeriod: "MONTHLY" });
  check("with no trial configured the whole gap is the grant", g.grantedDays === 29, String(g.grantedDays));
  check("and the sentence does not mention a trial", !/free trial/.test(g.sentence), g.sentence);
}
// A $0 membership has no value to give away.
{
  const g = anchorGrant({ now: NOW, anchor: d("2026-08-19"), trialDays: 7, price: 0, billingPeriod: "MONTHLY" });
  check("a $0 plan reports days but no dollar value", g.grantedDays === 22 && g.grantedValue === null);
}
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.error("\nFailures:"); for (const f of failures) console.error(`  - ${f}`); process.exit(1); }
