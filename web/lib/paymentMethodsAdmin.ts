import Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { pmRef } from "@/lib/billingAdmin";

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

export async function listPaymentMethodsForCustomer(
  customerId: string,
  stripeAccount: string,
): Promise<Stripe.PaymentMethod[]> {
  const [cards, links] = await Promise.all([
    stripe.paymentMethods.list({ customer: customerId, type: "card", limit: 20 }, { stripeAccount }),
    stripe.paymentMethods
      .list({ customer: customerId, type: "link", limit: 20 }, { stripeAccount })
      .catch(() => ({ data: [] as Stripe.PaymentMethod[] })),
  ]);
  return [...cards.data, ...links.data];
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
      otherMethods: methods.filter((pm) => pm.id !== match.id),
    };
  }
  return null;
}
