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

const TIER_ORDER = ["starter", "growth", "pro", "enterprise"];

const schema = z.object({
  tier: z.enum(["starter", "growth", "pro", "enterprise"]).optional(),
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

    const club = await prisma.club.update({
      where: { id: session.user.clubId },
      data: { tier: newTier },
      select: { id: true, tier: true },
    });

    return NextResponse.json(club);
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors }, { status: 400 });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
