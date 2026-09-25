// B10 slice 3 — product money reaches Financials.
//
// Before this, a product sale (cash at the desk or Stripe) wrote a ProductSale
// row and nothing else: no Transaction, so Financials, Reports and the P&L
// never saw a dollar of merch, rentals or parties. This is the one writer.
// Stripe money dedupes on the PaymentIntent id (a replayed webhook is a no-op).

import { prisma } from "@/lib/prisma";
import { verifiedStripeTxFields, type StripeMoneyFacts } from "@/lib/stripeTruth";

export async function recordProductMoney(args: {
  clubId: string;
  memberId: string | null;
  amount: number;
  description: string;
  method: "STRIPE" | "CASH";
  paymentIntentId?: string | null;
  money?: StripeMoneyFacts | null;
  discountCode?: string | null;
  discountAmount?: number | null;
  recordedByUserId?: string | null;
}): Promise<string | null> {
  if (!(args.amount > 0)) return null;
  if (args.method === "STRIPE" && args.paymentIntentId) {
    const existing = await prisma.transaction.findFirst({ where: { stripePaymentIntentId: args.paymentIntentId }, select: { id: true } });
    if (existing) return existing.id;
  }
  const tx = await prisma.transaction.create({
    data: {
      clubId: args.clubId,
      memberId: args.memberId,
      amount: Math.round(args.amount * 100) / 100,
      status: "SUCCEEDED",
      type: "PRODUCT",
      category: "products",
      description: args.description,
      txDate: new Date(),
      discountCode: args.discountCode ?? null,
      discountAmount: args.discountAmount ?? null,
      recordedByUserId: args.recordedByUserId ?? null,
      ...(args.method === "STRIPE"
        ? { paymentMethod: "STRIPE", stripePaymentIntentId: args.paymentIntentId ?? undefined, ...verifiedStripeTxFields(args.money ?? null) }
        : { paymentMethod: "CASH", paymentSource: "CASH", reconciliationStatus: "OFFLINE", manual: true }),
    },
    select: { id: true },
  });
  return tx.id;
}
