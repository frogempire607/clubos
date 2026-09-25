import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isBookable } from "@/lib/productSettings";
import { onPublicLink } from "@/lib/productPublic";
import { availabilityFor } from "@/lib/productBookingServer";
import { rateLimit, rateLimitedResponse, ipFromRequest } from "@/lib/ratelimit";

// GET /api/public/products/[slug]/availability?date=&length= — NO AUTH. Open
// and taken slots only; never who booked.
export async function GET(req: Request, context: { params: Promise<{ slug: string }> }) {
  const rl = rateLimit({ key: `pavail:${ipFromRequest(req)}`, limit: 120, windowMs: 10 * 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many requests.");
  const { slug } = await context.params;
  const url = new URL(req.url);
  const date = url.searchParams.get("date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "date=YYYY-MM-DD" }, { status: 400 });
  const product = await prisma.product.findUnique({ where: { publicSlug: slug } });
  if (!product || !onPublicLink(product) || !isBookable(product.productType)) return NextResponse.json({ error: "Not bookable" }, { status: 404 });
  return NextResponse.json(await availabilityFor(product, date, url.searchParams.get("length") ?? ""));
}
