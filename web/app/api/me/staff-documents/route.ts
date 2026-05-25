import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/me/staff-documents
// Staff-facing list — returns ONLY the documents the owner explicitly shared
// with this staff member (sharedWithStaff=true). Anything owner-only is
// invisible here.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "STAFF" && session.user.role !== "OWNER") {
    return NextResponse.json([]);
  }

  const docs = await prisma.staffDocument.findMany({
    where: {
      clubId: session.user.clubId,
      userId: session.user.id,
      sharedWithStaff: true,
      deletedAt: null,
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      kind: true,
      fileUrl: true,
      fileName: true,
      mimeType: true,
      sizeBytes: true,
      notes: true,
      createdAt: true,
    },
  });
  return NextResponse.json(docs);
}
