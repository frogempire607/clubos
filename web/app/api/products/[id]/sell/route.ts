import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { resolveStaffDiscount, quotePayment } from "@/lib/staffPayments";
import { recordDiscountUse } from "@/lib/discounts";

const schema = z.object({
  memberId:    z.string().optional().nullable(),
  quantity:    z.number().int().positive().default(1),
  notes:       z.string().max(200).optional().nullable(),
  manualSale:  z.boolean().optional(), // true = record cash/manual sale without Stripe
  // Optional staff-selected discount code (itemType PRODUCT). Validated
  // server-side; an invalid code BLOCKS the sale (400).
  discountCode: z.string().optional().nullable(),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const product = await prisma.product.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null, active: true },
  });
  if (!product) return NextResponse.json({ error: "Product not found" }, { status: 404 });

  try {
    const body = schema.parse(await req.json());
    const quantity = body.quantity;
    const unitPrice = Number(product.price);
    const originalTotal = unitPrice * quantity;

    // Server-side discount on the server-derived total. quotePayment guards
    // negative totals and sub-$0.50 card charges.
    const discountCheck = await resolveStaffDiscount(session.user.clubId, body.discountCode, {
      type: "PRODUCT",
    });
    if (!discountCheck.ok) return NextResponse.json({ error: discountCheck.error }, { status: 400 });
    const discount = discountCheck.discount;
    const quoted = quotePayment({
      originalPrice: originalTotal,
      discount,
      method: body.manualSale ? "CASH" : "NEW_CARD",
      passProcessingFees: false, // this route has never passed processing fees
    });
    if (!quoted.ok) return NextResponse.json({ error: quoted.error }, { status: 400 });
    const quote = quoted.quote;
    const totalAmount = quote.finalPrice;

    // Check inventory
    if (product.trackInventory && product.inventory !== null) {
      if (product.inventory < quantity) {
        return NextResponse.json(
          { error: `Only ${product.inventory} units in stock.` },
          { status: 400 }
        );
      }
    }

    // Manual / cash sale — record directly without Stripe
    if (body.manualSale) {
      const sale = await prisma.productSale.create({
        data: {
          clubId:      session.user.clubId,
          productId:   params.id,
          memberId:    body.memberId || null,
          soldById:    session.user.id,
          quantity,
          unitPrice,
          totalAmount,
          discountCode:   discount?.code ?? null,
          discountAmount: discount ? quote.discountAmount : null,
          notes:       body.notes || null,
          status:      "COMPLETED",
        },
      });

      if (product.trackInventory && product.inventory !== null) {
        await prisma.product.update({
          where: { id: params.id },
          data: { inventory: { decrement: quantity } },
        });
      }
      if (discount) await recordDiscountUse(discount.id);

      return NextResponse.json({ sale, type: "manual" }, { status: 201 });
    }

    // Stripe Checkout sale
    const club = await prisma.club.findUnique({
      where: { id: session.user.clubId },
      select: { stripeAccountId: true, stripeChargesEnabled: true },
    });

    if (!club?.stripeAccountId || !club.stripeChargesEnabled) {
      return NextResponse.json(
        { error: "Stripe is not connected. Use manual sale instead." },
        { status: 400 }
      );
    }
    if (totalAmount <= 0) {
      return NextResponse.json(
        { error: "The discount brings the total to $0 — record it as a manual sale instead of a card charge." },
        { status: 400 }
      );
    }

    // Create pending sale record first
    const sale = await prisma.productSale.create({
      data: {
        clubId:    session.user.clubId,
        productId: params.id,
        memberId:  body.memberId || null,
        soldById:  session.user.id,
        quantity,
        unitPrice,
        totalAmount,
        discountCode:   discount?.code ?? null,
        discountAmount: discount ? quote.discountAmount : null,
        notes:     body.notes || null,
        status:    "PENDING",
      },
    });

    // With a discount the whole discounted total goes on ONE line item
    // (quantity folded into the name) — a per-unit split of the discounted
    // total can drift by a cent when quantity doesn't divide it evenly.
    const lineItem = discount
      ? {
          price_data: {
            currency: "usd" as const,
            product_data: {
              name: `${product.name} (${discount.code})${quantity > 1 ? ` × ${quantity}` : ""}`,
              description: product.description || undefined,
            },
            unit_amount: Math.round(totalAmount * 100),
          },
          quantity: 1,
        }
      : {
          price_data: {
            currency: "usd" as const,
            product_data: { name: product.name, description: product.description || undefined },
            unit_amount: Math.round(unitPrice * 100),
          },
          quantity,
        };

    const checkoutSession = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        line_items: [lineItem],
        success_url: `${process.env.NEXTAUTH_URL}/dashboard/products?sale=success`,
        cancel_url:  `${process.env.NEXTAUTH_URL}/dashboard/products`,
        metadata: {
          saleId: sale.id,
          productId: params.id,
          // Discount identity for the webhook's Transaction (pickup pending —
          // the webhook is a separate workstream and is not modified here).
          ...(discount
            ? { discountCode: discount.code, discountAmount: String(quote.discountAmount) }
            : {}),
        },
      },
      { stripeAccount: club.stripeAccountId }
    );

    await prisma.productSale.update({
      where: { id: sale.id },
      data: { stripeCheckoutSessionId: checkoutSession.id },
    });
    if (discount) await recordDiscountUse(discount.id);

    return NextResponse.json({ url: checkoutSession.url, saleId: sale.id });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
