import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { hasReportScope } from "@/lib/reportsPermissions";

// PATCH /api/reports/imports/[id]/mapping
// Body: { columnMap: { csvHeader: fieldKey|null }, dateFormat?: "MDY"|"DMY"|"YMD" }

const schema = z.object({
  columnMap: z.record(z.string(), z.string().nullable()),
  dateFormat: z.enum(["MDY", "DMY", "YMD"]).optional(),
});

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "reports", "view");
  if (denied) return denied;
  if (!hasReportScope(session, "imports")) {
    return NextResponse.json({ error: "You don't have permission to run imports." }, { status: 403 });
  }

  const batch = await prisma.importBatch.findFirst({
    where: { id, clubId: session.user.clubId },
  });
  if (!batch) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const merged = {
    ...(typeof batch.columnMap === "object" && batch.columnMap != null ? (batch.columnMap as Record<string, unknown>) : {}),
    ...parsed.data.columnMap,
    __dateFormat: parsed.data.dateFormat ?? (batch.columnMap as { __dateFormat?: string } | null)?.__dateFormat ?? "MDY",
  };
  await prisma.importBatch.update({
    where: { id },
    data: { columnMap: merged as unknown as import("@prisma/client").Prisma.InputJsonValue },
  });

  const unmapped = Object.entries(parsed.data.columnMap).filter(([_, v]) => v == null).map(([k]) => k);
  return NextResponse.json({ valid: true, unmappedColumns: unmapped });
}
