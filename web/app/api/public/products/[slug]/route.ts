import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { storeView } from "@/lib/productStore";
import { normalizeProductSettings, unitPriceFor, findVariant } from "@/lib/productSettings";
import { onPublicLink } from "@/lib/productPublic";
import { publicClubLogoUrl } from "@/lib/clubLogo";

// GET /api/public/products/[slug] — B10 2h, the public product page. NO AUTH.
// The store projection (no SKUs, thresholds or notes) plus the club's
// branding. `?src=qr` counts a scan (the printed tags and poster use it).
export async function GET(req: Request, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const product = await prisma.product.findUnique({
    where: { publicSlug: slug },
    include: {
      club: { select: { id: true, name: true, slug: true, logoUrl: true, primaryColor: true, stripeAccountId: true, stripeChargesEnabled: true } },
    },
  });
  if (!product || !onPublicLink(product)) return NextResponse.json({ error: "This product isn't available." }, { status: 404 });
  if (new URL(req.url).searchParams.get("src") === "qr") {
    await prisma.product.update({ where: { id: product.id }, data: { scanCount: { increment: 1 } } }).catch(() => undefined);
  }
  const view = storeView(product);
  // The public link sells at the list price: each variant's own price, else the base.
  const settings = normalizeProductSettings(product.settings);
  view.variants = view.variants.map((v) => ({ ...v, price: unitPriceFor(settings, Number(product.price), findVariant(settings, v.id), "PUBLIC") }));
  return NextResponse.json({
    product: view,
    // Non-members pay the list price; the badge tells members what signing in saves.
    memberSaves: Math.max(0, Math.round((view.price - view.memberPrice) * 100) / 100),
    club: { name: product.club.name, slug: product.club.slug, logoUrl: product.club.logoUrl ? publicClubLogoUrl(product.club.id, product.club.logoUrl) : null, primaryColor: product.club.primaryColor },
    canPay: !!product.club.stripeAccountId && !!product.club.stripeChargesEnabled,
  });
}
