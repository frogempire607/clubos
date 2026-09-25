// B10 slice 3 — the public product page /p/{slug}: minting the slug, and the
// rule for when a product is on the public link at all.

import { prisma } from "@/lib/prisma";
import { storefrontsFor, type ShowLocation, type Visibility } from "@/lib/productSettings";

export function slugifyProduct(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

/** A free slug: the one asked for (or the name's), with -2, -3… when taken. */
export async function mintProductSlug(desired: string | null | undefined, name: string, excludeId?: string | null): Promise<string> {
  const base = slugifyProduct(desired || name) || "product";
  for (let i = 1; i < 50; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    const hit = await prisma.product.findFirst({ where: { publicSlug: candidate, ...(excludeId ? { id: { not: excludeId } } : {}) }, select: { id: true } });
    if (!hit) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export function onPublicLink(p: { active: boolean; deletedAt: Date | null; visibility: string; showLocation: string }): boolean {
  return p.active && !p.deletedAt && storefrontsFor(p.visibility as Visibility, p.showLocation as ShowLocation).includes("PUBLIC_LINK");
}
