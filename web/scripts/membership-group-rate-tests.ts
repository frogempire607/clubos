/**
 * B3 slice 3 — lib/membershipGroupRates (pure). `npm run test:membership-group-rates`.
 * Worked example: a club with two rates of its own naming — "Team" (3+, 15% off)
 * and "Bus route" (2+, $10 off) — plus the sibling discount (10%).
 */
import {
  parseGroupRates, validateGroupRates, cleanGroupValues, groupCounts, bestGroupRate, combineAuto, groupRateLabel,
  type GroupRate, type GroupSub,
} from "../lib/membershipGroupRates";
import { parseMembershipSibling, planFamily, type SiblingSub } from "../lib/membershipSiblingDiscount";
import { receiptDiscountLine } from "../lib/email";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}
let n = 0;
const newId = () => `gr_test${++n}`;

console.log("rates are the club's:");
{
  const v = validateGroupRates([
    { on: true, label: " Team ", threshold: 3, amount: { type: "PERCENT", value: 15 }, options: ["Varsity", "JV", "varsity "] },
    { on: true, label: "Bus route", threshold: 2, amount: { type: "FIXED", value: 10 } },
  ], newId);
  check("two named rates saved, ids minted, list de-duplicated", v.ok && v.value.length === 2 && v.value[0].id === "gr_test1" && v.value[0].label === "Team" && v.value[0].options.length === 2, v);
  check("no name ⇒ refused (nothing is assumed)", !validateGroupRates([{ on: true, label: "", threshold: 3, amount: { type: "FIXED", value: 5 } }], newId).ok);
  check("two rates with one name ⇒ refused", !validateGroupRates([{ label: "Team", threshold: 2, amount: { type: "FIXED", value: 5 } }, { label: "team", threshold: 2, amount: { type: "FIXED", value: 5 } }], newId).ok);
  check("a group of 1 refused", !validateGroupRates([{ label: "Team", threshold: 1, amount: { type: "FIXED", value: 5 } }], newId).ok);
  check("an existing id is kept", (() => { const r = validateGroupRates([{ id: "gr_abcd12", label: "Team", threshold: 2, amount: { type: "FIXED", value: 5 } }], newId); return r.ok && r.value[0].id === "gr_abcd12"; })());
  check("junk stored blob reads as none", parseGroupRates("x").length === 0 && parseGroupRates([{ junk: 1 }]).length === 0);
  check("label reads naturally", groupRateLabel({ label: "Bus route" } as GroupRate, "Route 9") === "Route 9 bus route rate");
}

const rates: GroupRate[] = [
  { id: "team", on: true, label: "Team", threshold: 3, amount: { type: "PERCENT", value: 15 }, options: ["Varsity", "JV"], membershipIds: [] },
  { id: "bus", on: true, label: "Bus route", threshold: 2, amount: { type: "FIXED", value: 10 }, options: [], membershipIds: [] },
];

console.log("answers:");
{
  const c = cleanGroupValues(rates, { team: "varsity", bus: "  Route  9 ", other: "x" });
  check("pick-list answer matched to the list's spelling; typed one tidied; unknown dropped", c.ok && c.value.team === "Varsity" && c.value.bus === "Route 9" && !("other" in c.value), c);
  check("not on the list ⇒ refused", !cleanGroupValues(rates, { team: "Freshman" }).ok);
}

const sub = (memberId: string, gv: Record<string, string>, extra: Partial<GroupSub> = {}): GroupSub => ({ memberId, membershipId: "plan", listPrice: 150, status: "active", groupValues: gv, ...extra });

