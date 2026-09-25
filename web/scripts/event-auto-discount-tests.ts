/**
 * B3 slice 1 — lib/eventAutoDiscounts (pure). `npm run test:event-auto-discounts`.
 * Worked example: an $85 duals entry; siblings $10 off; Lincoln High 3+ get 15%.
 */
import {
  parseAutoDiscounts, validateAutoDiscounts, normalizeGroupValue, amountOff, siblingRuleFor, siblingLabel,
  autoCandidates, bestDiscount, whyLine, groupCatchUp, autoDiscountSummary, autoDiscountView, describeAmount,
  type AppliedDiscount,
} from "../lib/eventAutoDiscounts";
import { registrationDiscountFields, toApplied, discountLineLabel, registrationDiscountName } from "../lib/eventDiscounts";
import { registrationDiscount, applyRegistrationDiscount, expectedAmount } from "../lib/eventRepricing";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}

const cfg = parseAutoDiscounts({
  sibling: { on: true, shape: "EACH_ADDITIONAL", each: { type: "FIXED", value: 10 } },
  group: { on: true, label: "School", threshold: 3, amount: { type: "PERCENT", value: 15 }, options: [] },
});
const ladder = parseAutoDiscounts({
  sibling: { on: true, shape: "LADDER", tiers: [{ type: "PERCENT", value: 10 }, { type: "PERCENT", value: 15 }] },
});

console.log("config:");
{
  check("empty blob = nothing on", autoDiscountSummary(parseAutoDiscounts({})).length === 0);
  check("junk blob never throws", autoDiscountSummary(parseAutoDiscounts("nope")).length === 0 && autoDiscountSummary(parseAutoDiscounts(null)).length === 0);
  check("off rule is stored but not active", siblingRuleFor(parseAutoDiscounts({ sibling: { on: false, shape: "EACH_ADDITIONAL", each: { type: "FIXED", value: 10 } } }), 2) === null);
  const bad = validateAutoDiscounts({ sibling: { on: true, shape: "EACH_ADDITIONAL", each: { type: "FIXED", value: 0 } } });
  check("sibling on with no amount refused", !bad.ok);
  check("percent over 100 refused", !validateAutoDiscounts({ group: { on: true, label: "School", threshold: 3, amount: { type: "PERCENT", value: 120 } } }).ok);
  check("group of 1 refused", !validateAutoDiscounts({ group: { on: true, label: "School", threshold: 1, amount: { type: "FIXED", value: 5 } } }).ok);
  check("group needs a name", !validateAutoDiscounts({ group: { on: true, label: " ", threshold: 3, amount: { type: "FIXED", value: 5 } } }).ok);
  const ok = validateAutoDiscounts({ group: { on: true, label: " School ", threshold: 3, amount: { type: "FIXED", value: 5 }, options: ["Lincoln High", "lincoln  high", " ", "West"] } });
  check("pick-list trimmed, blank + duplicate spellings dropped", ok.ok && ok.value.group!.options.length === 2 && ok.value.group!.label === "School", ok);
  check("ladder step missing an amount is named", (() => { const r = validateAutoDiscounts({ sibling: { on: true, shape: "LADDER", tiers: [{ type: "FIXED", value: 5 }, { type: "FIXED", value: 0 }] } }); return !r.ok && r.message.includes("3rd"); })());
}

console.log("siblings:");
{
  check("1st athlete pays the price", siblingRuleFor(cfg, 1) === null);
  check("2nd gets $10", siblingRuleFor(cfg, 2)?.value === 10);
  check("5th still gets $10", siblingRuleFor(cfg, 5)?.value === 10);
  check("ladder: 2nd 10%", siblingRuleFor(ladder, 2)?.value === 10);
  check("ladder: 3rd 15%", siblingRuleFor(ladder, 3)?.value === 15);
  check("ladder: last step carries on (4th 15%)", siblingRuleFor(ladder, 4)?.value === 15);
  check("label", siblingLabel(2) === "Sibling discount (2nd athlete)" && siblingLabel(3) === "Sibling discount (3rd athlete)");
}

console.log("group rate:");
{
  check("spacing + case don't split a group", normalizeGroupValue(" Lincoln   HIGH ") === normalizeGroupValue("lincoln high"));
  check("below the number ⇒ nothing", autoCandidates({ cfg, siblingPosition: 1, groupDisplay: "Lincoln High", groupCount: 2 }).length === 0);
  const at = autoCandidates({ cfg, siblingPosition: 1, groupDisplay: "Lincoln High", groupCount: 3 });
  check("3rd from the school ⇒ the rate, named for the school", at.length === 1 && at[0].source === "GROUP" && at[0].label === "Lincoln High group rate", at);
  check("blank group ⇒ never a group", autoCandidates({ cfg, siblingPosition: 1, groupDisplay: "  ", groupCount: 9 }).length === 0);
}

