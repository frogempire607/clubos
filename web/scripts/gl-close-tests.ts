// Accounting Phase 3 — fixed assets, depreciation and the month close, proven.
//
//   npm run test:gl-close     (and it GATES the build)
//
// No database, no network. The invariants here are the ones that would be
// expensive to discover in production:
//
//   · a depreciation schedule's months add up to EXACTLY cost less salvage —
//     checked over 600+ parameter combinations, not a hand-picked few, because
//     a rounding rule that is right for $1,000 over 36 months and wrong for
//     $999.99 over 7 is the kind of thing only exhaustion finds;
//   · a re-run posts nothing new, which is structural: the sourceId is the
//     idempotency key;
//   · a disposal entry balances, at every combination of proceeds and
//     accumulated depreciation;
//   · reopening a month restores the PREVIOUS lock date, not an unlocked year.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  addMonths,
  depreciableBaseCents,
  depreciationDue,
  depreciationLines,
  depreciationSchedule,
  depreciationSourceId,
  disposalPlan,
  disposalSourceId,
  firstDepreciationMonth,
  lastDepreciationMonth,
  monthEnd,
  parseDepreciationSourceId,
  validateAsset,
  validateDisposal,
  type FixedAsset,
} from "../lib/glAssets";
import {
  CHECK_KEYS,
  closeWouldUnlock,
  evaluateChecklist,
  isValidMonthKey,
  lockDateForClose,
  monthIsLocked,
  monthLabel,
  periodEnd,
  periodStart,
  validateReopen,
  type CloseFacts,
} from "../lib/glClose";
import { entryTotals, formatCents } from "../lib/ledger";

const ROOT = join(__dirname, "..");
let pass = 0;
const fails: string[] = [];
const ok = (cond: boolean, name: string, detail?: string) => {
  if (cond) pass++;
  else fails.push(detail ? `${name} — ${detail}` : name);
};
const eq = <T,>(actual: T, expected: T, name: string) =>
  ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    name,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );

const asset = (over?: Partial<FixedAsset>): FixedAsset => ({
  id: "asset1",
  name: "Competition mats",
  costCents: 1_200_000,
  inServiceDate: "2027-01-15",
  usefulLifeMonths: 60,
  salvageValueCents: 0,
  legalEntityId: "frog",
  assetAccountId: "equip",
  accumDepAccountId: "accumdep",
  depExpenseAccountId: "depexp",
  status: "ACTIVE",
  disposedDate: null,
  ...over,
});

// ── 1. Validation ───────────────────────────────────────────────────────────
{
  const base = {
    name: "Mats",
    costCents: 100_000,
    inServiceDate: "2027-01-01",
    usefulLifeMonths: 36,
    salvageValueCents: 0,
  };
  eq(validateAsset(base), [], "1.1 a sane asset validates");
  ok(validateAsset({ ...base, name: "  " }).length > 0, "1.2 a blank name is refused");
  ok(validateAsset({ ...base, costCents: 0 }).length > 0, "1.3 a zero cost is refused");
  ok(validateAsset({ ...base, costCents: -1 }).length > 0, "1.4 a negative cost is refused");
  ok(validateAsset({ ...base, usefulLifeMonths: 0 }).length > 0, "1.5 a zero life is refused");
  ok(validateAsset({ ...base, usefulLifeMonths: 1201 }).length > 0, "1.6 a 100-year life is called a typo");
  ok(validateAsset({ ...base, salvageValueCents: -1 }).length > 0, "1.7 negative salvage is refused");
  ok(
    validateAsset({ ...base, salvageValueCents: 100_001 }).length > 0,
    "1.8 salvage above cost is refused — it would depreciate upwards",
  );
  eq(validateAsset({ ...base, salvageValueCents: 100_000 }), [], "1.9 salvage EQUAL to cost is allowed (it just never depreciates)");
  ok(validateAsset({ ...base, inServiceDate: "15/01/2027" }).length > 0, "1.10 a non-ISO date is refused");
  eq(validateAsset({ ...base, usefulLifeMonths: 1 }), [], "1.11 a one-month life is allowed");
}

