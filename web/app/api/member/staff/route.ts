import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/member/staff
// Returns staff (and owners) who have opted into showing on the member portal.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const users = await prisma.user.findMany({
    where: {
      clubId: session.user.clubId,
      deletedAt: null,
      role: { in: ["OWNER", "STAFF"] },
      staffProfile: { showOnPortal: true },
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      role: true,
      staffProfile: {
        select: {
          title: true,
          bio: true,
          publicEmail: true,
          publicPhone: true,
          photoUrl: true,
        },
      },
    },
    orderBy: { firstName: "asc" },
  });

  return NextResponse.json(users);
}
