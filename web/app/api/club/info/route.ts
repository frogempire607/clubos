import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

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
      primaryColor: true,
      logoUrl: true,
      tier: true,
      stripeOnboardingComplete: true,
      stripeChargesEnabled: true,
      notificationPrefs: true,
      clubProfile: true,
    },
  });

  if (!club) return NextResponse.json({ error: "Club not found" }, { status: 404 });
  return NextResponse.json(club);
}