// ── 2. Months ───────────────────────────────────────────────────────────────
{
  eq(firstDepreciationMonth(asset()), "2027-01", "2.1 depreciation starts in the month placed in service");
  eq(lastDepreciationMonth(asset()), "2031-12", "2.2 and ends usefulLife−1 months later");
  eq(lastDepreciationMonth(asset({ usefulLifeMonths: 1 })), "2027-01", "2.3 a one-month asset starts and ends in the same month");
  eq(addMonths("2027-01", 0), "2027-01", "2.4 adding nothing changes nothing");
  eq(addMonths("2027-11", 1), "2027-12", "2.5 November plus one is December");
  eq(addMonths("2027-12", 1), "2028-01", "2.6 December plus one crosses the year");
  eq(addMonths("2027-01", -1), "2026-12", "2.7 and it goes backwards too");
  eq(addMonths("2027-03", 24), "2029-03", "2.8 two years on is the same month");
  eq(monthEnd("2027-02"), "2027-02-28", "2.9 a common February ends on the 28th");
  eq(monthEnd("2028-02"), "2028-02-29", "2.10 a leap February on the 29th");
  eq(monthEnd("2027-12"), "2027-12-31", "2.11 December on the 31st");
}

// ── 3. The schedule totals EXACTLY, over hundreds of combinations ───────────
{
  const costs = [
    1, 2, 99, 100, 101, 333, 999, 1_000, 1_001, 12_345, 99_999, 100_000,
    1_200_000, 1_999_999, 123_456_789, 2_000_000_000,
  ];
  const lives = [1, 2, 3, 4, 7, 11, 12, 13, 36, 60, 84, 120, 360];
  const salvages = [0, 1, 99, 1_000, 50_000];
  let combos = 0;
  const bad: string[] = [];
  for (const costCents of costs) {
    for (const usefulLifeMonths of lives) {
      for (const salvageValueCents of salvages) {
        if (salvageValueCents > costCents) continue;
        combos += 1;
        const a = asset({ costCents, usefulLifeMonths, salvageValueCents });
        const rows = depreciationSchedule(a);
        const total = rows.reduce((s, r) => s + r.amountCents, 0);
        const base = depreciableBaseCents(a);
        if (base > 0 && rows.length !== usefulLifeMonths) {
          bad.push(`${costCents}/${usefulLifeMonths}/${salvageValueCents}: ${rows.length} rows`);
          continue;
        }
        if (total !== base) {
          bad.push(`${costCents}/${usefulLifeMonths}/${salvageValueCents}: total ${total} ≠ base ${base}`);
          continue;
        }
        if (rows.some((r) => r.amountCents < 0)) {
          bad.push(`${costCents}/${usefulLifeMonths}/${salvageValueCents}: a negative month`);
          continue;
        }
        const last = rows[rows.length - 1];
        if (last && last.accumulatedCents !== base) {
          bad.push(`${costCents}/${usefulLifeMonths}/${salvageValueCents}: accumulated ${last.accumulatedCents} ≠ ${base}`);
        }
      }
    }
  }
  ok(combos > 600, "3.1 the sweep covers 600+ parameter combinations", `only ${combos}`);
  eq(bad.slice(0, 5), [], "3.2 every schedule totals exactly cost less salvage, with no negative month");

  // The worked example from the module comment.
  const three = depreciationSchedule(asset({ costCents: 100_000, usefulLifeMonths: 3, salvageValueCents: 0 }));
  eq(three.map((r) => r.amountCents), [33_333, 33_333, 33_334], "3.3 $1,000 over 3 months is 333.33, 333.33, 333.34");
  eq(three[2].accumulatedCents, 100_000, "3.4 and accumulates to the whole cost");

  // A cost that does not divide: the remainder lands in the LAST month, which
  // is what stops a stub balance sitting on the books forever.
  const seven = depreciationSchedule(asset({ costCents: 1_000, usefulLifeMonths: 7 }));
  eq(seven.map((r) => r.amountCents), [142, 142, 142, 142, 142, 142, 148], "3.5 the remainder goes to the final month");

  // Salvage is never depreciated away.
  const withSalvage = depreciationSchedule(asset({ costCents: 100_000, usefulLifeMonths: 4, salvageValueCents: 20_000 }));
  eq(withSalvage.reduce((s, r) => s + r.amountCents, 0), 80_000, "3.6 only the depreciable base is taken");

  // An asset whose salvage equals its cost never depreciates at all.
  eq(depreciationSchedule(asset({ costCents: 50_000, salvageValueCents: 50_000 })), [], "3.7 a fully-salvaged asset has no schedule");
  eq(depreciationSchedule(asset({ usefulLifeMonths: 0 })), [], "3.8 nor does one with no life");

  // Months advance correctly across a year boundary.
  const crossing = depreciationSchedule(asset({ inServiceDate: "2027-11-20", usefulLifeMonths: 4 }));
  eq(crossing.map((r) => r.monthKey), ["2027-11", "2027-12", "2028-01", "2028-02"], "3.9 the schedule crosses the year correctly");
}

