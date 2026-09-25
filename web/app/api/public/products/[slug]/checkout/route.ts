import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { prisma } from "@/lib/prisma";
import { stripe, calculatePlatformFee } from "@/lib/stripe";
import { processingFeeLineItem } from "@/lib/fees";
import { baseUrlFromRequest } from "@/lib/baseUrl";
import { rateLimit, rateLimitedResponse, ipFromRequest } from "@/lib/ratelimit";
import { checkStock, findVariant, isBookable, normalizeProductSettings, stockMessage, unitPriceFor } from "@/lib/productSettings";
import { onPublicLink } from "@/lib/productPublic";
import { createProductBooking } from "@/lib/productBookingServer";

const who = { name: z.string().min(1).max(120), email: z.string().email().max(200), phone: z.string().max(40).optional().nullable() };
const schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("buy"), variantId: z.string().max(200).optional().nullable(), quantity: z.number().int().min(1).max(20).default(1), ...who }),
  z.object({
    kind: z.literal("book"),
    lengthKey: z.string().min(1).max(200),
    startsAt: z.string().min(10).max(40),
    guests: z.number().int().min(1).max(500).default(1),
    addOns: z.array(z.string().max(200)).max(30).default([]),
    answers: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
    notes: z.string().max(1000).optional().nullable(),
    ...who,
  }),
]);

// POST /api/public/products/[slug]/checkout — B10 2h. NO AUTH. A guest buys
// (Stripe Checkout at the list price; the member price needs signing in) or
// books a Bookable product. Everything is re-priced here from the product.
export async function POST(req: Request, context: { params: Promise<{ slug: string }> }) {
  const rl = rateLimit({ key: `pcheckout:${ipFromRequest(req)}`, limit: 10, windowMs: 10 * 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many attempts. Try again in a few minutes.");
  const { slug } = await context.params;
  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const product = await prisma.product.findUnique({
    where: { publicSlug: slug },
    include: { club: { select: { id: true, stripeAccountId: true, stripeChargesEnabled: true, passProcessingFees: true, tier: true } } },
  });
  if (!product || !onPublicLink(product)) return NextResponse.json({ error: "This product isn't available." }, { status: 404 });
  const base = baseUrlFromRequest(req);
  const page = `${base}/p/${slug}`;

  if (body.kind === "book") {
    if (!isBookable(product.productType)) return NextResponse.json({ error: "This isn't booked into a time slot." }, { status: 400 });
    const res = await createProductBooking({
      product,
      who: { guestName: body.name, guestEmail: body.email, guestPhone: body.phone ?? null },
      request: body,
      channel: "PUBLIC",
      successUrl: `${page}?booked=1`,
      cancelUrl: `${page}?canceled=1`,
    });
    if (!res.ok) return NextResponse.json({ error: res.message }, { status: res.status });
    return NextResponse.json({ ok: true, status: res.status, url: res.url });
  }

  if (isBookable(product.productType)) return NextResponse.json({ error: "Pick a time to book this." }, { status: 400 });
  const club = product.club;
  if (!club.stripeAccountId || !club.stripeChargesEnabled) {
    return NextResponse.json({ error: "Online payment isn't set up yet — contact the club." }, { status: 409 });
  }
  const settings = normalizeProductSettings(product.settings);
  const variant = findVariant(settings, body.variantId);
  const stock = checkStock(settings, product, body.variantId, body.quantity);
  if (!stock.ok) return NextResponse.json({ error: stockMessage(stock), code: stock.reason }, { status: 400 });
  // The public link is the non-member price (a member signs in for theirs).
  const unitPrice = unitPriceFor(settings, Number(product.price), variant, "PUBLIC");
  const totalCents = Math.round(unitPrice * 100) * body.quantity;
  if (totalCents < 50) return NextResponse.json({ error: "This can't be paid online — contact the club." }, { status: 400 });
  const sale = await prisma.productSale.create({
    data: {
      clubId: club.id, productId: product.id, memberId: null, quantity: body.quantity, variantId: variant?.id ?? null,
      unitPrice, totalAmount: totalCents / 100, status: "PENDING",
      guestName: body.name.trim(), guestEmail: body.email.trim().toLowerCase(),
      notes: body.phone ? `Phone: ${body.phone}` : null,
    },
  });
  const feeItem = processingFeeLineItem(totalCents, club.passProcessingFees);
  const cs = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      customer_email: body.email,
      line_items: [
        { quantity: body.quantity, price_data: { currency: "usd", unit_amount: Math.round(unitPrice * 100), product_data: { name: variant ? `${product.name} — ${variant.label}` : product.name } } },
        ...(feeItem ? [feeItem] : []),
      ],
      success_url: `${page}?bought=1`,
      cancel_url: `${page}?canceled=1`,
      payment_intent_data: { application_fee_amount: calculatePlatformFee(totalCents, club.tier), metadata: { saleId: sale.id, productId: product.id, clubId: club.id } },
      metadata: { saleId: sale.id, productId: product.id, clubId: club.id },
    },
    { stripeAccount: club.stripeAccountId },
  );
  await prisma.productSale.update({ where: { id: sale.id }, data: { stripeCheckoutSessionId: cs.id } });
  return NextResponse.json({ ok: true, url: cs.url });
}
