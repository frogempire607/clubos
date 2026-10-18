import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { hasReportScope } from "@/lib/reportsPermissions";
import { requireTierFeature } from "@/lib/tierGuard";

// GET /api/reports/imports/[id] — status + counts (for polling during commit).
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "reports", "view");
  if (denied) return denied;
  if (!hasReportScope(session, "imports")) {
    return NextResponse.json({ error: "You don't have permission to view imports." }, { status: 403 });
  }
  // Tier gate (pricing overhaul 2026-10-18) — enforced server-side.
  const tierGate = await requireTierFeature(session.user.clubId, "fullReports");
  if (tierGate) return tierGate;

  const batch = await prisma.importBatch.findFirst({
    where: { id, clubId: session.user.clubId },
  });
  if (!batch) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ batch });
}