console.log("counting:");
{
  const subs = [sub("a", { team: "Varsity" }), sub("b", { team: "varsity" }), sub("c", { team: "JV" }), sub("d", { team: "Varsity" }, { deliberateFree: true }), sub("e", { team: "Varsity" }, { status: "canceled" })];
  const counts = groupCounts(rates, subs);
  check("comps and canceled don't count; case doesn't split", counts.get("team")!.get("varsity")!.size === 2, Array.from(counts.get("team")!.entries()).map(([k, v]) => [k, v.size]));
  check("2 of 3 on Varsity ⇒ nobody earns it yet", bestGroupRate({ rates, counts, memberId: "a", groupValues: { team: "Varsity" }, membershipId: "plan", listPrice: 150 }) === null);
  const q = bestGroupRate({ rates, counts, memberId: "f", groupValues: { team: "Varsity" }, membershipId: "plan", listPrice: 150, includeSelf: true });
  check("the 3rd signing up now earns 15% ($22.50) at checkout", !!q && q.off === 22.5 && q.label === "Varsity team rate", q);
  const both = groupCounts(rates, [...subs, sub("f", { team: "Varsity", bus: "9" }), sub("g", { bus: "9" })]);
  const best = bestGroupRate({ rates, counts: both, memberId: "f", groupValues: { team: "Varsity", bus: "9" }, membershipId: "plan", listPrice: 150 });
  check("in two groups ⇒ the bigger saving wins (15% = $22.50 > $10)", best?.rateId === "team", best);
  const cheap = bestGroupRate({ rates, counts: both, memberId: "f", groupValues: { team: "Varsity", bus: "9" }, membershipId: "plan", listPrice: 50 });
  check("…on a $50 plan the $10 bus rate wins over 15% ($7.50)", cheap?.rateId === "bus", cheap);
  const scoped: GroupRate[] = [{ ...rates[1], membershipIds: ["other"] }];
  check("a rate outside the plan never applies", bestGroupRate({ rates: scoped, counts: groupCounts(scoped, [sub("g", { bus: "9" })]), memberId: "f", groupValues: { bus: "9" }, membershipId: "plan", listPrice: 150, includeSelf: true }) === null);
  const off: GroupRate[] = [{ ...rates[1], on: false }];
  check("a rate switched off never applies", bestGroupRate({ rates: off, counts: groupCounts(off, [sub("g", { bus: "9" })]), memberId: "f", groupValues: { bus: "9" }, membershipId: "plan", listPrice: 150, includeSelf: true }) === null);
}

console.log("sibling vs group on one membership:");
{
  const sib = parseMembershipSibling({ on: true, shape: "EACH_ADDITIONAL", each: { type: "PERCENT", value: 10 } });
  const fam: SiblingSub[] = [
    { id: "s1", memberId: "k", memberName: "K", membershipId: "plan", listPrice: 200, price: 200, billingPeriod: "MONTHLY", status: "active", startDate: new Date("2026-01-01") },
    { id: "s2", memberId: "c", memberName: "C", membershipId: "plan", listPrice: 150, price: 150, billingPeriod: "MONTHLY", status: "active", startDate: new Date("2026-02-01") },
  ];
  const lines = planFamily(sib, fam);
  const cLine = lines.find((l) => l.memberId === "c")!;
  const grp = { rateId: "team", label: "Varsity team rate", rule: { type: "PERCENT" as const, value: 15 }, off: 22.5, count: 3, threshold: 3 };
  const merged = combineAuto(cLine, fam[1], grp);
  check("group 15% ($22.50) beats sibling 10% ($15) ⇒ group, $127.50, recommend", merged.source === "GROUP" && merged.expected === 127.5 && merged.drift === "DOWN" && merged.label === "Varsity team rate", merged);
  const kLine = lines.find((l) => l.memberId === "k")!;
  const kMerged = combineAuto(kLine, fam[0], grp.off ? { ...grp, off: 30 } : null);
  check("the full-price sibling still earns the group rate", kMerged.source === "GROUP" && kMerged.expected === 170 && kMerged.drift === "DOWN", kMerged);
  const noGrp = combineAuto(cLine, fam[1], null);
  check("no group ⇒ the sibling discount stands", noGrp.source === "SIBLING" && noGrp.expected === 135);
  const applied = combineAuto(cLine, { price: 127.5, discountSource: "GROUP" }, grp);
  check("already on the group rate ⇒ nothing to do", applied.drift === null);
  const lost = combineAuto(cLine, { price: 127.5, discountSource: "GROUP" }, null);
  check("group fell apart ⇒ flagged UP (sibling would be $135), never removed on its own", lost.drift === "UP" && lost.expected === 135, lost);
  const coach = combineAuto(cLine, { price: 140, discountSource: "COACH" }, grp);
  check("a hand-set price isn't second-guessed", coach.drift === null);
}

console.log("receipts:");
{
  check("receipt line", receiptDiscountLine("Varsity team rate", 22.5) === "Varsity team rate — $22.50 off");
  check("no discount ⇒ no line", receiptDiscountLine(null, 5) === null && receiptDiscountLine("X", 0) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
