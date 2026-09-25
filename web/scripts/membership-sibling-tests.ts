/**
 * B3 slice 2 — lib/membershipSiblingDiscount (pure). `npm run test:membership-sibling`.
 * Worked example: the Lister family — Kellen $530/quarter, Cameron $150/month.
 */
import {
  parseMembershipSibling, validateMembershipSibling, siblingOn, planFamily, siblingForPurchase, monthlyEquivalent,
  membershipSiblingSummary, membershipSiblingLabel, type SiblingSub,
} from "../lib/membershipSiblingDiscount";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}

const cfg = parseMembershipSibling({ on: true, shape: "EACH_ADDITIONAL", each: { type: "PERCENT", value: 10 }, discountWhich: "CHEAPER" });
const sub = (id: string, memberId: string, listPrice: number, period: string, extra: Partial<SiblingSub> = {}): SiblingSub => ({
  id, memberId, memberName: memberId, membershipId: "plan", listPrice, price: listPrice, billingPeriod: period, status: "active",
  startDate: new Date(`2026-0${id.length}-01T00:00:00Z`), ...extra,
});

console.log("config:");
{
  check("empty = off", !siblingOn(parseMembershipSibling({})));
  check("junk = off, never throws", !siblingOn(parseMembershipSibling("x")) && !siblingOn(parseMembershipSibling(null)));
  check("on with an amount = on", siblingOn(cfg));
  check("default: the cheaper membership is discounted", parseMembershipSibling({}).discountWhich === "CHEAPER");
  check("on with no amount refused", !validateMembershipSibling({ on: true, shape: "EACH_ADDITIONAL" }).ok);
  check("percent over 100 refused", !validateMembershipSibling({ on: true, shape: "EACH_ADDITIONAL", each: { type: "PERCENT", value: 101 } }).ok);
  const v = validateMembershipSibling({ on: true, shape: "EACH_ADDITIONAL", each: { type: "FIXED", value: 20 }, discountWhich: "PRICIER", membershipIds: ["a", "a", "b"] });
  check("plans de-duplicated, PRICIER kept", v.ok && v.value.membershipIds.length === 2 && v.value.discountWhich === "PRICIER", v);
  check("summary", membershipSiblingSummary(cfg) === "On — each athlete after the first gets 10% off; the priciest membership pays full price.", membershipSiblingSummary(cfg));
  check("label", membershipSiblingLabel(2) === "Sibling membership discount (2nd athlete)");
}

console.log("per-month comparison:");
{
  check("$530/quarter ≈ $176.67/month", Math.abs(monthlyEquivalent(530, "QUARTERLY") - 176.67) < 0.01);
  check("annual /12", monthlyEquivalent(1200, "ANNUAL") === 100);
}

console.log("who pays full price:");
{
  const fam = [sub("k", "Kellen", 530, "QUARTERLY"), sub("cc", "Cameron", 150, "MONTHLY")];
  const lines = planFamily(cfg, fam);
  const k = lines.find((l) => l.memberId === "Kellen")!, c = lines.find((l) => l.memberId === "Cameron")!;
  check("pricier per month (Kellen) pays full", k.position === 1 && k.rule === null && k.expected === 530);
  check("cheaper (Cameron) is the 2nd athlete, 10% off", c.position === 2 && c.expected === 135 && c.label === "Sibling membership discount (2nd athlete)", c);
  check("Cameron priced at list ⇒ recommend DOWN", c.drift === "DOWN");
  check("Kellen: no drift", k.drift === null);
  const pricier = planFamily({ ...cfg, discountWhich: "PRICIER" }, fam);
  check("PRICIER: Kellen discounted instead", pricier.find((l) => l.memberId === "Kellen")!.position === 2);
  const applied = planFamily(cfg, [fam[0], { ...fam[1], price: 135, discountSource: "SIBLING" }]);
  check("already discounted ⇒ no drift", applied.every((l) => l.drift === null), applied);
}