// ── 4. Idempotency is the sourceId ──────────────────────────────────────────
{
  eq(depreciationSourceId("a1", "2027-03"), "a1:2027-03", "4.1 the key is <assetId>:<YYYY-MM>");
  eq(parseDepreciationSourceId("a1:2027-03"), { assetId: "a1", monthKey: "2027-03" }, "4.2 and parses back");
  // cuid ids contain no colon today, but parsing from the LAST colon means an
  // id that ever did would still round-trip.
  eq(
    parseDepreciationSourceId("weird:id:2027-03"),
    { assetId: "weird:id", monthKey: "2027-03" },
    "4.3 parsing splits at the LAST colon, so an id containing one survives",
  );
  eq(parseDepreciationSourceId("a1:disposal"), null, "4.4 a disposal key is not a depreciation key");
  eq(parseDepreciationSourceId("nocolon"), null, "4.5 and nonsense parses to null");
  eq(disposalSourceId("a1"), "a1:disposal", "4.6 a disposal has its own key, so an asset disposes once");

  const a = asset({ costCents: 100_000, usefulLifeMonths: 4, inServiceDate: "2027-01-10" });

  const firstRun = depreciationDue(a, "2027-03", new Set());
  eq(firstRun.map((d) => d.monthKey), ["2027-01", "2027-02", "2027-03"], "4.7 the first run posts every month due");
  eq(firstRun.map((d) => d.entryDate), ["2027-01-31", "2027-02-28", "2027-03-31"], "4.8 each dated at ITS month end, not today");
  eq(firstRun.reduce((s, d) => s + d.amountCents, 0), 75_000, "4.9 three months of a $1,000/4 asset is $750");

  // THE ACCEPTANCE CRITERION: a re-run posts nothing new.
  const posted = new Set(firstRun.map((d) => d.monthKey));
  eq(depreciationDue(a, "2027-03", posted), [], "4.10 a re-run posts NOTHING");
  eq(
    depreciationDue(a, "2027-04", posted).map((d) => d.monthKey),
    ["2027-04"],
    "4.11 but the next month still posts",
  );
  eq(depreciationDue(a, "2027-12", posted).map((d) => d.monthKey), ["2027-04"], "4.12 and nothing beyond the asset's life");

  // A gap is filled, not skipped — a club that forgot February gets it later.
  eq(
    depreciationDue(a, "2027-04", new Set(["2027-01", "2027-03"])).map((d) => d.monthKey),
    ["2027-02", "2027-04"],
    "4.13 a missed month is caught up, in order",
  );

  // A disposed asset stops.
  const disposed = asset({
    ...a,
    status: "DISPOSED",
    disposedDate: "2027-02-20",
  });
  eq(
    depreciationDue(disposed, "2027-06", new Set()).map((d) => d.monthKey),
    ["2027-01", "2027-02"],
    "4.14 a disposed asset takes nothing after its disposal month",
  );

  // Lines balance.
  const lines = depreciationLines(a, 25_000);
  const t = entryTotals(lines);
  ok(t.balanced, "4.15 a depreciation entry balances");
  eq(t.debitCents, 25_000, "4.16 debiting the expense");
  eq(lines[0].accountId, "depexp", "4.17 the debit is the expense account");
  eq(lines[1].accountId, "accumdep", "4.18 and the credit is accumulated depreciation");
  eq(lines.length, 2, "4.19 two lines, no more");
}

