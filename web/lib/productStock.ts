// B10 slice 2 — the one write path for stock leaving a product.
//
// Two callers: the front-desk sell route (cash — units leave at once) and the
// Stripe webhook (units leave when the payment lands). Both used to
// `inventory: { decrement }` directly, which the variant ledger cannot follow.
// Now: read the product inside a transaction, sell the variant in the ledger,
// and write BOTH the ledger and the derived `inventory` total — or, for a
// product without variants, decrement the plain count as before.

import { prisma } from "@/lib/prisma";
import { applyVariantSale, derivedInventory, hasVariants, normalizeProductSettings } from "@/lib/productSettings";

export async function releaseStock(input: { productId: string; variantId: string | null; quantity: number }): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const product = await tx.product.findUnique({
      where: { id: input.productId },
      select: { id: true, settings: true, trackInventory: true, inventory: true },
    });
    if (!product) return;
    const settings = normalizeProductSettings(product.settings);
    if (hasVariants(settings)) {
      if (!input.variantId) return; // legacy PENDING sale from before variants existed — nothing to take from
      const next = applyVariantSale(settings, input.variantId, input.quantity);
      await tx.product.update({
        where: { id: product.id },
        data: { settings: next as object, inventory: derivedInventory(next, product.inventory) },
      });
      return;
    }
    if (product.trackInventory && product.inventory != null) {
      await tx.product.update({
        where: { id: product.id },
        data: { inventory: Math.max(0, product.inventory - input.quantity) },
      });
    }
  });
}
