import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { ALL_PRODUCT_TYPES } from "@/lib/productSettings";
import { mintProductSlug } from "@/lib/productPublic";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const products = await prisma.product.findMany({
    where: { clubId: session.user.clubId, deletedAt: null },
    include: { _count: { select: { sales: true } } },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(products);
}

const schema = z.object({
  name:          z.string().min(1).max(100),
  description:   z.string().max(500).optional().nullable(),
  price:         z.number().nonnegative(),
  category:      z.enum(["GEAR", "APPAREL", "FACILITY", "SERVICE", "OTHER"]).default("OTHER"),
  productType:   z.enum(ALL_PRODUCT_TYPES).default("GEAR"),
  imageUrl:      z.string().max(500).optional().nullable(),
  active:        z.boolean().optional(),
  visibility:    z.enum(["MEMBERS_ONLY", "PUBLIC_ONLY", "MEMBERS_AND_PUBLIC", "INTERNAL_ONLY"]).default("MEMBERS_AND_PUBLIC"),
  showLocation:  z.enum(["MEMBER_PORTAL", "PUBLIC_CHECKOUT", "INTERNAL_ONLY"]).default("MEMBER_PORTAL"),
  taxable:       z.boolean().optional().default(false),
  internalNotes: z.string().max(1000).optional().nullable(),
  settings:      z.record(z.any()).optional().default({}),
  trackInventory: z.boolean().optional(),
  inventory:     z.number().int().nonnegative().optional().nullable(),
  // B10 slice 3 — /p/{slug}; minted from the name when the public link is on and none is set.
  publicSlug:    z.string().max(80).optional().nullable(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "edit");
  if (denied) return denied;

  try {
    const body = schema.parse(await req.json());
    const { publicSlug, ...rest } = body;
    const wantsPublic = rest.showLocation === "PUBLIC_CHECKOUT" || rest.visibility === "PUBLIC_ONLY";
    const slug = wantsPublic || publicSlug ? await mintProductSlug(publicSlug, rest.name) : null;
    const product = await prisma.product.create({
      data: { clubId: session.user.clubId, ...rest, imageUrl: rest.imageUrl || null, publicSlug: slug },
    });
    return NextResponse.json(product, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
