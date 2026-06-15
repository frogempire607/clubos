import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const PROMO_CODES: Record<string, string> = {
  "FOUNDER-ENTERPRISE607": "enterprise",
  "GROWTH-FREE": "growth",
  "PRO-TRIAL": "pro",
};

const schema = z.object({
  tier: z.enum(["growth", "pro", "enterprise"]).optional(),
  promoCode: z.string().optional(),
});

export async function PATCH(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = schema.parse(await req.json());

    let newTier: string | null = null;

    if (body.promoCode) {
      const code = body.promoCode.trim().toUpperCase();
      newTier = PROMO_CODES[code] || null;
      if (!newTier) {
        return NextResponse.json({ error: "Invalid promo code" }, { status: 400 });
      }
    } else if (body.tier) {
      newTier = body.tier;
    }

    if (!newTier) {
      return NextResponse.json({ error: "Provide a tier or promo code" }, { status: 400 });
    }

    // There is no free tier. Every plan is paid, so a direct tier set is only
    // permitted via a promo/partner code — normal plan changes must go through
    // Stripe Checkout (/api/club/subscription/checkout) so the club is billed.
    if (!body.promoCode) {
      return NextResponse.json(
        { error: "Plan changes require checkout. Use the Subscribe button instead." },
        { status: 400 }
      );
    }

    const club = await prisma.club.update({
      where: { id: session.user.clubId },
      data: { tier: newTier },
      select: { id: true, tier: true },
    });

    return NextResponse.json(club);
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors }, { status: 400 });
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
