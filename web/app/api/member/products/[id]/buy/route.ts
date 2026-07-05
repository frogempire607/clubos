import { NextResponse } from "next/server";
import { guardianActionBlocked, CONSENT_BLOCK_BODY } from "@/lib/parentalConsent";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe, calculatePlatformFee } from "@/lib/stripe";
import { processingFeeLineItem } from "@/lib/fees";
import { getAppBaseUrl } from "@/lib/baseUrl";
import { applyParentalControls } from "@/lib/parentalControls";
import { resolveFamilyContext } from "@/lib/memberContext";
import { findValidDiscountFor, discountedPrice, recordDiscountUse, type ValidDiscount } from "@/lib/discounts";

const schema = z.object({
  quantity: z.number().int().positive().max(20).default(1),
  // Which profile this purchase is for (self or a child the viewer guardians).
  memberId: z.string().optional(),
  discountCode: z.string().max(50).optional().nullable(),
});

// POST /api/member/products/[id]/buy
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { quantity, memberId, discountCode } = schema.parse(await req.json().catch(() => ({})));

    const product = await prisma.product.findFirst({
      where: {
        id: params.id,
        clubId: session.user.clubId,
        deletedAt: null,
        active: true,
        visibility: { in: ["MEMBERS_ONLY", "MEMBERS_AND_PUBLIC"] },
        showLocation: { in: ["MEMBER_PORTAL", "PUBLIC_CHECKOUT"] },
      },
    });
    if (!product) return NextResponse.json({ error: "Product not available" }, { status: 404 });
    if (product.productType !== "GEAR" && product.productType !== "OTHER" && product.productType !== "DIGITAL") {
      return NextResponse.json(
        { error: "This product type needs a booking/request flow and cannot be purchased here yet." },
        { status: 400 },
      );
    }

    if (product.trackInventory && product.inventory !== null && product.inventory < quantity) {
      return NextResponse.json(
        { error: product.inventory <= 0 ? "Out of stock." : `Only ${product.inventory} left in stock.` },
        { status: 400 },
      );
    }

    // Family-aware: resolve which profile this purchase is for (self or a child
    // the viewer guardians).
    const sessionUser = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { email: true },
    });
    const resolved = sessionUser
      ? await resolveFamilyContext(session.user.id, session.user.clubId, sessionUser.email, memberId)
      : null;
    if (resolved === "FORBIDDEN") {
      return NextResponse.json({ error: "You can't manage that profile." }, { status: 403 });
    }
    const member = resolved?.context ?? null;
    if (!member) {
      return NextResponse.json(
        { error: "Your account isn't linked to a member profile yet. Contact your club." },
        { status: 400 },
      );
    }

    // COPPA: block a guardian from buying for a minor until consent is on file.
    if (await guardianActionBlocked(session.user.id, member.id)) {
      return NextResponse.json(CONSENT_BLOCK_BODY, { status: 403 });
    }

    const club = await prisma.club.findUnique({ where: { id: session.user.clubId } });
    if (!club || !club.stripeAccountId || !club.stripeChargesEnabled) {
      return NextResponse.json({ error: "Your club hasn't enabled online payments yet." }, { status: 400 });
    }

    // Optional discount code (PRODUCT scope) — applied per unit so the
    // Stripe line item stays quantity-aware.
    let discount: ValidDiscount | null = null;
    if (discountCode?.trim()) {
      const check = await findValidDiscountFor(session.user.clubId, discountCode, { type: "PRODUCT" });
      if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
      discount = check.discount;
    }
    const unitPrice = discount
      ? discountedPrice(Number(product.price), discount)
      : Number(product.price);
    const totalAmount = unitPrice * quantity;
    const totalCents = Math.round(totalAmount * 100);
    const platformFee = calculatePlatformFee(totalCents, club.tier);
    if (totalCents <= 0) {
      return NextResponse.json(
        { error: "That code makes this free — ask your club to record the sale for you." },
        { status: 400 },
      );
    }

    // P4 parental gate. Before the PENDING ProductSale row is created
    // so a queued/declined buy doesn't leave a stale sale to clean up.
    const gate = await applyParentalControls({
      member: {
        id: member.id,
        clubId: club.id,
        userId: member.userId,
        isMinor: member.isMinor,
        parentControls: member.parentControls,
      },
      bookerUserId: session.user.id,
      bookerIsGuardian: resolved?.bookerIsGuardian ?? false,
      kind: "PRODUCT_BUY",
      amount: totalAmount,
      payload: { productId: product.id, quantity, memberId: member.id },
    });
    if (gate.kind === "block") {
      return NextResponse.json(gate.body, { status: gate.status });
    }
    if (gate.kind === "queue") {
      return NextResponse.json(gate.response, { status: 202 });
    }

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

    const baseUrl = getAppBaseUrl();
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
        metadata: {
          saleId: sale.id,
          productId: product.id,
          memberId: member.id,
          clubId: club.id,
          ...(discount ? { discountCode: discount.code } : {}),
        },
      },
      { stripeAccount: club.stripeAccountId },
    );

    await prisma.productSale.update({
      where: { id: sale.id },
      data: { stripeCheckoutSessionId: checkoutSession.id },
    });

    if (discount) await recordDiscountUse(discount.id);
    return NextResponse.json({ url: checkoutSession.url });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