// ── 5. Disposal ─────────────────────────────────────────────────────────────
{
  const a = asset({ costCents: 100_000, usefulLifeMonths: 10, salvageValueCents: 0 });
  const input = {
    disposedDate: "2027-06-30",
    proceedsCents: 40_000,
    proceedsAccountId: "bank",
    gainAccountId: "other-income",
    lossAccountId: "misc",
    note: null,
  };

  // Sold for more than book value → a gain.
  const gain = disposalPlan(a, input, 70_000);
  eq(gain.bookValueCents, 30_000, "5.1 book value is cost less accumulated depreciation");
  eq(gain.gainLossCents, 10_000, "5.2 proceeds above book value is a gain");
  ok(entryTotals(gain.lines).balanced, "5.3 and the entry balances");
  ok(
    gain.lines.some((l) => l.accountId === "other-income" && l.creditCents === 10_000),
    "5.4 the gain is credited to income",
  );
  ok(
    gain.lines.some((l) => l.accountId === "accumdep" && l.debitCents === 70_000),
    "5.5 accumulated depreciation comes off with a debit",
  );
  ok(
    gain.lines.some((l) => l.accountId === "equip" && l.creditCents === 100_000),
    "5.6 and the asset comes off at COST, not at book value",
  );

  // Sold for less → a loss.
  const loss = disposalPlan(a, { ...input, proceedsCents: 10_000 }, 70_000);
  eq(loss.gainLossCents, -20_000, "5.7 proceeds below book value is a loss");
  ok(entryTotals(loss.lines).balanced, "5.8 that entry balances too");
  ok(loss.lines.some((l) => l.accountId === "misc" && l.debitCents === 20_000), "5.9 the loss is debited to an expense");

  // Scrapped for nothing: the whole remaining book value is the loss.
  const scrapped = disposalPlan(a, { ...input, proceedsCents: 0, proceedsAccountId: null }, 70_000);
  eq(scrapped.gainLossCents, -30_000, "5.10 scrapping loses the remaining book value");
  ok(entryTotals(scrapped.lines).balanced, "5.11 and still balances");
  ok(!scrapped.lines.some((l) => l.accountId === "bank"), "5.12 with no proceeds line at all");

  // Sold at exactly book value: no gain, no loss, no third line.
  const even = disposalPlan(a, { ...input, proceedsCents: 30_000 }, 70_000);
  eq(even.gainLossCents, 0, "5.13 selling at book value is neither");
  ok(entryTotals(even.lines).balanced, "5.14 and balances with no gain/loss line");
  ok(
    !even.lines.some((l) => l.accountId === "other-income" || l.accountId === "misc"),
    "5.15 which means no zero-value line is written",
  );

  // Fully depreciated, then sold.
  const full = disposalPlan(a, { ...input, proceedsCents: 5_000 }, 100_000);
  eq(full.bookValueCents, 0, "5.16 a fully depreciated asset has no book value");
  eq(full.gainLossCents, 5_000, "5.17 so anything received is pure gain");
  ok(entryTotals(full.lines).balanced, "5.18 and balances");

  // Never depreciated at all.
  const fresh = disposalPlan(a, { ...input, proceedsCents: 90_000 }, 0);
  eq(fresh.gainLossCents, -10_000, "5.19 an undepreciated asset sold under cost is a loss");
  ok(entryTotals(fresh.lines).balanced, "5.20 and balances");
  ok(!fresh.lines.some((l) => l.accountId === "accumdep"), "5.21 with no accumulated-depreciation line to remove");

  // It balances at EVERY combination, not the ones a test picked.
  const unbalanced: string[] = [];
  for (const accumulated of [0, 1, 33_333, 70_000, 99_999, 100_000]) {
    for (const proceeds of [0, 1, 5_000, 30_000, 100_000, 250_000]) {
      const p = disposalPlan(a, { ...input, proceedsCents: proceeds, proceedsAccountId: proceeds ? "bank" : null }, accumulated);
      if (!entryTotals(p.lines).balanced) unbalanced.push(`accum ${accumulated} / proceeds ${proceeds}`);
    }
  }
  eq(unbalanced, [], "5.22 a disposal balances at every combination of proceeds and accumulated depreciation");

  // Validation.
  eq(validateDisposal(a, input, 70_000), [], "5.23 a sane disposal validates");
  ok(
    validateDisposal(a, { ...input, disposedDate: "2026-12-31" }, 0).some((e) => /before it was placed/.test(e)),
    "5.24 disposing before the in-service date is refused",
  );
  ok(
    validateDisposal(asset({ status: "DISPOSED" }), input, 0).some((e) => /already/.test(e)),
    "5.25 disposing twice is refused",
  );
  ok(
    validateDisposal(a, { ...input, proceedsCents: -1 }, 0).some((e) => /negative/.test(e)),
    "5.26 negative proceeds are refused",
  );
  ok(
    validateDisposal(a, { ...input, proceedsCents: 100, proceedsAccountId: null }, 0).some((e) => /which account/.test(e)),
    "5.27 proceeds with nowhere to put them are refused",
  );
  ok(
    validateDisposal(a, input, 150_000).some((e) => /than it can take/.test(e)),
    "5.28 over-depreciation is caught before a nonsense disposal is written",
  );
}

