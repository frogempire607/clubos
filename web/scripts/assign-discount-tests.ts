/**
 * Assign membership × automatic discounts — lib/membershipAssignQuote (pure)
 * over lib/membershipSiblingDiscount's family positions. No database.
 * Worked example: Jaden (already on $75/month) and his brother Eli, assigned
 * now; the club's rule is 25% off each additional athlete, the priciest pays full.
 */
import { parseMembershipSibling, siblingForPurchase, planFamily, type SiblingSub } from "../lib/membershipSiblingDiscount";
import { composeAssignQuote, chooseMembershipDiscount, bestAuto, offerChargePlan, type AutoDiscount } from "../lib/membershipAssignQuote";
import type { ValidDiscount } from "../lib/discounts";

// lib/discounts discountedPrice, restated so this file never loads the prisma
// client (the server passes the real one's result as codeNet).
const discountedPrice = (price: number, d: ValidDiscount) =>
  Math.max(0, Math.round((price - (d.type === "PERCENT" ? (price * d.value) / 100 : d.value)) * 100) / 100);

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}

const cfg = parseMembershipSibling({ on: true, shape: "EACH_ADDITIONAL", each: { type: "PERCENT", value: 25 }, discountWhich: "CHEAPER", membershipIds: ["plan"] });
const jaden: SiblingSub = {
  id: "s-jaden", memberId: "jaden", memberName: "Jaden Cole", membershipId: "plan", listPrice: 75, price: 75,
  billingPeriod: "MONTHLY", status: "active", startDate: new Date("2026-03-01T00:00:00Z"),
};
const buy = (price: number, membershipId = "plan", c = cfg) =>
  siblingForPurchase(c, [jaden], { memberId: "eli", memberName: "Eli Cole", membershipId, listPrice: price, billingPeriod: "MONTHLY", startDate: new Date("2026-09-30T00:00:00Z") });
const autoFrom = (r: ReturnType<typeof buy>): AutoDiscount[] =>
  r.rule && r.off > 0 ? [{ source: "SIBLING", rule: r.rule, label: r.label!, off: r.off, fullPriceName: r.fullPrice && r.fullPrice.memberId !== "eli" ? r.fullPrice.memberName.split(" ")[0] : null }] : [];
const code = (c: string, type: "PERCENT" | "FIXED", value: number): ValidDiscount => ({ id: `d-${c}`, code: c, type, value });
const q = (over: Partial<Parameters<typeof composeAssignQuote>[0]> = {}) => {
  const base = { firstName: "Eli", listPrice: 75, billingPeriod: "MONTHLY", override: null, applyFamily: true, autos: autoFrom(buy(75)), code: null, codeNet: 75, method: "CASH" as const, passProcessingFees: false };
  const input = { ...base, ...over };
  if (input.code && over.codeNet === undefined) input.codeNet = discountedPrice(input.listPrice, input.code);
  return composeAssignQuote(input);
};

console.log("sibling applies to the second athlete:");
{
  const r = buy(75);
  check("Eli is the 2nd athlete, 25% off = $18.75", r.position === 2 && r.off === 18.75, r);
  check("Jaden (started first) pays full price", r.fullPrice?.memberId === "jaden" && r.counted === 2, r.fullPrice);
  const x = q();
  check("final $56.25/month", x.finalPrice === 56.25 && x.periodSuffix === "/month", x.finalPrice);
  check("the sheet's line", x.applied?.line === "Sibling discount · 25% off · $75 → $56.25/month · Jaden pays full price", x.applied?.line);
  check("the sentence", x.sentence === "Eli pays $56.25/month instead of $75 — sibling discount (Jaden pays full price).", x.sentence);
  check("stored like every purchase path (SIBLING, no code)", x.fields.discountSource === "SIBLING" && x.fields.discountCode === null && x.fields.discountAmount === 18.75 && x.fields.discountType === "PERCENT" && x.fields.discountValue === 25 && x.fields.discountLabel === "Sibling membership discount (2nd athlete)", x.fields);
  check("the Don't apply switch shows", x.autoAvailable === true);
  const alone = siblingForPurchase(cfg, [], { memberId: "eli", memberName: "Eli Cole", membershipId: "plan", listPrice: 75, billingPeriod: "MONTHLY" });
  check("an only athlete gets nothing", alone.off === 0 && alone.position === 1 && alone.counted === 1, alone);
}