console.log("one discount, the bigger saving:");
{
  const both = autoCandidates({ cfg, siblingPosition: 2, groupDisplay: "Lincoln High", groupCount: 4 });
  const pick = bestDiscount(85, both);
  check("sibling $10 vs 15% of $85 ($12.75) ⇒ group wins", pick.winner?.source === "GROUP" && amountOff(85, pick.winner) === 12.75, pick);
  const code: AppliedDiscount = { source: "CODE", id: "d1", code: "SUMMER5", type: "FIXED", value: 5, label: "SUMMER5" };
  const p2 = bestDiscount(85, [code, ...autoCandidates({ cfg, siblingPosition: 2, groupDisplay: null, groupCount: 1 })]);
  check("code $5 vs sibling $10 ⇒ sibling, and says why", p2.winner?.source === "SIBLING" && whyLine(p2.winner, p2.considered)?.includes("SUMMER5") === true);
  const big: AppliedDiscount = { ...code, code: "HALF", value: 50, type: "PERCENT", label: "HALF" };
  check("a bigger code beats the rule", bestDiscount(85, [big, ...both]).winner?.code === "HALF");
  const tie: AppliedDiscount = { ...code, code: "TEN", value: 10 };
  check("a tie goes to the rule", bestDiscount(85, [tie, ...autoCandidates({ cfg, siblingPosition: 2, groupDisplay: null, groupCount: 1 })]).winner?.source === "SIBLING");
  check("nothing applies ⇒ no discount", bestDiscount(85, []).winner === null);
  check("never below $0", amountOff(8, { type: "FIXED", value: 10 }) === 8);
}

console.log("the group catches up:");
{
  const rows = [
    { id: "a", name: "Ava", gross: 85, currentOff: 0, locked: false, source: null },
    { id: "b", name: "Ben", gross: 85, currentOff: 0, locked: true, source: null },
    { id: "c", name: "Cal", gross: 85, currentOff: 0, locked: false, source: null },
  ];
  const up = groupCatchUp({ cfg, rows, displayValue: "Lincoln High" });
  check("unpaid rows lowered", up.update.map((u) => u.id).join() === "a,c");
  check("paid row flagged, not refunded", up.owedBack.length === 1 && up.owedBack[0].id === "b" && up.owedBack[0].off === 12.75, up.owedBack);
  const two = groupCatchUp({ cfg, rows: rows.slice(0, 2), displayValue: "Lincoln High" });
  check("below the number ⇒ nobody touched", two.update.length === 0 && two.owedBack.length === 0);
  const better = groupCatchUp({ cfg, rows: [...rows.slice(0, 2), { id: "c", name: "Cal", gross: 85, currentOff: 20, locked: false, source: "CODE" }], displayValue: "Lincoln High" });
  check("a row already saving more keeps its discount", !better.update.some((u) => u.id === "c"));
  const coach = groupCatchUp({ cfg, rows: [...rows.slice(0, 2), { id: "c", name: "Cal", gross: 85, currentOff: 5, locked: false, source: "COACH" }], displayValue: "Lincoln High" });
  check("the coach's own discount is never replaced", !coach.update.some((u) => u.id === "c"));
}

console.log("stored on the registration:");
{
  const sib = autoCandidates({ cfg, siblingPosition: 2, groupDisplay: null, groupCount: 1 })[0];
  const f = registrationDiscountFields(sib, 85);
  check("sibling: $75 due, no code, named", f.amountDue === 75 && f.discountCode === null && f.discountId === null && f.discountLabel === "Sibling discount (2nd athlete)" && f.discountSource === "SIBLING", f);
  const c = registrationDiscountFields({ id: "d1", code: "SUMMER5", type: "FIXED", value: 5 }, 85);
  check("typed code: unchanged shape + source CODE", c.discountCode === "SUMMER5" && c.discountId === "d1" && c.discountSource === "CODE" && c.amountDue === 80);
  const none = registrationDiscountFields(null, 85);
  check("clear: every column null", none.discountSource === null && none.discountLabel === null && none.discountCode === null);
  check("roster name: label first, else code", registrationDiscountName({ discountCode: null, discountLabel: "Lincoln High group rate" }) === "Lincoln High group rate" && registrationDiscountName({ discountCode: "X", discountLabel: null }) === "X");
  check("line label for a rule is its name", discountLineLabel(sib) === "Sibling discount (2nd athlete)");
  check("toApplied(code) keeps the code", toApplied({ id: "d1", code: "SUMMER5", type: "FIXED", value: 5 }).code === "SUMMER5");
  // Repricing must honour a code-less discount, or a price change would erase it.
  const stored = { id: "r1", status: "PENDING_REVIEW", amountDue: 75, discountCode: null, discountLabel: "Sibling discount (2nd athlete)", discountType: "FIXED", discountValue: 10 };
  const rule = registrationDiscount(stored);
  check("repricing reads a sibling discount", rule?.value === 10 && applyRegistrationDiscount(90, rule).net === 80);
  const ev = { pricingModel: "FIXED", memberPrice: 85, nonMemberPrice: 85, dropInFee: null, variableCostEnabled: false } as unknown as Parameters<typeof expectedAmount>[0];
  check("expected amount keeps the $10 off", expectedAmount(ev, 1, stored) === 75, expectedAmount(ev, 1, stored));
}

console.log("what families see:");
{
  const v = autoDiscountView(cfg);
  check("two lines + the group question", v.lines.length === 2 && v.group?.label === "School", v);
  check("sibling line", v.lines[0] === "Siblings: each athlete after the first gets $10 off.", v.lines[0]);
  check("ladder line", autoDiscountSummary(ladder)[0] === "Siblings: 2nd athlete 10% off, 3rd+ athlete 15% off.", autoDiscountSummary(ladder));
  check("describe", describeAmount({ type: "FIXED", value: 12.5 }) === "$12.50 off" && describeAmount({ type: "PERCENT", value: 15 }) === "15% off");
  check("no rules ⇒ no question", autoDiscountView({}).group === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
