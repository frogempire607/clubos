import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/documents/[id]/signatures
// Owner/staff audit view: list every signature on this document.
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const document = await prisma.document.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
    select: {
      id: true,
      title: true,
      requiresGuardianSignature: true,
      required: true,
      signatureValidForDays: true,
    },
  });
  if (!document) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const signatures = await prisma.documentSignature.findMany({
    where: { documentId: document.id },
    orderBy: { signedAt: "desc" },
    include: {
      member: { select: { id: true, firstName: true, lastName: true, isMinor: true, email: true } },
    },
  });

  return NextResponse.json({ document, signatures });
}
