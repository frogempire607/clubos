import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe, calculatePlatformFee } from "@/lib/stripe";
import { processingFeeLineItem } from "@/lib/fees";

const schema = z.object({
  quantity: z.number().int().positive().max(20).default(1),
});

// POST /api/member/products/[id]/buy
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { quantity } = schema.parse(await req.json().catch(() => ({})));

    const product = await prisma.product.findFirst({
      where: { id: params.id, clubId: session.user.clubId, deletedAt: null, active: true },
    });
    if (!product) return NextResponse.json({ error: "Product not available" }, { status: 404 });

    if (product.trackInventory && product.inventory !== null && product.inventory < quantity) {
      return NextResponse.json(
        { error: product.inventory <= 0 ? "Out of stock." : `Only ${product.inventory} left in stock.` },
        { status: 400 },
      );
    }

    const member = await prisma.member.findFirst({
      where: { userId: session.user.id, clubId: session.user.clubId, deletedAt: null },
    });
    if (!member) {
      return NextResponse.json(
        { error: "Your account isn't linked to a member profile yet. Contact your club." },
        { status: 400 },
      );
    }

    const club = await prisma.club.findUnique({ where: { id: session.user.clubId } });
    if (!club || !club.stripeAccountId || !club.stripeChargesEnabled) {
      return NextResponse.json({ error: "Your club hasn't enabled online payments yet." }, { status: 400 });
    }

    const unitPrice = Number(product.price);
    const totalAmount = unitPrice * quantity;
    const totalCents = Math.round(totalAmount * 100);
    const platformFee = calculatePlatformFee(totalCents, club.tier);

    const sale = await prisma.productSale.create({
      data: {
        clubId:    club.id,
        productId: product.id,
        memberId:  member.id,
        soldById:  session.user.id,
        quantity,
        unitPrice,
        totalAmount,
        status: "PENDING",
      },
    });

    const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
    const feeItem = processingFeeLineItem(totalCents, club.passProcessingFees);

    const checkoutSession = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        line_items: [
          {
            quantity,
            price_data: {
              currency: "usd",
              unit_amount: Math.round(unitPrice * 100),
              product_data: {
                name: product.name,
                ...(product.description ? { description: product.description } : {}),
              },
            },
          },
          ...(feeItem ? [feeItem] : []),
        ],
        success_url: `${baseUrl}/member/products?bought=true`,
        cancel_url:  `${baseUrl}/member/products?canceled=true`,
        payment_intent_data: {
          application_fee_amount: platformFee,
          metadata: { saleId: sale.id, productId: product.id, memberId: member.id, clubId: club.id },
        },
        metadata: { saleId: sale.id, productId: product.id, memberId: member.id, clubId: club.id },
      },
      { stripeAccount: club.stripeAccountId },
    );

    await prisma.productSale.update({
      where: { id: sale.id },
      data: { stripeCheckoutSessionId: checkoutSession.id },
    });

    return NextResponse.json({ url: checkoutSession.url });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