console.log("which athlete pays full price:");
{
  const pricier = buy(120);
  check("CHEAPER rule: Eli on $120 becomes 1st and pays full", pricier.position === 1 && pricier.off === 0 && pricier.fullPrice?.memberId === "eli" && pricier.counted === 2, pricier);
  const flipped = buy(120, "plan", { ...cfg, discountWhich: "PRICIER" });
  check("PRICIER rule: Eli on $120 is discounted ($30 off)", flipped.position === 2 && flipped.off === 30, flipped);
  const x = q({ listPrice: 120, autos: autoFrom(pricier) });
  check("no discount row when Eli pays full", x.applied === null && x.finalPrice === 120 && x.candidates.length === 0, x);
}

console.log("one discount per membership — the bigger saving wins:");
{
  const big = q({ code: code("SAVE30", "PERCENT", 30) });
  check("30% code beats 25% sibling", big.finalPrice === 52.5 && big.applied?.source === "CODE" && big.codeWon === true && big.fields.discountCode === "SAVE30", big.fields);
  check("sibling row marked not applied", big.candidates.find((c) => c.source === "SIBLING")?.status === "LOST");
  const small = q({ code: code("TEN", "PERCENT", 10) });
  check("25% sibling beats 10% code", small.finalPrice === 56.25 && small.applied?.source === "SIBLING" && small.codeWon === false, small.fields);
  check("the code row says why", small.candidates.find((c) => c.source === "CODE")?.note === "Not applied — the sibling discount saves more. One discount per membership.");
  const tie = q({ code: code("FLAT", "FIXED", 18.75) });
  check("a tie goes to the sibling discount (the code isn't burned)", tie.applied?.source === "SIBLING" && tie.codeWon === false, tie.applied);
  const shared = chooseMembershipDiscount({ list: 75, code: null, codeNet: 75, auto: { rule: { type: "PERCENT", value: 25 }, label: "L", off: 18.75, source: "SIBLING" } });
  check("the shared chooser (purchase paths) agrees", shared.finalPrice === 56.25 && shared.fields.discountSource === "SIBLING");
  const grp: AutoDiscount = { source: "GROUP", rule: { type: "PERCENT", value: 20 }, label: "Lincoln High school rate", off: 15 };
  check("sibling 25% beats a 20% group rate", bestAuto([...autoFrom(buy(75)), grp])?.source === "SIBLING");
  check("a tied group rate loses to the sibling discount", bestAuto([{ ...grp, off: 18.75 }, ...autoFrom(buy(75))])?.source === "SIBLING");
  const g = q({ autos: [grp] });
  check("group rate alone applies with its own name", g.applied?.line === "Lincoln High school rate · 20% off · $75 → $60/month" && g.fields.discountSource === "GROUP", g.applied?.line);
}

console.log("a typed price wins over everything:");
{
  const x = q({ override: 60, code: code("SAVE30", "PERCENT", 30) });
  check("override $60 is charged", x.finalPrice === 60 && x.applied === null && x.codeWon === false, x);
  check("no discount stored with it", x.fields.discountSource === null && x.fields.discountAmount === null && x.fields.discountCode === null);
  check("every discount marked overridden, and the sheet says so", x.candidates.every((c) => c.status === "OVERRIDDEN") && !!x.overrideNote?.includes("no discount is applied on top"), x.overrideNote);
}

console.log("\"Don't apply\" is respected:");
{
  const x = q({ applyFamily: false });
  check("full price when turned off", x.finalPrice === 75 && x.applied === null && x.fields.discountSource === null, x.fields);
  check("the row shows it was turned off", x.candidates[0]?.status === "OFF" && x.autoAvailable === true);
  const withCode = q({ applyFamily: false, code: code("TEN", "PERCENT", 10) });
  check("a code still applies with the family discount off", withCode.finalPrice === 67.5 && withCode.applied?.source === "CODE");
}

