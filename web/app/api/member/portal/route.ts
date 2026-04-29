import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "MEMBER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
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
            include: {
              event: {
                include: { customEventType: true },
              },
            },
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

  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const club = await prisma.club.findUnique({
    where: { id: session.user.clubId },
    select: { id: true, name: true, slug: true, sport: true, primaryColor: true, logoUrl: true, tier: true },
  });

  return NextResponse.json({ user, club });
}
