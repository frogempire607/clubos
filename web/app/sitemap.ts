import type { MetadataRoute } from "next";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://athletix-os.com";

/**
 * Static public marketing + auth routes. Per-club /e/<slug> event pages are
 * intentionally NOT enumerated here: they're club-private deeplinks and would
 * require a DB read at sitemap-generation time. If we ever want them indexed,
 * make this `async`, query `prisma.event.findMany({ where: { publicSlug: { not: null } } })`,
 * and emit one entry per slug.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const routes = ["", "/pricing", "/login", "/signup", "/terms", "/privacy"];
  return routes.map((path) => ({
    url: `${SITE_URL}${path}`,
    lastModified: now,
    changeFrequency: path === "" || path === "/pricing" ? "weekly" : "monthly",
    priority: path === "" ? 1.0 : path === "/pricing" ? 0.9 : 0.6,
  }));
}
