import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isBookable } from "@/lib/productSettings";
import { availabilityFor } from "@/lib/productBookingServer";

// GET /api/member/products/[id]/availability?date=YYYY-MM-DD&length=<key>
// The day's slots for a Bookable product (B10 2f step 2). No names, no money.
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const date = url.searchParams.get("date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "date=YYYY-MM-DD" }, { status: 400 });
  const product = await prisma.product.findFirst({
    where: {
      id, clubId: session.user.clubId, deletedAt: null, active: true,
      visibility: { in: ["MEMBERS_ONLY", "MEMBERS_AND_PUBLIC"] },
      showLocation: { in: ["MEMBER_PORTAL", "PUBLIC_CHECKOUT"] },
    },
  });
  if (!product || !isBookable(product.productType)) return NextResponse.json({ error: "Not bookable" }, { status: 404 });
  const res = await availabilityFor(product, date, url.searchParams.get("length") ?? "");
  return NextResponse.json(res);
}