console.log("who counts:");
{
  const comp = planFamily(cfg, [sub("k", "Kellen", 530, "QUARTERLY"), sub("cc", "Cameron", 0, "MONTHLY", { deliberateFree: true })]);
  check("a comp never makes a 2nd athlete", comp.every((l) => l.rule === null));
  const ended = planFamily(cfg, [sub("k", "Kellen", 530, "QUARTERLY"), sub("cc", "Cameron", 150, "MONTHLY", { status: "canceled" })]);
  check("a canceled membership doesn't count", ended.every((l) => l.rule === null));
  const scoped = planFamily({ ...cfg, membershipIds: ["other"] }, [sub("k", "Kellen", 530, "QUARTERLY"), sub("cc", "Cameron", 150, "MONTHLY")]);
  check("plans outside the rule don't count", scoped.every((l) => l.position === null));
  const twoForOne = planFamily(cfg, [sub("k", "Kellen", 530, "QUARTERLY"), sub("kk", "Kellen", 100, "MONTHLY")]);
  check("one athlete with two memberships isn't their own sibling", twoForOne.every((l) => l.rule === null));
  const tie = planFamily(cfg, [sub("aa", "A", 150, "MONTHLY"), sub("b", "B", 150, "MONTHLY")]);
  check("same price: whoever started first pays full (stable)", tie.find((l) => l.memberId === "B")!.position === 1, tie);
}

console.log("drift up:");
{
  const alone = planFamily(cfg, [sub("cc", "Cameron", 150, "MONTHLY", { price: 135, discountSource: "SIBLING" })]);
  check("sibling left ⇒ the discount is flagged UP, not removed", alone[0].drift === "UP" && alone[0].expected === 150);
  const off = planFamily({ ...cfg, on: false }, [sub("k", "Kellen", 530, "QUARTERLY"), sub("cc", "Cameron", 150, "MONTHLY", { price: 135, discountSource: "SIBLING" })]);
  check("rule turned off ⇒ flagged UP", off.find((l) => l.memberId === "Cameron")!.drift === "UP");
  const code = planFamily(cfg, [sub("k", "Kellen", 530, "QUARTERLY"), sub("cc", "Cameron", 150, "MONTHLY", { price: 120, discountSource: "CODE" })]);
  check("a bigger code discount isn't second-guessed", code.every((l) => l.drift === null));
  const coach = planFamily(cfg, [sub("k", "Kellen", 530, "QUARTERLY"), sub("cc", "Cameron", 150, "MONTHLY", { price: 145, discountSource: "COACH" })]);
  check("a hand-set price isn't flagged", coach.every((l) => l.drift === null));
}

console.log("a purchase now:");
{
  const fam = [sub("k", "Kellen", 530, "QUARTERLY")];
  const q = siblingForPurchase(cfg, fam, { memberId: "Cameron", memberName: "Cameron", membershipId: "plan", listPrice: 150, billingPeriod: "MONTHLY" });
  check("2nd kid buying the cheaper plan ⇒ 10% off at checkout", q.position === 2 && q.off === 15, q);
  const first = siblingForPurchase(cfg, [], { memberId: "Kellen", memberName: "Kellen", membershipId: "plan", listPrice: 530, billingPeriod: "QUARTERLY" });
  check("first athlete pays full", first.off === 0 && first.rule === null);
  const pricier = siblingForPurchase(cfg, [sub("cc", "Cameron", 150, "MONTHLY")], { memberId: "Kellen", memberName: "Kellen", membershipId: "plan", listPrice: 530, billingPeriod: "QUARTERLY" });
  check("buying the PRICIER plan second ⇒ it pays full (the sibling gets flagged instead)", pricier.off === 0 && pricier.position === 1, pricier);
  const again = siblingForPurchase(cfg, fam, { memberId: "Kellen", memberName: "Kellen", membershipId: "plan", listPrice: 100, billingPeriod: "MONTHLY" });
  check("a 2nd membership for the same athlete gets nothing", again.off === 0);
  const ladder = parseMembershipSibling({ on: true, shape: "LADDER", tiers: [{ type: "PERCENT", value: 10 }, { type: "FIXED", value: 30 }] });
  const third = siblingForPurchase(ladder, [sub("k", "Kellen", 530, "QUARTERLY"), sub("cc", "Cameron", 150, "MONTHLY")], { memberId: "Dana", memberName: "Dana", membershipId: "plan", listPrice: 120, billingPeriod: "MONTHLY" });
  check("ladder: the 3rd athlete gets the 3rd step ($30)", third.position === 3 && third.off === 30, third);
  check("off never more than the price", siblingForPurchase(parseMembershipSibling({ on: true, shape: "EACH_ADDITIONAL", each: { type: "FIXED", value: 500 } }), fam, { memberId: "C", memberName: "C", membershipId: "plan", listPrice: 150, billingPeriod: "MONTHLY" }).off === 150);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
