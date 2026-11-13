/**
 * Checkouts that were started and never finished are closed after 24 hours
 * (2026-11 follow-up).
 *
 *   npx tsx scripts/stale-checkouts-tests.ts
 *
 * The one thing this must never do is close a checkout somebody PAID.
 */
import { harness, src } from "./_followup-harness";
import { isStaleCheckoutCandidate, staleCheckoutDecision, STALE_CHECKOUT_MS } from "../lib/staleCheckouts";

const { check, section, done } = harness();
const now = new Date();
const ago = (h: number) => new Date(now.getTime() - h * 3_600_000);
const cand = (o = {}) => ({ status: "pending", stripeCheckoutSessionId: "cs_test_1", stripeSubscriptionId: null, updatedAt: ago(30), ...o });

section("which rows are even looked at");
check("24 hours is the line", STALE_CHECKOUT_MS === 24 * 3_600_000);
check("pending + checkout started 30h ago → candidate", isStaleCheckoutCandidate(cand(), now));
check("started 23h ago → not yet", !isStaleCheckoutCandidate(cand({ updatedAt: ago(23) }), now));
check("an OFFLINE row waiting for cash (no checkout session) → never", !isStaleCheckoutCandidate(cand({ stripeCheckoutSessionId: null }), now));
check("a row with a Stripe subscription → never", !isStaleCheckoutCandidate(cand({ stripeSubscriptionId: "sub_1" }), now));
check("an active row → never", !isStaleCheckoutCandidate(cand({ status: "active" }), now));

section("what Stripe has to say before anything closes");
check("Stripe says expired + unpaid → close", staleCheckoutDecision({ status: "expired", paymentStatus: "unpaid", created: ago(30) }, now) === "CLOSE");
check("Stripe says COMPLETE → never closed, flagged for review", staleCheckoutDecision({ status: "complete", paymentStatus: "paid", created: ago(30) }, now) === "COMPLETED_NEEDS_REVIEW");
check("paid, whatever the session status → never closed", staleCheckoutDecision({ status: "expired", paymentStatus: "paid", created: ago(30) }, now) === "COMPLETED_NEEDS_REVIEW");
check("a $0 (free trial) checkout that completed → never closed", staleCheckoutDecision({ status: "complete", paymentStatus: "no_payment_required", created: ago(30) }, now) === "COMPLETED_NEEDS_REVIEW");
check("still open and under 24h old (a retry on an old row) → left alone", staleCheckoutDecision({ status: "open", paymentStatus: "unpaid", created: ago(2) }, now) === "LEAVE");
check("still open but past 24h → close", staleCheckoutDecision({ status: "open", paymentStatus: "unpaid", created: ago(25) }, now) === "CLOSE");
check("Stripe could not be asked → left alone", staleCheckoutDecision(null, now) === "LEAVE");
check("an unknown status → left alone", staleCheckoutDecision({ status: null, paymentStatus: null, created: null }, now) === "LEAVE");

section("source guarantees");
{
  const server = src("lib/staleCheckoutsServer.ts");
  check("only pending rows with a checkout session and no subscription are read", /status: "pending", stripeSubscriptionId: null, stripeCheckoutSessionId: \{ not: null \}/.test(server));
  check("the session is read from Stripe before deciding", server.includes("stripe.checkout.sessions.retrieve("));
  check("the close is a conditional claim (a payment landing now wins)", /updateMany\(\{\s*where: \{ id: row\.id, status: "pending", stripeSubscriptionId: null/.test(server));
  check("an audit row is written for every close", server.includes('action: "STALE_CHECKOUT_CLOSED"'));
  check("a subscription event is written too", server.includes("SUBSCRIPTION_EVENT_KIND.CANCELED"));
  check("nothing is deleted", !/\.delete(Many)?\(/.test(server));
  const cron = src("app/api/cron/event-charges/route.ts");
  check("it runs from the hourly cron", cron.includes("closeStaleCheckouts({"));
  check("…after the charges, and a failure can't fail them", cron.indexOf("runDueEventCharges({") < cron.indexOf("closeStaleCheckouts({") && /catch \(e\) \{\s*console\.error\("\[cron\] stale checkout sweep failed"/.test(cron));
  check("the cron route still only exports handlers and config", !/export (async )?function (?!GET|POST)/.test(cron));
}
done();
