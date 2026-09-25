import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { ALL_PRODUCT_TYPES } from "@/lib/productSettings";
import { mintProductSlug } from "@/lib/productPublic";

const schema = z.object({
  name:          z.string().min(1).max(100).optional(),
  description:   z.string().max(500).optional().nullable(),
  price:         z.number().nonnegative().optional(),
  category:      z.enum(["GEAR", "APPAREL", "FACILITY", "SERVICE", "OTHER"]).optional(),
  productType:   z.enum(ALL_PRODUCT_TYPES).optional(),
  imageUrl:      z.string().max(500).optional().nullable(),
  active:        z.boolean().optional(),
  visibility:    z.enum(["MEMBERS_ONLY", "PUBLIC_ONLY", "MEMBERS_AND_PUBLIC", "INTERNAL_ONLY"]).optional(),
  showLocation:  z.enum(["MEMBER_PORTAL", "PUBLIC_CHECKOUT", "INTERNAL_ONLY"]).optional(),
  taxable:       z.boolean().optional(),
  internalNotes: z.string().max(1000).optional().nullable(),
  settings:      z.record(z.any()).optional(),
  trackInventory: z.boolean().optional(),
  inventory:     z.number().int().nonnegative().optional().nullable(),
  // B10 slice 3 — /p/{slug}; minted from the name when the public link is on and none is set.
  publicSlug:    z.string().max(80).optional().nullable(),
});

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const existing = await prisma.product.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const body = schema.parse(await req.json());
    const { publicSlug, ...rest } = body;
    const showLocation = rest.showLocation ?? existing.showLocation;
    const wantsPublic = showLocation === "PUBLIC_CHECKOUT" || (rest.visibility ?? existing.visibility) === "PUBLIC_ONLY";
    const nextSlug =
      publicSlug !== undefined && publicSlug !== null && publicSlug !== existing.publicSlug
        ? await mintProductSlug(publicSlug, rest.name ?? existing.name, existing.id)
        : wantsPublic && !existing.publicSlug
          ? await mintProductSlug(null, rest.name ?? existing.name, existing.id)
          : undefined;
    const updated = await prisma.product.update({ where: { id: params.id }, data: { ...rest, ...(nextSlug ? { publicSlug: nextSlug } : {}) } });
    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Staff with full Events/purchase-options access can delete — not owner-only.
  const denied = requirePermission(session, "events", "full");
  if (denied) return denied;

  const existing = await prisma.product.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.product.update({ where: { id: params.id }, data: { deletedAt: new Date() } });
  return new NextResponse(null, { status: 204 });
}
