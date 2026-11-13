/**
 * Parent portal shows the card that actually pays each membership (2026-11).
 *
 *   npx tsx scripts/paid-with-tests.ts
 *
 * One person can pay for many athletes from one card. Each athlete used to
 * show only the card saved on their own profile — often a different card, or
 * none. The digits are shown to the person who pays; others see who pays.
 */
import { harness, src } from "./_followup-harness";
import { paidWithLine } from "../lib/membershipMoney";

const { check, section, done } = harness();
const mc = { type: "card", brand: "mastercard", last4: "8793" };

section("the payer looking at athletes they pay for");
{
  const p = paidWithLine({ pm: mc, payerUserId: "payer", payerName: "Pat Payer", viewerUserId: "payer" });
  check("sees their own card, with digits", p?.text === "Mastercard ·8793 · your card" && p.yours === true && p.last4 === "8793", p);
  const eight = Array.from({ length: 8 }, () => paidWithLine({ pm: mc, payerUserId: "payer", payerName: "Pat Payer", viewerUserId: "payer" })?.text);
  check("all eight athletes show the same paying card", new Set(eight).size === 1 && eight[0] === "Mastercard ·8793 · your card");
}

section("someone else looking after the athlete");
{
  const p = paidWithLine({ pm: mc, payerUserId: "payer", payerName: "Pat Payer", viewerUserId: "parent" });
  check("sees WHO pays", p?.text === "Pat Payer's card" && p.yours === false, p);
  check("never the card digits", !/8793/.test(p?.text ?? "") && p?.last4 === null);
  const unnamed = paidWithLine({ pm: mc, payerUserId: "payer", payerName: null, viewerUserId: "parent" });
  check("an unnamed payer is still not shown as theirs", unnamed?.text === "Another person's card" && unnamed.yours === false);
  const noPm = paidWithLine({ pm: null, payerUserId: "payer", payerName: "Pat Payer", viewerUserId: "parent" });
  check("still says who pays when Stripe didn't answer", noPm?.text === "Pat Payer's card");
}

section("no payer recorded (the family's own card)");
{
  const p = paidWithLine({ pm: { type: "card", brand: "visa", last4: "4242" }, payerUserId: null, payerName: null, viewerUserId: "parent" });
  check("shows the card", p?.text === "Visa ·4242" && p.yours === true);
  check("nothing known → nothing shown (falls back to card on file)", paidWithLine({ pm: null, payerUserId: null, payerName: null, viewerUserId: "parent" }) === null);
}

section("source guarantees");
{
  const route = src("app/api/member/billing/route.ts");
  check("read from the SUBSCRIPTION, not from the athlete's card on file", route.includes("liveStripeFacts(active.stripeSubscriptionId, stripeAccountId"));
  check("the payer is the subscription's own payer first", route.includes("active.payerUserId ?? m.responsiblePayerUserId"));
  check("payer names are looked up inside this club only", /findMany\(\{ where: \{ id: \{ in: subPayerIds \}, clubId \}/.test(route));
  const page = src("app/member/profile/page.tsx");
  check("the portal leads with the paying card", page.includes("Membership paid with ${p.paidWith.text}"));
  check("a different card on file gets its own row", page.includes('label="Card on file"'));
}
done();
