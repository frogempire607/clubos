import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/member/documents
// Returns club documents visible to the current member: published, not unpublished, not expired.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const now = new Date();

  const docs = await prisma.document.findMany({
    where: {
      clubId: session.user.clubId,
      deletedAt: null,
      AND: [
        { OR: [{ publishAt: null }, { publishAt: { lte: now } }] },
        { OR: [{ unpublishAt: null }, { unpublishAt: { gt: now } }] },
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      ],
    },
    orderBy: [{ required: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      title: true,
      type: true,
      body: true,
      required: true,
      requiresGuardianSignature: true,
      deliveryTrigger: true,
      expiresAt: true,
      createdAt: true,
    },
  });

  return NextResponse.json(docs);
}
