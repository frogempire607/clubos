// Payroll cost for a date range — the one number the reports use.
//
//   Before the club's pay-ledger start date (or a club with no ledger yet):
//     the period calculator (lib/payrollCalc.ts), exactly as before.
//   On/after the ledger start date: the pay lines themselves (unpaid, on a
//     payout, or paid — never void, never "needs review"), by work day.
//   A range that straddles the date is the sum of the two parts, so nothing
//     is counted twice and nothing before the date is ever recalculated from
//     the ledger.
import { computeLegacyPayrollTotal } from "@/lib/payrollCalc";
import { getLedgerStart, ledgerTotal, syncPayLinesThrottled } from "@/lib/payLedgerServer";

const DAY_MS = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export async function computePayrollTotalForRange(
  clubId: string,
  from: Date | null,
  to: Date,
  // Decides which class days have ended (only days on/after the club's
  // assignment start date ask). Callers leave it out; tests pin it.
  now: Date = new Date(),
): Promise<number> {
  const start = await getLedgerStart(clubId);
  if (!start) return computeLegacyPayrollTotal(clubId, from, to, now, null);

  const startAt = new Date(`${start}T00:00:00.000Z`);
  let total = 0;
  // The part before the ledger: the old calculation, up to the last instant of the day before.
  if (from === null || from.getTime() < startAt.getTime()) {
    const legacyTo = to.getTime() < startAt.getTime() ? to : new Date(startAt.getTime() - 1);
    total += await computeLegacyPayrollTotal(clubId, from, legacyTo, now, start);
  }
  // The part on/after it: pay lines.
  if (to.getTime() >= startAt.getTime()) {
    await syncPayLinesThrottled(clubId, now);
    const fromYmd = from !== null && from.getTime() > startAt.getTime() ? ymd(from) : start;
    // `to` is normally 23:59:59.999 of its day; a range that ends exactly at
    // midnight ends on the day before.
    const toDay = to.getUTCHours() === 0 && to.getUTCMinutes() === 0 && to.getUTCSeconds() === 0 && to.getUTCMilliseconds() === 0
      ? ymd(new Date(to.getTime() - DAY_MS))
      : ymd(to);
    total += await ledgerTotal(clubId, fromYmd, toDay);
  }
  return +total.toFixed(2);
}