// ── 6. The close checklist ──────────────────────────────────────────────────
{
  const clean: CloseFacts = {
    unreconciledAccounts: [],
    reconcilableCount: 2,
    waitingToPost: 0,
    uncategorizedBankRows: 0,
    undepositedCents: 0,
    undepositedAcknowledged: false,
    depreciationDue: 0,
  };
  const c = evaluateChecklist(clean);
  ok(c.ready, "6.1 a clean month is ready to close", c.blockers.join("; "));
  eq(c.items.length, 5, "6.2 with all five checks");
  eq(c.items.map((i) => i.key), [...CHECK_KEYS], "6.3 in a stable order");
  ok(c.items.every((i) => i.ok), "6.4 all green");
  eq(c.blockers, [], "6.5 and nothing blocking");

  const unrec = evaluateChecklist({ ...clean, unreconciledAccounts: ["1000 Operating Checking"] });
  ok(!unrec.ready, "6.6 an unreconciled account blocks the close");
  ok(/Operating Checking/.test(unrec.items[0].detail), "6.7 and the detail NAMES it, so the reader knows where to go");

  const waiting = evaluateChecklist({ ...clean, waitingToPost: 3 });
  ok(!waiting.ready, "6.8 records waiting to post block the close");
  ok(/3 records/.test(waiting.items[1].detail), "6.9 and are counted");

  const uncat = evaluateChecklist({ ...clean, uncategorizedBankRows: 1 });
  ok(!uncat.ready, "6.10 an uncategorised bank row blocks the close");
  ok(/never posts/.test(uncat.items[2].detail), "6.11 and the detail says WHY it matters, not just that it's there");
  ok(/1 bank row\b/.test(uncat.items[2].detail), "6.12 with correct singular wording");

  // 1020: a balance is not itself wrong, so it needs a human.
  const undep = evaluateChecklist({ ...clean, undepositedCents: 15_000 });
  ok(!undep.ready, "6.13 money in undeposited funds blocks the close until reviewed");
  ok(/somebody has to say which/.test(undep.items[3].detail), "6.14 and says it is a judgement, not an error");
  const acked = evaluateChecklist({ ...clean, undepositedCents: 15_000, undepositedAcknowledged: true });
  ok(acked.ready, "6.15 ticking the review unblocks it");
  const zeroNoAck = evaluateChecklist({ ...clean, undepositedCents: 0, undepositedAcknowledged: false });
  ok(zeroNoAck.ready, "6.16 a zero balance needs no tick — there is nothing to review");

  const dep = evaluateChecklist({ ...clean, depreciationDue: 2 });
  ok(!dep.ready, "6.17 unposted depreciation blocks the close");
  ok(/overstated/.test(dep.items[4].detail), "6.18 and says what it would do to the numbers");

  const noAccounts = evaluateChecklist({ ...clean, reconcilableCount: 0 });
  ok(noAccounts.ready, "6.19 a club with no bank accounts can still close");
  ok(/nothing to reconcile/.test(noAccounts.items[0].detail), "6.20 and is told why that check passed");

  const several = evaluateChecklist({
    ...clean,
    unreconciledAccounts: ["1000 Checking"],
    waitingToPost: 1,
    depreciationDue: 1,
  });
  eq(several.blockers.length, 3, "6.21 every blocker is listed, not just the first");
  ok(several.items.every((i) => i.blocking), "6.22 all five checks block — a close is not a partial statement");
}

