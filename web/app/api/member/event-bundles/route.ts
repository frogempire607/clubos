import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// Published event bundles a member can browse and register for.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const bundles = await prisma.eventBundle.findMany({
    where: { clubId: session.user.clubId, deletedAt: null, published: true },
    orderBy: { createdAt: "desc" },
    include: {
      items: {
        include: {
          event: {
            select: {
              id: true, name: true, startsAt: true, endsAt: true,
              memberPrice: true, nonMemberPrice: true,
            },
          },
        },
      },
    },
  });
  return NextResponse.json(bundles);
}
