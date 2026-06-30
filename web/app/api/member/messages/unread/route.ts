import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/member/messages/unread → { count }
// Unread direct messages addressed to the signed-in member, for the bottom-nav
// badge in the member portal.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ count: 0 });
  const count = await prisma.message.count({
    where: { clubId: session.user.clubId, recipientId: session.user.id, readAt: null },
  });
  return NextResponse.json({ count });
}
