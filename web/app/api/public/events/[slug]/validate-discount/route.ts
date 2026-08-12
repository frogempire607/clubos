import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { findValidDiscountFor } from "@/lib/discounts";
import { registrationListPrice } from "@/lib/eventRepricing";
import { eventChargeBreakdown } from "@/lib/eventDiscounts";
import { rateLimit, rateLimitedResponse, ipFromRequest } from "@/lib/ratelimit";

// POST /api/public/events/[slug]/validate-discount
// NO AUTH. Live validation for the code field on the public event page, so a
// visitor sees the real total BEFORE they commit to paying.
//
// This is deliberately NOT /api/discounts/eligible — that route is staff-gated
// (billing:view) and returns the club's whole code list with reasons. A public
// caller may only ask "is THIS code good for THIS event", one code at a time,
// and learns nothing about any code they didn't already know.
//
// Nothing here is trusted by the register route: POST /register re-resolves
// the code against the same server-derived price and recomputes the money.
// This endpoint exists so the number on screen matches, not so it can be
// passed through.
const schema = z.object({ code: z.string().min(1).max(50) });

export async function POST(req: Request, context: { params: Promise<{ slug: string }> }) {
  // Same bucket shape as public registration. Without this the endpoint is a
  // code oracle: a script could enumerate a club's discounts by brute force.
  // 20 tries per 10 minutes per IP is generous for a human typo-ing a code and
  // useless for a guesser.
  const rl = rateLimit({ key: `discount:public:${ipFromRequest(req)}`, limit: 20, windowMs: 10 * 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many attempts. Try again in a few minutes.");

  const params = await context.params;
  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Enter a discount code." }, { status: 400 });
  }

  const event = await prisma.event.findUnique({
    where: { publicSlug: params.slug },
    select: {
      id: true,
      clubId: true,
      deletedAt: true,
      publicRegistration: true,
      tournamentMode: true,
      publicPricingOption: true,
      memberPrice: true,
      nonMemberPrice: true,
      dropInFee: true,
      variableCostEnabled: true,
      club: { select: { passProcessingFees: true } },
    },
  });
  if (!event || event.deletedAt) return NextResponse.json({ error: "Event not found" }, { status: 404 });
  if (!event.publicRegistration && event.tournamentMode !== "HOST") {
    return NextResponse.json({ error: "Public registration is not enabled for this event" }, { status: 403 });
  }

  // Variable-cost events are billed later at a share nobody can quote yet, so
  // there is no total to preview. The code still applies — it's validated and
  // stored at registration, and it comes off the invoice when the owner sends
  // it — but this endpoint won't invent a number.
  // Same resolver as the register route below it, so a code previewed here
  // against a member-priced event quotes the same number it will apply to.
  const gross = registrationListPrice(event);
  if (event.variableCostEnabled || gross <= 0) {
    const check = await findValidDiscountFor(event.clubId, body.code, { type: "EVENT", eventId: event.id });
    if (!check.ok) return NextResponse.json({ valid: false, error: check.error }, { status: 200 });
    return NextResponse.json({
      valid: true,
      code: check.discount.code,
      label: check.discount.description || check.discount.code,
      quotable: false,
      message: "Code accepted. It'll come off the invoice the club sends you.",
    });
  }

  const check = await findValidDiscountFor(event.clubId, body.code, { type: "EVENT", eventId: event.id });
  // 200 with valid:false — a wrong code is a normal outcome of typing, not an
  // error condition the page should render as a failure state.
  if (!check.ok) return NextResponse.json({ valid: false, error: check.error }, { status: 200 });

  const b = eventChargeBreakdown({
    gross,
    discount: check.discount,
    passProcessingFees: event.club.passProcessingFees,
  });

  return NextResponse.json({
    valid: true,
    quotable: true,
    code: b.code,
    label: b.label,
    gross: b.gross,
    discountOff: b.discountOff,
    net: b.net,
    processingFee: b.processingFee,
    total: b.total,
  });
}
