import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Tier } from "@/lib/tier";

// SECURITY (2026-10-18): promo codes used to be hard-coded in this file —
// including one that gave ANY club owner Enterprise for free. Since the tier
// now sets the per-transaction platform rate, a leaked code costs real money
// on every charge. Codes now come ONLY from the PROMO_CODES_JSON env var,
// e.g. {"SOMECODE":"pro"}. Unset (the default) = promo codes are disabled.
function promoCodes(): Record<string, Tier> {
  try {
    const raw = JSON.parse(process.env.PROMO_CODES_JSON || "{}") as Record<string, string>;
    const out: Record<string, Tier> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v === "starter" || v === "pro" || v === "enterprise") out[k.trim().toUpperCase()] = v;
    }
    return out;
  } catch {
    return {};
  }
}

const schema = z.object({
  tier: z.enum(["starter", "pro", "enterprise"]).optional(),
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
      newTier = promoCodes()[code] || null;
      if (!newTier) {
        return NextResponse.json({ error: "Invalid promo code" }, { status: 400 });
      }
    } else if (body.tier) {
      newTier = body.tier;
    }

    if (!newTier) {
      return NextResponse.json({ error: "Provide a tier or promo code" }, { status: 400 });
    }

    // Paid plans change only through Stripe Checkout
    // (/api/club/subscription/checkout) so the club is billed; a direct tier
    // set is permitted only via a configured promo/partner code.
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
