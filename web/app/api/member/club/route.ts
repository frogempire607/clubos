import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/member/club — public-facing club info for the member portal.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const club = await prisma.club.findUnique({
    where: { id: session.user.clubId },
    select: {
      id: true,
      name: true,
      slug: true,
      sport: true,
      tagline: true,
      logoUrl: true,
      aboutUs: true,
      primaryColor: true,
      coverImageUrl: true,
      contactEmail: true,
      contactPhone: true,
      websiteUrl: true,
      socialLinks: true,
      hoursOfOperation: true,
      appFontFamily: true,
      appTextAlign: true,
      appHomeContent: true,
    },
  });

  if (!club) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(club);
}
