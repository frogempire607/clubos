import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { publicClubLogoUrl } from "@/lib/clubLogo";

// GET /api/public/membership?club=<slug>&id=<membershipId>
//
// PUBLIC (no auth) club branding + optionally one membership plan, powering the
// public registration link /join/[slug]?m=<id>. Only ACTIVE, non-deleted,
// ANYONE-purchasable memberships are exposed (STAFF_ONLY plans never leak).
// Read-only: the link funnels into the existing signup/onboarding — it never
// charges or mutates anything.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const slug = (url.searchParams.get("club") || "").trim().toLowerCase();
  const id = url.searchParams.get("id");
  if (!slug) return NextResponse.json({ error: "Missing club" }, { status: 400 });

  const club = await prisma.club.findUnique({
    where: { slug },
    select: { id: true, name: true, slug: true, logoUrl: true, primaryColor: true, tagline: true },
  });
  if (!club) return NextResponse.json({ error: "Club not found" }, { status: 404 });

  let membership:
    | { id: string; name: string; description: string | null; options: unknown }
    | null = null;
  if (id) {
    const m = await prisma.membership.findFirst({
      where: { id, clubId: club.id, deletedAt: null, active: true, purchaseAccess: "ANYONE" },
      select: { id: true, name: true, description: true, options: true },
    });
    if (m) membership = m;
  }

  return NextResponse.json({
    club: {
      name: club.name,
      slug: club.slug,
      logoUrl: publicClubLogoUrl(club.id, club.logoUrl),
      primaryColor: club.primaryColor,
      tagline: club.tagline,
    },
    membership,
  });
}