console.log("plan not covered:");
{
  const r = buy(75, "other-plan");
  check("no position, no discount", r.position === null && r.off === 0, r);
  const x = q({ autos: autoFrom(r) });
  check("full price, nothing to toggle", x.finalPrice === 75 && x.autoAvailable === false && x.candidates.length === 0);
}

console.log("processing fee on the discounted amount:");
{
  const card = q({ method: "CARD", passProcessingFees: true });
  check("2.9% of $56.25 = $1.63", card.fee === 1.63, card.fee);
  check("first charge $57.88", card.firstCharge === 57.88, card.firstCharge);
  const noPass = q({ method: "CARD", passProcessingFees: false });
  check("no fee when the club absorbs it", noPass.fee === 0 && noPass.firstCharge === 56.25);
  const cash = q({ method: "CASH", passProcessingFees: true });
  check("cash never carries a card fee", cash.fee === 0 && cash.firstCharge === 56.25);
}

console.log("no drift right after assignment:");
{
  const x = q();
  // The row as every assign path writes it: price = final, discountAmount = off;
  // loadFamilies rebuilds listPrice = price + discountAmount.
  const eliRow: SiblingSub = {
    id: "s-eli", memberId: "eli", memberName: "Eli Cole", membershipId: "plan",
    listPrice: x.finalPrice + (x.fields.discountAmount ?? 0), price: x.finalPrice, billingPeriod: "MONTHLY", status: "active",
    discountSource: x.fields.discountSource, startDate: new Date("2026-09-30T00:00:00Z"),
  };
  const lines = planFamily(cfg, [jaden, eliRow]);
  check("Eli: expected $56.25, no drift", lines.find((l) => l.memberId === "eli")?.expected === 56.25 && lines.every((l) => l.drift === null), lines);
}

console.log("offer link — the first charge date a card-mode offer needs:");
{
  const now = new Date("2026-09-30T15:00:00Z");
  const offer = q({ method: "OFFER", passProcessingFees: true });
  check("an offer's own first charge carries no fee (the card fee is the link's)", offer.fee === 0 && offer.firstCharge === 56.25);
  check("the card amount on the link is the discounted price + fee", offer.cardCharge === 57.88, offer.cardCharge);
  const missing = offerChargePlan({ cardMode: true, date: "", cardCharge: 56.25, billingPeriod: "MONTHLY", now });
  check("card-mode offer without a date can't be sent", missing.needsDate && !missing.ok && missing.firstChargeDate === null, missing);
  const junk = offerChargePlan({ cardMode: true, date: "10/31/2026", cardCharge: 56.25, billingPeriod: "MONTHLY", now });
  check("a malformed date is refused", !junk.ok && junk.firstChargeDate === null);
  const later = offerChargePlan({ cardMode: true, date: "2026-10-15", cardCharge: 56.25, billingPeriod: "MONTHLY", now });
  check("a future date is sent as firstChargeDate", later.ok && later.firstChargeDate === "2026-10-15" && !later.immediate, later);
  check("the sheet's sentence", later.line === "Nothing is charged until they accept — then the card is charged $56.25 on Oct 15, 2026, monthly after.", later.line);
  const today = offerChargePlan({ cardMode: true, date: "2026-09-30", cardCharge: 57.88, billingPeriod: "MONTHLY", now });
  check("the start date = today charges on acceptance (what /reactivation's chargeTiming says)", today.ok && today.immediate && today.firstChargeDate === "2026-09-30", today);
  check("…and says so", today.line === "Nothing is charged until they accept — then the card is charged $57.88 as soon as they accept, monthly after.", today.line);
  const quarterly = offerChargePlan({ cardMode: true, date: "2026-11-01", cardCharge: 150, billingPeriod: "QUARTERLY", now });
  check("period word follows the option", quarterly.line.endsWith("every 3 months after."), quarterly.line);
  const offline = offerChargePlan({ cardMode: false, date: "", cardCharge: 56.25, billingPeriod: "MONTHLY", now });
  check("cash/check (offline) offers need no date, send none", offline.ok && !offline.needsDate && offline.firstChargeDate === null, offline);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