// ── 7. Periods and the lock date ────────────────────────────────────────────
{
  eq(periodStart("2027-02"), "2027-02-01", "7.1 a period starts on the 1st");
  eq(periodEnd("2027-02"), "2027-02-28", "7.2 and ends on the last day");
  eq(periodEnd("2028-02"), "2028-02-29", "7.3 leap years included");
  ok(/February/.test(monthLabel("2027-02")), "7.4 the label names the month");
  ok(/2027/.test(monthLabel("2027-02")), "7.5 and the year");
  ok(/January/.test(monthLabel("2027-01")), "7.6 including January, which a UTC-midnight parse moves to December");

  ok(isValidMonthKey("2027-01"), "7.7 a real month validates");
  ok(!isValidMonthKey("2027-13"), "7.8 month 13 does not");
  ok(!isValidMonthKey("2027-00"), "7.9 nor month 0");
  ok(!isValidMonthKey("2027-1"), "7.10 nor an unpadded month");
  ok(!isValidMonthKey("1999-01"), "7.11 nor a year before the ledger could exist");
  ok(!isValidMonthKey("2027-01-01"), "7.12 nor a full date");

  // Closing February when nothing is locked sets the lock to Feb 28.
  eq(lockDateForClose("2027-02", null), "2027-02-28", "7.13 closing a month locks through its end");
  // Closing February when March is already closed must NOT move the lock back.
  eq(
    lockDateForClose("2027-02", "2027-03-31"),
    "2027-03-31",
    "7.14 closing an EARLIER month never moves the lock backwards — that would silently reopen March",
  );
  ok(closeWouldUnlock("2027-02", "2027-03-31"), "7.15 and the caller can warn that the lock is unchanged");
  ok(!closeWouldUnlock("2027-04", "2027-03-31"), "7.16 closing forwards is the normal case");
  eq(lockDateForClose("2027-04", "2027-03-31"), "2027-04-30", "7.17 which does move the lock on");

  ok(monthIsLocked("2027-01", "2027-03-31"), "7.18 a month before the lock is locked");
  ok(monthIsLocked("2027-03", "2027-03-31"), "7.19 the lock month itself is locked");
  ok(!monthIsLocked("2027-04", "2027-03-31"), "7.20 the month after is not");
  ok(!monthIsLocked("2027-01", null), "7.21 and nothing is locked without a lock date");
}

// ── 8. Reopening ────────────────────────────────────────────────────────────
{
  ok(!validateReopen("").ok, "8.1 a reopen with no reason is refused");
  ok(!validateReopen("oops").ok, "8.2 and so is a one-word one");
  ok(!validateReopen("         ").ok, "8.3 whitespace is not a reason");
  ok(validateReopen("The CPA found a misposted rent payment in January.").ok, "8.4 a real sentence is accepted");
  ok(!validateReopen("x".repeat(501)).ok, "8.5 and an essay is capped");
  ok(
    /changed after they were closed/.test(validateReopen("short").reason ?? ""),
    "8.6 the refusal explains why a reason is required, rather than just demanding one",
  );
}

