import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive } from "@/lib/apiGuard";
import { adjustStock } from "@/lib/productInventory";
import { derivedInventory, normalizeProductSettings } from "@/lib/productSettings";

const schema = z.object({
  variantId: z.string().max(200).optional().nullable(),
  // One of: a change (the −/+ stepper, Receive stock) or an exact count.
  delta: z.number().int().min(-10000).max(10000).optional(),
  set: z.number().int().min(0).max(100000).optional(),
});

// PATCH /api/products/[id]/stock — B10 2c. Writes the SAME number the member
// store, the Sell tiles and the editor read (the variant ledger, or the plain
// count), in a transaction so two staff adjusting at once both land.
export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "edit");
  if (denied) return denied;
  const body = schema.safeParse(await req.json().catch(() => ({})));
  if (!body.success || (body.data.delta === undefined && body.data.set === undefined)) {
    return NextResponse.json({ error: "Send delta or set." }, { status: 400 });
  }
  const result = await prisma.$transaction(async (tx) => {
    const p = await tx.product.findFirst({ where: { id, clubId: session.user.clubId, deletedAt: null }, select: { id: true, settings: true, inventory: true, trackInventory: true } });
    if (!p) return { error: "Not found", status: 404 } as const;
    const settings = normalizeProductSettings(p.settings);
    const r = adjustStock(settings, { inventory: p.inventory, trackInventory: p.trackInventory }, { variantId: body.data.variantId ?? null, delta: body.data.delta, set: body.data.set });
    if (!r.ok) return { error: r.message, status: 400 } as const;
    await tx.product.update({
      where: { id: p.id },
      data: r.settings ? { settings: r.settings as object, inventory: derivedInventory(r.settings, p.inventory), trackInventory: true } : { inventory: r.inventory, trackInventory: true },
    });
    return { ok: true, stock: r.stock } as const;
  });
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result);
}
