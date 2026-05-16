import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { findOrAutoLinkMember } from "@/lib/memberLink";

async function fetchUser(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    include: {
      memberProfile: {
        include: {
          membership: true,
          subscriptions: {
            where: { status: { in: ["active", "past_due"] } },
            include: { membership: true },
          },
          bookings: {
            where: { status: { in: ["CONFIRMED", "WAITLISTED"] } },
            include: { event: { include: { customEventType: true } } },
            orderBy: { event: { startsAt: "asc" } },
            take: 20,
          },
          guardianLinks: {
            include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
          },
          guardian: true,
        },
      },
      guardianOf: {
        include: {
          member: {
            include: {
              bookings: {
                where: { status: { in: ["CONFIRMED", "WAITLISTED"] } },
                include: { event: { include: { customEventType: true } } },
                orderBy: { event: { startsAt: "asc" } },
                take: 10,
              },
            },
          },
        },
      },
    },
  });
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "MEMBER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let user = await fetchUser(session.user.id);
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Auto-link by email if no userId-linked member profile found, then re-fetch
  if (!user.memberProfile) {
    const linked = await findOrAutoLinkMember(session.user.id, session.user.clubId, user.email);
    if (linked) {
      user = await fetchUser(session.user.id);
    }
  }

  const club = await prisma.club.findUnique({
    where: { id: session.user.clubId },
    select: { id: true, name: true, slug: true, sport: true, primaryColor: true, logoUrl: true, tier: true },
  });

  return NextResponse.json({ user, club });
}