// ── 9. Source guarantees ────────────────────────────────────────────────────
{
  const assets = readFileSync(join(ROOT, "lib/glAssets.ts"), "utf8");
  const close = readFileSync(join(ROOT, "lib/glClose.ts"), "utf8");
  for (const [name, src] of [["glAssets", assets], ["glClose", close]] as const) {
    ok(!/from "@\/lib\/prisma"/.test(src), `9.1 lib/${name}.ts imports no prisma`);
    ok(!/next\/server/.test(src), `9.2 lib/${name}.ts imports no next/server`);
    ok(!/\bnew Date\(\)/.test(src), `9.3 lib/${name}.ts reads no clock`);
  }

  // The sourceId format IS the idempotency key. If this ever stops being
  // built from the asset id and the month, every month could post twice.
  ok(
    /return `\$\{assetId\}:\$\{monthKey\}`/.test(assets),
    "9.4 the depreciation sourceId is still <assetId>:<monthKey>",
  );

  const server = readFileSync(join(ROOT, "lib/glAssetsServer.ts"), "utf8");
  ok(/createEntry\(/.test(server), "9.5 the asset server posts through the Phase 1 ledger service");
  ok(!/prisma\.glJournalLine\.create/.test(server), "9.6 and never writes a journal line itself");
  ok(/sourceType: "DEPRECIATION"/.test(server), "9.7 depreciation posts under its own source type");
  ok(/P2002/.test(server), "9.8 and a lost idempotency race counts as success, not an error");
  ok(
    /depreciationSourceId|d\.sourceId/.test(server),
    "9.9 using the pure module's key rather than building one inline",
  );
  // An edit that would re-cut a schedule under already-posted months is how a
  // register starts disagreeing with the ledger.
  ok(
    /of depreciation has already been posted for this asset/.test(server),
    "9.10 editing a depreciating asset's cost or life is refused with a reason",
  );

  const closeServer = readFileSync(join(ROOT, "lib/glCloseServer.ts"), "utf8");
  ok(/setLockDate\(/.test(closeServer), "9.11 a close sets the lock date through the ledger service");
  ok(/dryRun: true/.test(closeServer), "9.12 and the checklist asks what would post WITHOUT posting it");
  ok(
    /lockDateBefore: currentLock/.test(closeServer),
    "9.13 the previous lock date is recorded before the close moves it, so a reopen can restore it",
  );
  ok(
    /row\.lockDateBefore \? ymd\(row\.lockDateBefore\) : null/.test(closeServer),
    "9.14 and a reopen restores exactly that, never an unlocked year",
  );
  ok(
    /checklist\.ready/.test(closeServer) && /loadMonthClose\(/.test(closeServer),
    "9.15 the checklist is re-evaluated server-side at close time, never trusted from the request",
  );
  // Every query in the close and asset servers must be club-scoped.
  for (const [name, src] of [["glCloseServer", closeServer], ["glAssetsServer", server]] as const) {
    const calls = src.match(/prisma\.\w+\.(findMany|findFirst|count|aggregate|updateMany|deleteMany)\(/g) ?? [];
    ok(calls.length > 0, `9.16 lib/${name}.ts does query the database`);
    // findUnique is the dangerous one: it CANNOT be club-scoped, because the
    // id is the whole key. Phase 1's guard made the same point.
    ok(
      !/prisma\.(glFixedAsset|glMonthClose|glJournalEntry|glJournalLine|glAccount)\.findUnique\(/.test(src),
      `9.17 lib/${name}.ts never findUniques a tenant row — findFirst with clubId instead`,
    );
  }
}

// ── Done ───────────────────────────────────────────────────────────────────
console.log(`\n${fails.length ? "✗" : "✓"} gl-close: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
void formatCents;
