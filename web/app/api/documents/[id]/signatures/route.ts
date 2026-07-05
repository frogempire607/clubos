import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { tenantPrismaFromSession } from "@/lib/tenantPrisma";

// GET /api/documents/[id]/signatures
// Owner/staff audit view: list every signature on this document.
//
// RLS PILOT (first production adoption of the tenant-scoped client — see
// web/rls/README.md §3). This route reads through `tenantPrismaFromSession`
// (connects as the RLS-enforced `athletix_app` role via APP_DATABASE_URL) so
// Postgres itself constrains every row to the caller's club, underneath the
// existing app-level `clubId` filters (kept intentionally so behavior is
// identical with RLS on or off, and rollback is a one-line client swap back
// to `@/lib/prisma`). Requires APP_DATABASE_URL to be set in the environment.
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = tenantPrismaFromSession(session);

  const document = await db.document.findFirst({
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

  const signatures = await db.documentSignature.findMany({
    where: { documentId: document.id },
    orderBy: { signedAt: "desc" },
    include: {
      member: { select: { id: true, firstName: true, lastName: true, isMinor: true, email: true } },
    },
  });

  return NextResponse.json({ document, signatures });
}
