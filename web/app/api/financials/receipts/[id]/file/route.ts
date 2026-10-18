import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive } from "@/lib/apiGuard";
import { getObject } from "@/lib/storage";
import { requireTierFeature } from "@/lib/tierGuard";

export const dynamic = "force-dynamic";

// GET /api/financials/receipts/[id]/file — the receipt itself (finances:view).
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "view");
  if (denied) return denied;
  // Tier gate (pricing overhaul 2026-10-18) — enforced server-side.
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;
  const rc = await prisma.receipt.findFirst({ where: { id, clubId: session.user.clubId }, select: { fileId: true } });
  if (!rc) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const file = await prisma.uploadedFile.findFirst({ where: { id: rc.fileId, clubId: session.user.clubId }, select: { storageKey: true, mimeType: true, originalName: true } });
  if (!file) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const bytes = await getObject(file.storageKey);
  if (!bytes) return NextResponse.json({ error: "File missing in storage" }, { status: 410 });
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": file.mimeType,
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, max-age=600",
      "Content-Disposition": `inline; filename="${file.originalName.replace(/"/g, "")}"`,
    },
  });
}
