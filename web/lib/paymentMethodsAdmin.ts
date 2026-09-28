import Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { pmRef } from "@/lib/billingAdmin";
import { isOffSessionChargeable, lastPaidWithFromCharges, type LastPaidWith } from "@/lib/billingDataRules";

// Server-side payment-method lookup for the billing control center. Raw
// Stripe payment-method ids never leave the server — clients hold an opaque
// ref (sha256 digest) and every action re-lists the customer's methods to
// find the match. Read helpers here never mutate anything.

export const LIVE_SUB_STATUSES = new Set(["active", "trialing", "past_due", "unpaid"]);

export type LocatedPaymentMethod = {
  pm: Stripe.PaymentMethod;
  customerId: string;
  role: "SETUP" | "LEGACY";
  /** Customer-level default payment method id (if any). */
  customerDefaultPmId: string | null;
  /** Live subs on that customer whose EFFECTIVE payment method is this one. */
  liveSubsCharging: Stripe.Subscription[];
  /** All live subs on that customer. */
  liveSubs: Stripe.Subscription[];
  /** Other usable methods on the same customer (excluding this one). */
  otherMethods: Stripe.PaymentMethod[];
};

type MemberCustomers = {
  stripeSetupCustomerId: string | null;
  stripeCustomerId: string | null;
};

export function memberCustomerIds(member: MemberCustomers): { id: string; role: "SETUP" | "LEGACY" }[] {
  const out: { id: string; role: "SETUP" | "LEGACY" }[] = [];
  if (member.stripeSetupCustomerId) out.push({ id: member.stripeSetupCustomerId, role: "SETUP" });
  if (member.stripeCustomerId && member.stripeCustomerId !== member.stripeSetupCustomerId) {
    out.push({ id: member.stripeCustomerId, role: "LEGACY" });
  }
  return out;
}

/**
 * EVERY payment method attached to the customer, whatever its type — card,
 * Link, Cash App Pay, bank account, PayPal, … `customers.listPaymentMethods`
 * without a `type` filter returns all of them (stripe-node 14.x). The old
 * card + link lists made a Cash App Pay family read "No saved payment method"
 * while Stripe billed them every month (Blake D., 2026-09-28).
 *
 * Callers that are about to CHARGE must filter with isOffSessionChargeable —
 * showing a method and choosing it for an off-session charge are different.
 */
export async function listPaymentMethodsForCustomer(
  customerId: string,
  stripeAccount: string,
  limit = 50,
): Promise<Stripe.PaymentMethod[]> {
  const list = await stripe.customers.listPaymentMethods(customerId, { limit }, { stripeAccount });
  return list.data;
}

/**
 * How this person actually paid last: the newest SUCCEEDED charge across their
 * Stripe customers. Answers "how do they pay" even when nothing reusable is
 * saved (a one-time Cash App Pay, a wallet that was never attached). Never
 * throws — null on any Stripe error.
 */
export async function lastPaidWithForCustomers(
  customerIds: string[],
  stripeAccount: string,
): Promise<LastPaidWith | null> {
  const all: Stripe.Charge[] = [];
  for (const customer of customerIds) {
    try {
      const charges = await stripe.charges.list({ customer, limit: 10 }, { stripeAccount });
      all.push(...charges.data);
    } catch {
      /* degrade — a missing "last paid with" must never break the billing read */
    }
  }
  return lastPaidWithFromCharges(all as unknown as Parameters<typeof lastPaidWithFromCharges>[0]);
}

/**
 * Find the payment method matching an opaque ref across the member's Stripe
 * customers, with everything needed for safety checks. Null when no match.
 */
export async function locatePaymentMethod(
  member: MemberCustomers,
  stripeAccount: string,
  ref: string,
): Promise<LocatedPaymentMethod | null> {
  for (const cust of memberCustomerIds(member)) {
    const methods = await listPaymentMethodsForCustomer(cust.id, stripeAccount);
    const match = methods.find((pm) => pmRef(pm.id) === ref);
    if (!match) continue;

    const customer = await stripe.customers.retrieve(cust.id, { stripeAccount });
    let customerDefaultPmId: string | null = null;
    if (customer && !("deleted" in customer && customer.deleted)) {
      const def = (customer as Stripe.Customer).invoice_settings?.default_payment_method;
      customerDefaultPmId = typeof def === "string" ? def : def?.id ?? null;
    }

    const subs = await stripe.subscriptions.list(
      { customer: cust.id, status: "all", limit: 20 },
      { stripeAccount },
    );
    const liveSubs = subs.data.filter((s) => LIVE_SUB_STATUSES.has(s.status));
    const liveSubsCharging = liveSubs.filter((s) => {
      const subPm = typeof s.default_payment_method === "string" ? s.default_payment_method : s.default_payment_method?.id;
      const effective = subPm || customerDefaultPmId;
      return effective === match.id;
    });

    return {
      pm: match,
      customerId: cust.id,
      role: cust.role,
      customerDefaultPmId,
      liveSubsCharging,
      liveSubs,
      // Only methods the app could actually charge instead count as a
      // fallback (this is what the "safe to remove" check reads). A Cash App
      // Pay or PayPal method is listed, but is not a replacement card.
      otherMethods: methods.filter((pm) => pm.id !== match.id && isOffSessionChargeable(pm)),
    };
  }
  return null;
}
