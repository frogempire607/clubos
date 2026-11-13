/**
 * Each payment in the history names what it was paid with (2026-11, B28):
 * "Visa ·4242", "Cash", "Check" — not just "Stripe".
 *
 *   npx tsx scripts/payment-method-label-tests.ts
 */
import { harness, src } from "./_followup-harness";
import { paymentMethodShort, paymentRowMethod, offlineMethodWord, chargePmFacts } from "../lib/membershipMoney";

const { check, section, done } = harness();

section("card and wallet payments");
check("Visa ·4242", paymentMethodShort({ type: "card", brand: "visa", last4: "4242" }) === "Visa ·4242", paymentMethodShort({ type: "card", brand: "visa", last4: "4242" }));
check("Mastercard ·8793", paymentRowMethod({ source: "STRIPE", pm: { type: "card", brand: "mastercard", last4: "8793" } }) === "Mastercard ·8793");
check("Cash App Pay has no digits", paymentRowMethod({ source: "STRIPE", pm: { type: "cashapp" } }) === "Cash App Pay");
check("a wallet names the wallet and the card", /Apple Pay/.test(paymentRowMethod({ source: "STRIPE", pm: { type: "card", brand: "visa", last4: "4242", wallet: "apple_pay" } })));
check("a bank account shows its last four", /·6789$/.test(paymentRowMethod({ source: "STRIPE", pm: { type: "us_bank_account", last4: "6789" } })));
check("Stripe didn't answer → 'Card', never a guess", paymentRowMethod({ source: "STRIPE", pm: null }) === "Card");

section("money that never went through Stripe");
check("Cash", paymentRowMethod({ source: "CASH" }) === "Cash");
check("Check", paymentRowMethod({ source: "check" }) === "Check");
check("a waived month", paymentRowMethod({ source: "COMP" }) === "Waived / comp");
check("the card reader at the desk", paymentRowMethod({ source: "EXTERNAL_READER" }) === "Card reader");
check("offline wins even if card facts are passed by mistake", paymentRowMethod({ source: "CASH", pm: { type: "card", brand: "visa", last4: "4242" } }) === "Cash");
check("STRIPE is not an offline word", offlineMethodWord("STRIPE") === null && offlineMethodWord(null) === null);

section("reading a Stripe charge");
check("card details", JSON.stringify(chargePmFacts({ type: "card", card: { brand: "visa", last4: "4242", wallet: null } })) === JSON.stringify({ type: "card", brand: "visa", last4: "4242", wallet: null }));
check("wallet type is carried", chargePmFacts({ type: "card", card: { brand: "visa", last4: "4242", wallet: { type: "google_pay" } } })?.wallet === "google_pay");
check("bank last four", chargePmFacts({ type: "us_bank_account", us_bank_account: { last4: "6789" } })?.last4 === "6789");
check("nothing to read → null", chargePmFacts(null) === null && chargePmFacts({}) === null);

section("source guarantees");
{
  const route = src("app/api/members/[id]/membership-panel/route.ts");
  check("the panel reads each payment's own charge", route.includes("chargeMethodsFor(shown.filter(isStripeTx)"));
  check("…and labels with paymentRowMethod", route.includes("paymentRowMethod({ source: src, pm: chargePms.get(t.id)"));
  const server = src("lib/membershipMoneyServer.ts");
  check("the Stripe read is bounded by a timeout and never throws", /Promise\.race\(\[work, new Promise<void>/.test(server) && /charge method read failed/.test(server));
}
done();
